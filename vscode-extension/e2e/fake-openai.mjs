// A stand-in for an OpenAI-compatible chat server, for the end-to-end test.
//
//   const server = await startFakeOpenAI();
//   server.script([{ tool: "run_command", args: { command: "ls" } }, { text: "Done." }]);
//
// Each request to /v1/chat/completions takes the next step of the script and answers it as a server-sent
// event stream, in the shape the AI SDK reads. A step is one of:
//   { text }                      the model says something (streamed in a few pieces)
//   { tool, args, id? }           the model calls a tool (ends the step with finish_reason "tool_calls")
//   { text, tool, args }          both, in that order
//   { hang: true }                the server accepts the request and never answers (until the client leaves)
// Any step may also have { delay: milliseconds }: the server waits that long before answering.
// `requests` records every request body, so a test can check what the model was shown.
import { createServer } from "node:http";

export async function startFakeOpenAI() {
  const requests = [];
  const headers = [];
  let steps = [];
  let next = 0;
  let aborted = 0;
  let calls = 0;

  const chunk = (delta, finish = null) =>
    `data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

  const server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        // A body that is not JSON is recorded as empty.
      }
      requests.push(parsed);
      headers.push(req.headers);
      const step = steps[Math.min(next++, steps.length - 1)] ?? { text: "(no script)" };
      res.on("close", () => {
        if (!res.writableEnded) aborted++;
      });
      if (step.hang) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(chunk({ role: "assistant", content: "" }));
        return;
      }
      setTimeout(() => answer(res, step), step.delay ?? 0);
    });
  });

  const answer = (res, step) => {
    if (res.destroyed) return;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(chunk({ role: "assistant", content: "" }));
    if (step.text) {
      const words = step.text.match(/\S+\s*/g) ?? [step.text];
      for (const piece of words) res.write(chunk({ content: piece }));
    }
    if (step.tool) {
      const id = step.id ?? `call_${++calls}`;
      const args = JSON.stringify(step.args ?? {});
      res.write(chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name: step.tool, arguments: "" } }] }));
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }));
    }
    res.write(chunk({}, step.tool ? "tool_calls" : "stop"));
    res.write(`data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [], usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  };

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    /** The headers of every request, in the same order as `requests`. */
    headers,
    /** Replaces the script and starts it from the first step. */
    script(list) {
      steps = list;
      next = 0;
    },
    get used() {
      return next;
    },
    /** How many requests the client abandoned before they were answered. */
    get aborted() {
      return aborted;
    },
    /** The text the model was last shown as tool results, joined. */
    lastToolOutputs() {
      const last = requests[requests.length - 1];
      return (last?.messages ?? [])
        .filter((m) => m.role === "tool")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n");
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
