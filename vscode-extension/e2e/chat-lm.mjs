// End-to-end test of the chat using VS Code's own language models (`vscode.lm`, which is how GitHub Copilot is
// used), in a real VS Code (code-server). GitHub Copilot cannot run there, so a scripted provider extension
// (e2e/fake-lm-extension) registers a model the same way Copilot does, and the test checks what Terax asks of
// VS Code and what it does with the answers.
//
//   TERAX_E2E_WORKSPACE=/path/to/folder TERAX_E2E_SETTINGS=/path/to/user-data/User/settings.json \
//     node e2e/chat-lm.mjs [screenshot-dir]
//
// The fake extension (terax-e2e-fake-lm-0.0.1.vsix, built with `npx @vscode/vsce package` in its folder) must be
// installed in the same code-server as the Terax extension. Environment: as for chat.mjs, plus
//   TERAX_E2E_LM_DIR   where the fake provider keeps its script and records (default /tmp/terax-e2e-lm)
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(`${process.env.PLAYWRIGHT_NODE_MODULES ?? process.cwd()}/`);
const { chromium } = require("playwright");

const URL = process.env.TERAX_E2E_URL ?? "http://127.0.0.1:8090";
const WORKSPACE = process.env.TERAX_E2E_WORKSPACE;
const SETTINGS = process.env.TERAX_E2E_SETTINGS;
const LM = process.env.TERAX_E2E_LM_DIR ?? "/tmp/terax-e2e-lm";
const SHOTS = process.argv[2];
if (!WORKSPACE || !SETTINGS) throw new Error("Set TERAX_E2E_WORKSPACE and TERAX_E2E_SETTINGS.");
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const TMP = "/tmp/terax-e2e-chat-lm";
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
rmSync(LM, { recursive: true, force: true });
mkdirSync(LM, { recursive: true });
writeFileSync(join(WORKSPACE, "script.sh"), "echo hi\n");

// Start from the defaults: no provider, no model. The test chooses them through the palette, as a person would.
rmSync(join(dirname(dirname(SETTINGS)), "Machine", "settings.json"), { force: true });
writeFileSync(SETTINGS, "{}");

