// End-to-end test of the AI chat in a real VS Code (code-server), against a scripted fake model server.
//
//   TERAX_E2E_WORKSPACE=/path/to/empty/folder TERAX_E2E_SETTINGS=/path/to/user-data/User/settings.json \
//     node e2e/chat.mjs [screenshot-dir]
//
// Environment (as for run.mjs, plus):
//   TERAX_E2E_SETTINGS   the user settings file of the code-server (it is overwritten, before the page loads)
//
// No real AI provider is involved: e2e/fake-openai.mjs plays the model. Every check is about what the person
// sees and what the machine does: the popup, the files, the commands, and what the model is told.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { startFakeOpenAI } from "./fake-openai.mjs";

const require = createRequire(`${process.env.PLAYWRIGHT_NODE_MODULES ?? process.cwd()}/`);
const { chromium } = require("playwright");

const URL = process.env.TERAX_E2E_URL ?? "http://127.0.0.1:8090";
const WORKSPACE = process.env.TERAX_E2E_WORKSPACE;
const SETTINGS = process.env.TERAX_E2E_SETTINGS;
const SHOTS = process.argv[2];
if (!WORKSPACE || !SETTINGS) throw new Error("Set TERAX_E2E_WORKSPACE and TERAX_E2E_SETTINGS.");
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const TMP = "/tmp/terax-e2e-chat";
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
rmSync(join(WORKSPACE, "made.txt"), { force: true });
writeFileSync(join(WORKSPACE, "notes.md"), "# Notes\nold line\n");
writeFileSync(join(WORKSPACE, "script.sh"), "echo hi\n");
writeFileSync(join(WORKSPACE, ".env"), "API_SECRET=hunter2-e2e-secret\n");

const server = await startFakeOpenAI();
// The chat's model, address and provider are machine-scoped settings. Choosing a model through the palette stores
// it in the server's Machine/settings.json, which would win over the file written below on the next run.
rmSync(join(dirname(dirname(SETTINGS)), "Machine", "settings.json"), { force: true });
writeFileSync(SETTINGS, JSON.stringify({ "terax.ai.provider": "openai-compatible", "terax.ai.model": "fake-model", "terax.ai.baseUrl": server.url }));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
}
const exists = (name) => existsSync(`${TMP}/${name}`);
const read = (name) => (exists(name) ? readFileSync(`${TMP}/${name}`, "utf8").trim() : null);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: URL });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
const shot = async (name) => SHOTS && page.screenshot({ path: join(SHOTS, `${name}.png`) });
const wait = (ms) => page.waitForTimeout(ms);

async function until(condition, what, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await condition().catch(() => false)) return true;
    await wait(150);
  }
  console.log(`  (timed out waiting for ${what})`);
  return false;
}
async function palette(text) {
  await page.keyboard.press("F1");
  await page.waitForSelector(".quick-input-widget", { state: "visible", timeout: 10_000 });
  await page.keyboard.type(text);
  await wait(700);
  await page.keyboard.press("Enter");
}
async function teraxFrame() {
  for (const f of page.frames()) if ((await f.locator("#stage").count().catch(() => 0)) > 0) return f;
  return null;
}

await page.goto(`${URL}/?folder=${encodeURIComponent(WORKSPACE)}`, { waitUntil: "load" });
await page.waitForSelector(".monaco-workbench", { timeout: 60_000 });
await wait(3500);
await palette("Terax: Focus Terminal");
await wait(5000);
let frame = await teraxFrame();
if (!frame) {
  check("the Terax panel opens", false);
  await browser.close();
  await server.close();
  process.exit(1);
}
await palette("View: Toggle Maximized Panel");
await wait(1500);
frame = await teraxFrame();

const idle = () => frame.locator(".composer-send").innerText().then((t) => t.trim() === "Send");
const popup = () => frame.locator(".approval").isVisible();
const cards = () => frame.locator(".tool").allInnerTexts();
async function say(text, steps) {
  if (steps) server.script(steps);
  await frame.locator(".composer-input").click();
  await page.keyboard.type(text, { delay: 4 });
  await page.keyboard.press("Enter");
}
const settle = async () => {
  await until(idle, "the turn to end", 20_000);
  await wait(250);
};

// --- The layout ------------------------------------------------------------------------------
check("the terminal is on top, the chat below it, with a splitter between", await (async () => {
  const t = await frame.locator("#terminal-pane").boundingBox();
  const s = await frame.locator("#splitter").boundingBox();
  const c = await frame.locator("#chat").boundingBox();
  return t && s && c && t.y + t.height <= s.y + 1 && s.y + s.height <= c.y + 1;
})());
const chip = await frame.locator(".chat-model").innerText();
check("the header names the chosen model", chip.includes("fake-model"), chip);
check("an empty chat explains itself and offers a few starting points", (await frame.locator(".empty").isVisible()) && (await frame.locator(".suggestion").count()) === 3);
await shot("c01-empty");

// --- A turn that only reads ------------------------------------------------------------------
await say("what files are here?", [
  { tool: "list_directory", args: {} },
  { text: "I found **script.sh** and `notes.md`.\n\nTry:\n\n```sh\necho inserted-ok > " + TMP + "/inserted\n```\n" },
]);
await settle();
check("a reading tool runs without asking, and the answer is shown", !(await popup()) && (await cards()).some((c) => c.includes("List folder")) && (await frame.locator(".msg.assistant").last().innerText()).includes("I found"));
check("the answer's formatting is drawn (bold, inline code, code block with buttons)", (await frame.locator(".md strong").count()) >= 1 && (await frame.locator(".md-code").count()) >= 1 && (await frame.locator(".code-block .code-btn").count()) === 2);
check("the usage of the turn is shown", (await frame.locator(".usage").last().innerText()).includes("in"));
const first = server.requests[0];
const toolNames = (first.tools ?? []).map((t) => t.function?.name).sort();
check("the model is given the eight tools and told about the workspace", toolNames.join(",") === "edit_file,glob,grep,list_directory,read_file,read_terminal,run_command,write_file" && JSON.stringify(first.messages[0]).includes(WORKSPACE), toolNames.join(","));
await shot("c02-read-turn");

// --- Insert in terminal (not run) ------------------------------------------------------------
await frame.locator(".code-btn", { hasText: "Insert in terminal" }).first().click();
await wait(800);
check("'Insert in terminal' puts the command at the prompt without running it", !exists("inserted"));
await page.keyboard.press("Enter");
await wait(900);
check("it runs only when the person presses Enter in the terminal", read("inserted") === "inserted-ok", String(read("inserted")));

// --- Approving a command ---------------------------------------------------------------------
const command = `echo approved-run > ${TMP}/cmd1 && echo printed-output`;
await say("run the command", [{ text: "Running it.", tool: "run_command", args: { command } }, { text: "It worked." }]);
await until(popup, "the popup");
const popupText = await frame.locator(".approval").innerText();
check("a command is held back and a popup shows it with its folder", (await popup()) && popupText.includes(command) && popupText.includes(WORKSPACE) && !exists("cmd1"));
check("the panel's tab shows that something is waiting", (await page.locator(".badge-content").allInnerTexts()).some((t) => t.trim() === "1"));
await shot("c03-popup-command");
await page.keyboard.press("Enter");
await wait(900);
check("pressing Enter alone does not approve it", (await popup()) && !exists("cmd1"));
await frame.locator(".approval-allow").click();
await settle();
check("Run runs it, and the result is shown", read("cmd1") === "approved-run" && (await cards()).some((c) => c.includes("exit 0")));
await frame.locator(".tool", { hasText: "Run command" }).last().locator("summary").click();
check("opening the card shows the command's output", (await frame.locator(".tool-body").last().innerText()).includes("printed-output"));
check("the model was shown that output", server.lastToolOutputs().includes("printed-output"));
check("the popup is gone and the badge cleared", !(await popup()) && !(await page.locator(".badge-content").allInnerTexts()).some((t) => t.trim() === "1"));