const script = (steps) => {
  writeFileSync(join(LM, "script.json"), JSON.stringify(steps));
  rmSync(join(LM, "state.json"), { force: true });
};
const requests = () => (existsSync(join(LM, "requests.jsonl")) ? readFileSync(join(LM, "requests.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const lastResults = () => (requests().at(-1)?.messages ?? []).flatMap((m) => m.parts).filter((p) => p.k === "result").map((p) => p.text).join("\n");

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
  process.exit(1);
}
await palette("View: Toggle Maximized Panel");
await wait(1500);
frame = await teraxFrame();

const idle = () => frame.locator(".composer-send").innerText().then((t) => t.trim() === "Send");
const popup = () => frame.locator(".approval").isVisible();
const cards = () => frame.locator(".tool").allInnerTexts();
async function say(text, steps) {
  if (steps) script(steps);
  await frame.locator(".composer-input").click();
  await page.keyboard.type(text, { delay: 4 });
  await page.keyboard.press("Enter");
}
const settle = async () => {
  await until(idle, "the turn to end", 20_000);
  await wait(250);
};

// --- The default is VS Code's own models ------------------------------------------------------
check("with nothing set up, the chat is for GitHub Copilot through VS Code", (await frame.locator(".chat-model").innerText()).includes("GitHub Copilot"), await frame.locator(".chat-model").innerText());

// --- Choosing a model from the ones VS Code has -----------------------------------------------
await palette("Terax: Select AI Model");
await page.waitForSelector(".quick-input-widget", { state: "visible", timeout: 10_000 });
const providers = await page.locator(".quick-input-list .monaco-list-row").allInnerTexts();
check("the provider list starts with GitHub Copilot and says it needs no key", providers[0]?.includes("GitHub Copilot") && providers[0]?.includes("no key"), providers[0]);
await shot("lm01-providers");
await page.keyboard.press("Enter");
// The first call wakes the model provider's extension, which can take a few seconds.
await wait(1500);
await page.waitForSelector(".quick-input-widget", { state: "visible", timeout: 30_000 });
await until(async () => (await page.locator(".quick-input-list .monaco-list-row").allInnerTexts()).some((t) => t.includes("Default")), "the model list", 30_000);
const models = await page.locator(".quick-input-list .monaco-list-row").allInnerTexts();
check("the model list is what VS Code offers: a default, and the fake provider's model", models.some((m) => m.includes("Default")) && models.some((m) => m.includes("Fake LM") && m.includes("terax-e2e")), models.join(" | ").slice(0, 160));
await shot("lm02-models");
await page.keyboard.type("Fake LM");
await wait(500);
await page.keyboard.press("Enter");
await wait(1500);
frame = await teraxFrame();
check("the header follows the choice", (await frame.locator(".chat-model").innerText()).includes("fake-lm"), await frame.locator(".chat-model").innerText());

// --- A turn through VS Code's model API --------------------------------------------------------
await say("what files are here?", [{ tool: "list_directory", args: {} }, { text: "I found script.sh in the folder." }]);
// VS Code may ask once whether Terax may use the model.
const consent = page.locator(".monaco-dialog-box, .notification-toast");
if (await until(async () => (await consent.count()) > 0, "a consent prompt", 4000)) {
  console.log(`  (VS Code asked: ${(await consent.first().innerText()).replace(/\s+/g, " ").slice(0, 140)})`);
  await shot("lm03-consent");
  await page.locator(".monaco-dialog-box .monaco-button, .notification-toast .monaco-button").first().click().catch(() => undefined);
}
await settle();
check("a reading tool runs without asking, and the answer arrives", !(await popup()) && (await cards()).some((c) => c.includes("List folder")) && (await frame.locator(".msg.assistant").last().innerText()).includes("I found script.sh"));
const first = requests()[0];
check("VS Code's model was sent Terax's instructions first, then the question", first?.messages[0]?.parts[0]?.value?.includes("You are Terax") && first?.messages.at(-1)?.parts[0]?.value === "what files are here?", JSON.stringify(first?.messages.map((m) => m.role)));
check("and the eight tools", [...(first?.tools ?? [])].sort().join(",") === "edit_file,glob,grep,list_directory,read_file,read_terminal,run_command,write_file", (first?.tools ?? []).join(","));
const second = requests()[1];
check("the tool's result went back to the model as a result for the same call", second?.messages.some((m) => m.parts.some((p) => p.k === "call" && p.name === "list_directory")) && lastResults().includes("script.sh"));
await shot("lm04-answer");

// --- Approval works the same way ---------------------------------------------------------------
await say("run it", [{ text: "Running.", tool: "run_command", args: { command: `echo via-lm > ${TMP}/ran` } }, { text: "Done." }]);
await until(popup, "the popup");
check("a command is held for the popup, as with any other provider", (await popup()) && !exists("ran") && (await frame.locator(".approval").innerText()).includes("via-lm"));
await shot("lm05-popup");
await frame.locator(".approval-allow").click();
await settle();
check("Run runs it, and the model is shown the result", read("ran") === "via-lm" && lastResults().includes("exit_code"));

await say("run another", [{ tool: "run_command", args: { command: `echo no > ${TMP}/denied` } }, { text: "Understood." }]);
await until(popup, "the popup");
await frame.locator(".approval-deny").click();
await settle();
check("Deny stops it, and the model is told", !exists("denied") && lastResults().toLowerCase().includes("denied"));

// --- Stop reaches VS Code's cancellation --------------------------------------------------------
await say("think forever", [{ hang: true }]);
await until(async () => !(await idle()), "the turn to start");
await frame.locator(".composer-send").click();
check("Stop ends the turn at once, even though the model is still 'thinking'", await until(idle, "idle", 8000));
// Terax cancels the request and stops waiting for it. Whether VS Code passes the cancellation on to the model's
// extension is VS Code's doing: in 1.108 (this test's code-server) the provider's token is not cancelled, so this is
// only reported, not checked.
const told = await until(async () => existsSync(join(LM, "cancelled.txt")), "the cancellation", 3000);
console.log(`  (info: this VS Code ${told ? "did" : "did not"} tell the model's extension about the cancellation)`);

// --- A model that is gone -----------------------------------------------------------------------
await say("one more", [{ text: "Still here." }]);
await settle();
check("the chat carries on after a stop", (await frame.locator(".msg.assistant").last().innerText()).includes("Still here"));

check("the page logged no script errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