// --- Denying ---------------------------------------------------------------------------------
await say("run another", [{ tool: "run_command", args: { command: `echo denied > ${TMP}/cmd2` } }, { text: "OK, I will not." }]);
await until(popup, "the popup");
await frame.locator(".approval-deny").click();
await settle();
check("Deny stops the command from running", !exists("cmd2"));
check("the card says denied, and the model is told so", (await cards()).some((c) => c.includes("denied")) && server.lastToolOutputs().toLowerCase().includes("denied"));

await say("and again", [{ tool: "run_command", args: { command: `echo esc > ${TMP}/cmd3` } }, { text: "Fine." }]);
await until(popup, "the popup");
await page.keyboard.press("Escape");
await settle();
check("Escape denies", !exists("cmd3"));

await say("once more", [{ tool: "run_command", args: { command: `echo ctrl-enter > ${TMP}/cmd4` } }, { text: "Done." }]);
await until(popup, "the popup");
await page.keyboard.press("Control+Enter");
await settle();
check("Ctrl+Enter allows", read("cmd4") === "ctrl-enter");

// --- Files: write, edit, refusals ------------------------------------------------------------
await say("make a file", [{ tool: "write_file", args: { path: "made.txt", content: "line one\nline two\n" } }, { text: "Created." }]);
await until(popup, "the popup");
const writeText = await frame.locator(".approval").innerText();
check("a new file is held back and its content is shown as additions", writeText.includes("made.txt") && (await frame.locator(".diff-line.add").count()) >= 2 && !existsSync(join(WORKSPACE, "made.txt")));
await shot("c04-popup-write");
await frame.locator(".approval-allow").click();
await settle();
check("Allow creates the file", existsSync(join(WORKSPACE, "made.txt")) && readFileSync(join(WORKSPACE, "made.txt"), "utf8") === "line one\nline two\n");

await say("edit without reading", [{ tool: "edit_file", args: { path: "notes.md", old_string: "old line", new_string: "new line" } }, { text: "I see." }]);
await settle();
check("an edit to a file that was not read is refused without asking", !(await popup()) && server.lastToolOutputs().includes("Read notes.md") && readFileSync(join(WORKSPACE, "notes.md"), "utf8").includes("old line"));

await say("edit properly", [
  { tool: "read_file", args: { path: "notes.md" } },
  { tool: "edit_file", args: { path: "notes.md", old_string: "old line", new_string: "new line\nsecond line" } },
  { text: "Edited." },
]);
await until(popup, "the popup");
check("an edit is held back and shown as removed and added lines", (await frame.locator(".diff-line.del").count()) === 1 && (await frame.locator(".diff-line.add").count()) === 2 && readFileSync(join(WORKSPACE, "notes.md"), "utf8").includes("old line"));
await shot("c05-popup-edit");
await frame.locator(".approval-allow").click();
await settle();
check("Allow applies the edit", readFileSync(join(WORKSPACE, "notes.md"), "utf8") === "# Notes\nnew line\nsecond line\n");

await say("write outside", [{ tool: "write_file", args: { path: "/tmp/terax-outside-e2e", content: "x" } }, { text: "Refused, then." }]);
await settle();
check("writing outside the workspace is refused without asking", !(await popup()) && !existsSync("/tmp/terax-outside-e2e") && server.lastToolOutputs().includes("outside the workspace"));

await say("read the secret", [{ tool: "read_file", args: { path: ".env" } }, { text: "Cannot." }]);
await settle();
check("a secrets file is refused, and its content never reaches the model", !(await popup()) && !JSON.stringify(server.requests).includes("hunter2-e2e-secret"));

await say("a dangerous command", [{ tool: "run_command", args: { command: "rm -rf /" } }, { text: "No." }]);
await settle();
check("a destructive command is refused outright, with no popup", !(await popup()));

// --- Reading the terminal --------------------------------------------------------------------
await frame.locator("#stage").click({ position: { x: 300, y: 60 } });
await page.keyboard.type("echo sentinel-$((40+2))", { delay: 5 });
await page.keyboard.press("Enter");
await wait(900);
await say("what is on my terminal?", [{ tool: "read_terminal", args: {} }, { text: "I see it." }]);
await settle();
check("the agent can read what the terminal shows", server.lastToolOutputs().includes("sentinel-42"), server.lastToolOutputs().slice(0, 120));

// --- Stopping --------------------------------------------------------------------------------
const abortedBefore = server.aborted;
await say("think forever", [{ hang: true }]);
await until(async () => !(await idle()), "the turn to start");
check("while it works, the button says Stop", (await frame.locator(".composer-send").innerText()).trim() === "Stop");
await frame.locator(".composer-send").click();
check("Stop ends the turn and abandons the request", (await until(idle, "idle", 8000)) && (await until(async () => server.aborted > abortedBefore, "the request to be abandoned", 5000)));

await say("a command then stop", [{ tool: "run_command", args: { command: `echo never > ${TMP}/never` } }, { text: "n" }]);
await until(popup, "the popup");
await frame.locator(".approval-backdrop").click({ position: { x: 6, y: 6 } });
await wait(300);
check("a click on the dimmed area does not dismiss the popup or lose its keyboard", (await popup()) && (await frame.evaluate(() => document.activeElement?.classList.contains("approval") === true)));
await palette("Terax: Stop AI");
await settle();
check("stopping while a question is open closes it and leaves the command unrun", !exists("never") && !(await popup()));

// --- A question that arrives while the panel is hidden ---------------------------------------
const panelVisible = () => page.locator(".part.panel").isVisible().catch(() => false);
await say("do it while the panel is hidden", [{ delay: 4000, tool: "run_command", args: { command: `echo hidden > ${TMP}/hidden` } }, { text: "Done." }]);
await wait(500);
await palette("View: Close Panel");
await wait(800);
check("(control) the panel can be hidden while the agent is working", !(await panelVisible()));
check("a question that arrives while the panel is hidden brings the panel back", await until(panelVisible, "the panel to reappear", 15_000));
frame = await teraxFrame();
check("with the popup showing, and the command not run yet", (await until(popup, "the popup", 5000)) && !exists("hidden"));
await shot("c05b-hidden-then-shown");
await frame.locator(".approval-allow").click();
await settle();
check("and answering it runs the command", read("hidden") === "hidden");

// --- Reload: the conversation and a waiting question come back -------------------------------
await say("run and wait", [{ tool: "run_command", args: { command: `echo after-reload > ${TMP}/reload` } }, { text: "Ran." }]);
await until(popup, "the popup");
const messagesBefore = await frame.locator(".msg").count();
await palette("Developer: Reload Webviews");
await wait(6000);
frame = await teraxFrame();
check("after the page reloads, the conversation is still there", frame !== null && (await frame.locator(".msg").count()) >= messagesBefore - 1 && (await frame.locator(".msg.user").count()) > 5);
check("and the question that was waiting is asked again", await until(popup, "the popup after reload", 10_000));
await shot("c06-after-reload");
await frame.locator(".approval-allow").click();
await settle();
check("answering it after the reload still runs the command", read("reload") === "after-reload");

// --- The layout controls ---------------------------------------------------------------------
await frame.locator("#stage").click({ position: { x: 300, y: 60 } });
await page.keyboard.type(`stty size > ${TMP}/s1`, { delay: 4 });
await page.keyboard.press("Enter");
await wait(800);
const handle = await frame.locator("#splitter").boundingBox();
await page.mouse.move(handle.x + handle.width / 2, handle.y + 1);
await page.mouse.down();
await page.mouse.move(handle.x + handle.width / 2, handle.y - 90, { steps: 8 });
await page.mouse.up();
await wait(700);
await frame.locator("#stage").click({ position: { x: 300, y: 40 } });
await page.keyboard.type(`stty size > ${TMP}/s2`, { delay: 4 });
await page.keyboard.press("Enter");
await wait(800);
const rows = (n) => Number((read(n) ?? "0 0").split(" ")[0]);
check("dragging the splitter up gives the chat more room and the terminal fewer rows", rows("s2") < rows("s1") && rows("s2") > 0, `${read("s1")} -> ${read("s2")}`);
await frame.locator(".chat-toggle").click();
await wait(700);
check("the arrow folds the chat away, leaving only its header", !(await frame.locator(".chat-body").isVisible()) && (await frame.locator(".chat-head").isVisible()));
await frame.locator("#stage").click({ position: { x: 300, y: 40 } });
await page.keyboard.type(`stty size > ${TMP}/s3`, { delay: 4 });
await page.keyboard.press("Enter");
await wait(800);
check("the terminal takes the freed space", rows("s3") > rows("s2"), `${read("s2")} -> ${read("s3")}`);
await frame.locator(".chat-toggle").click();
await wait(500);
check("the arrow opens it again", await frame.locator(".chat-body").isVisible());

// --- Commands from the palette ---------------------------------------------------------------
await palette("Terax: Focus AI Chat");
await wait(1200);
check("'Focus AI Chat' puts the cursor in the message box", await frame.evaluate(() => document.activeElement?.classList.contains("composer-input") === true));
await page.locator(".explorer-viewlet .monaco-list-row", { hasText: "script.sh" }).first().click().catch(() => undefined);
await wait(1200);
await page.locator(".monaco-editor .view-lines").first().click().catch(() => undefined);
await page.keyboard.press("Control+a");
await palette("Terax: Ask Terax AI About Selection");
await wait(2000);
frame = await teraxFrame();
const draft = await frame.locator(".composer-input").inputValue();
check("'Ask Terax AI About Selection' puts the selected code in the message box", draft.includes("script.sh") && draft.includes("echo hi"), draft.slice(0, 80));
await frame.locator(".composer-input").fill("");

// --- New chat --------------------------------------------------------------------------------
await frame.locator(".chat-new").click();
await wait(800);
check("New chat clears the conversation", (await frame.locator(".msg").count()) === 0 && (await frame.locator(".empty").isVisible()));
const before = server.requests.length;
await say("fresh question", [{ text: "Fresh answer." }]);
await settle();
const roles = server.requests[before].messages.map((m) => m.role).join(",");
check("and the model is not shown anything from before", roles === "system,user", roles);

// --- API key and model choice, through the palette ---------------------------------------------
const quickInput = page.locator(".quick-input-widget input");
await palette("Terax: Set AI API Key");
await page.waitForSelector(".quick-input-widget", { state: "visible", timeout: 10_000 });
check("'Set AI API Key' asks for the key in a hidden field", (await quickInput.getAttribute("type")) === "password");
await page.keyboard.type("sk-e2e-secret-key-123456");
await page.keyboard.press("Enter");
await wait(1200);
const withKey = server.requests.length;
await say("use the key", [{ text: "Hello." }]);
await settle();
check("the key is kept in VS Code's secret storage and sent to the provider", server.headers[withKey]?.authorization === "Bearer sk-e2e-secret-key-123456", String(server.headers[withKey]?.authorization));
check("the key is not written to the settings file", !readFileSync(SETTINGS, "utf8").includes("sk-e2e-secret-key"));

await palette("Terax: Select AI Model");
await page.waitForSelector(".quick-input-widget", { state: "visible", timeout: 10_000 });
await page.keyboard.type("OpenAI Compatible");
await wait(600);
await page.keyboard.press("Enter");
await wait(900);
await page.keyboard.press("Enter");
await wait(900);
await page.keyboard.type("another-model");
await page.keyboard.press("Enter");
await wait(1500);
frame = await teraxFrame();
check("'Select AI Model' changes the model, and the chat's header follows at once", (await frame.locator(".chat-model").innerText()).includes("another-model"), await frame.locator(".chat-model").innerText());
const beforeModel = server.requests.length;
await say("which model", [{ text: "This one." }]);
await settle();
check("the next message goes to the chosen model", server.requests[beforeModel]?.model === "another-model", String(server.requests[beforeModel]?.model));
await shot("c08-model-chosen");

// --- The terminal is still fine --------------------------------------------------------------
await frame.locator("#stage").click({ position: { x: 300, y: 40 } });
await page.keyboard.type(`echo terminal-ok > ${TMP}/final`, { delay: 4 });
await page.keyboard.press("Enter");
await wait(800);
check("the terminal still works after all of that", read("final") === "terminal-ok");
await shot("c07-final");

check("the page logged no script errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
await browser.close();
await server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
