// End-to-end test: drives a real VS Code (code-server) that has the extension installed.
//
//   TERAX_E2E_WORKSPACE=/path/to/empty/folder node e2e/run.mjs [screenshot-dir]
//
// Environment:
//   TERAX_E2E_URL         where code-server listens (default http://127.0.0.1:8090)
//   TERAX_E2E_WORKSPACE   the folder code-server was started on (required; a script.sh is written into it)
//   PLAYWRIGHT_NODE_MODULES   a node_modules folder that has `playwright` (default: the current folder)
//   CHROMIUM_PATH         a Chromium binary, if Playwright's own is not installed
//
// See e2e/README.md for how to get a code-server running. The test exits non-zero if any check fails.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(`${process.env.PLAYWRIGHT_NODE_MODULES ?? process.cwd()}/`);
const { chromium } = require("playwright");

const URL = process.env.TERAX_E2E_URL ?? "http://127.0.0.1:8090";
const WORKSPACE = process.env.TERAX_E2E_WORKSPACE;
const SHOTS = process.argv[2];
if (!WORKSPACE) throw new Error("Set TERAX_E2E_WORKSPACE to the folder code-server was started on.");
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const TMP = "/tmp/terax-e2e";
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
writeFileSync(join(WORKSPACE, "script.sh"), `echo ran-from-editor > ${TMP}/editor\n`);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
}
const read = (name) => (existsSync(`${TMP}/${name}`) ? readFileSync(`${TMP}/${name}`, "utf8").trim() : null);

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

await page.goto(`${URL}/?folder=${encodeURIComponent(WORKSPACE)}`, { waitUntil: "load" });
await page.waitForSelector(".monaco-workbench", { timeout: 60_000 });
await page.waitForTimeout(3500);

const wait = (ms) => page.waitForTimeout(ms);
const quickVisible = () => page.locator(".quick-input-widget").isVisible().catch(() => false);
const panelVisible = () => page.locator(".part.panel").isVisible().catch(() => false);
const sidebarVisible = () => page.locator(".part.sidebar").isVisible().catch(() => false);
async function palette(text) {
  await page.keyboard.press("F1");
  await page.waitForSelector(".quick-input-widget", { state: "visible", timeout: 10_000 });
  await page.keyboard.type(text);
  await wait(700);
  await page.keyboard.press("Enter");
}
const type = async (text) => {
  await page.keyboard.type(text, { delay: 8 });
  await page.keyboard.press("Enter");
};
async function teraxFrame() {
  for (const f of page.frames()) if ((await f.locator("#stage").count().catch(() => 0)) > 0) return f;
  return null;
}

// --- Opening the panel -----------------------------------------------------------------------
await palette("Terax: Focus Terminal");
await wait(5000);
let frame = await teraxFrame();
check("the Terax panel opens and its page loads", frame !== null);
if (!frame) {
  await browser.close();
  process.exit(1);
}
check("it has one terminal tab and a canvas", (await frame.locator(".tab").count()) === 1 && (await frame.locator("canvas").count()) === 1);
await shot("01-panel");

await type(`echo auto-focus > ${TMP}/focus`);
await wait(800);
check("typing right after the command reaches the shell, without a click", read("focus") === "auto-focus");

// The chat shares the panel with the terminal. Even in a small panel with the chat open, the terminal stays usable.
await type(`stty size > ${TMP}/size-with-chat`);
await wait(800);
check("the chat sits below the terminal, which keeps at least 4 rows beside it", (await frame.locator("#chat").isVisible()) && Number((read("size-with-chat") ?? "0 0").split(" ")[0]) >= 4, `${read("size-with-chat")}`);
// The checks below are about the terminal alone, so the chat is folded away (e2e/chat.mjs covers the chat).
await frame.locator(".chat-toggle").click();
await wait(500);

let box = await frame.locator("#stage").boundingBox();
const stage = () => frame.locator("#stage");
await stage().click({ position: { x: 300, y: 80 } });

// --- Output ----------------------------------------------------------------------------------
await type(`clear; printf '\\033[31mred\\033[0m \\033[1;32mbold\\033[0m \\033[38;2;80;160;255mtruecolor\\033[0m\\n'; echo 'unicode: héllo ✓ 日本語 🙂'; ls --color=always / | head -8`);
await wait(1500);
await shot("02-colors");
await type(`clear; seq 1 200000 | tail -n 1 > ${TMP}/seq; echo finished > ${TMP}/seq-done`);
await wait(3500);
check("200,000 lines of output are handled and the shell carries on", read("seq") === "200000" && read("seq-done") === "finished");

// --- VS Code shortcuts -----------------------------------------------------------------------
async function pressIn(where, combo) {
  if (where === "terminal") await stage().click({ position: { x: 300, y: 120 } });
  else await page.locator(".editor-container, .editor-group-container").first().click({ position: { x: 200, y: 60 } }).catch(() => undefined);
  await wait(200);
  const sidebarBefore = await sidebarVisible();
  await page.keyboard.press(combo);
  await wait(500);
  const fired = { quick: await quickVisible(), sidebar: (await sidebarVisible()) !== sidebarBefore };
  if (fired.quick) await page.keyboard.press("Escape");
  if (fired.sidebar) await page.keyboard.press(combo);
  await wait(200);
  return fired.quick || fired.sidebar;
}
check("control: Ctrl+P and Ctrl+B do trigger VS Code outside the terminal", (await pressIn("editor", "Control+p")) && (await pressIn("editor", "Control+b")));
const leaked = [];
for (const combo of ["Control+p", "Control+b", "Control+e", "Control+r", "Control+n", "Control+f", "Control+k", "Control+j", "Control+g", "Control+o", "Control+l"]) {
  if (await pressIn("terminal", combo)) leaked.push(combo);
}
check("shell shortcuts (Ctrl+P, B, E, R, ...) go to the shell, not to VS Code", leaked.length === 0, leaked.join(", "));

await stage().click({ position: { x: 300, y: 80 } });
await page.keyboard.press("F1");
await wait(600);
const f1 = await quickVisible();
if (f1) await page.keyboard.press("Escape");
await wait(300);
await stage().click({ position: { x: 300, y: 80 } });
await page.keyboard.press("Control+Shift+p");
await wait(600);
const csp = await quickVisible();
if (csp) await page.keyboard.press("Escape");
check("F1 and Ctrl+Shift+P still reach VS Code from the terminal", f1 && csp);

// --- Ctrl+` ----------------------------------------------------------------------------------
await stage().click({ position: { x: 300, y: 80 } });
await page.keyboard.press("Control+`");
await wait(800);
const hidden = !(await panelVisible());
await page.locator(".editor-container, .editor-group-container").first().click({ position: { x: 200, y: 60 } }).catch(() => undefined);
await page.keyboard.press("Control+`");
await wait(1500);
check("Ctrl+` hides the panel from the terminal and shows it from the editor", hidden && (await panelVisible()));
frame = await teraxFrame();
await page.keyboard.press("F1");
await wait(600);
await page.keyboard.press("Escape");
await wait(600);
await page.keyboard.press("Control+`");
await wait(1200);
await type(`echo refocused > ${TMP}/refocus`);
await wait(800);
check("after the command palette closes, Ctrl+` returns to the terminal and keeps the panel open", (await panelVisible()) && read("refocus") === "refocused");

// --- Size ------------------------------------------------------------------------------------
await type(`stty size > ${TMP}/size1`);
await wait(800);
await palette("View: Toggle Maximized Panel");
await wait(1800);
frame = await teraxFrame();
await frame.locator("#stage").click({ position: { x: 300, y: 80 } });
await type(`stty size > ${TMP}/size2`);
await wait(800);
const rows = (name) => Number((read(name) ?? "0 0").split(" ")[0]);
check("the shell follows the panel's size when it is maximised", rows("size2") > rows("size1") && rows("size1") > 0, `${read("size1")} -> ${read("size2")}`);
await shot("03-maximised");
await palette("View: Toggle Maximized Panel");
await wait(1500);

// --- Tabs ------------------------------------------------------------------------------------
frame = await teraxFrame();
await frame.locator(".tab-add").click();
await wait(1500);
check("+ adds a tab", (await frame.locator(".tab").count()) === 2);
await type(`echo second-$$ > ${TMP}/second`);
await wait(800);
check("typing right after + reaches the new shell, without a click", read("second")?.startsWith("second-") === true);
await shot("04-two-tabs");
await frame.locator(".tab").first().locator(".tab-label").click();
await wait(500);
await type(`echo first-$$ > ${TMP}/first`);
await wait(800);
check("switching tabs sends typing to that tab's shell", read("first")?.startsWith("first-") === true && read("first") !== read("second"));
await frame.locator(".tab").nth(1).locator(".tab-close").click({ force: true });
await wait(800);
check("the close button removes a tab", (await frame.locator(".tab").count()) === 1);
await frame.locator("#stage").click({ position: { x: 300, y: 80 } });
await type("exit");
await wait(2500);
check("when the last shell exits a new one is started", (await frame.locator(".tab").count()) === 1);

// --- Clipboard -------------------------------------------------------------------------------
await frame.locator("#stage").click({ position: { x: 300, y: 80 } });
await type("clear; echo copy-me-12345");
await wait(700);
box = await frame.locator("#stage").boundingBox();
// The terminal starts 10px inside its box. The 13 characters of "copy-me-12345" are about 9px each.
const textX = box.x + 10;
await page.mouse.move(textX + 3, box.y + 8);
await page.mouse.down();
await page.mouse.move(textX + 60, box.y + 8, { steps: 6 });
await page.mouse.move(textX + 118, box.y + 8, { steps: 6 });
await page.mouse.up();
await wait(600);
await shot("05-selection");
await page.keyboard.press("Control+Shift+c");
await wait(500);
const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
check("a mouse selection is copied to VS Code's clipboard", clip.trim() === "copy-me-12345", JSON.stringify(clip));
await page.keyboard.type("echo ", { delay: 8 });
await page.keyboard.press("Control+Shift+v");
await wait(500);
await page.keyboard.type(` > ${TMP}/paste`, { delay: 8 });
await page.keyboard.press("Enter");
await wait(800);
check("pasting reaches the shell", read("paste") === "copy-me-12345");

// --- Links -----------------------------------------------------------------------------------
await type("clear; echo https://example.com/terax-link-test");
await wait(900);
await page.mouse.move(textX + 35, box.y + 8, { steps: 4 });
await wait(300);
await page.mouse.down();
await page.mouse.up();
await wait(1500);
const dialog = (await page.locator(".monaco-dialog-box").allInnerTexts().catch(() => [])).join(" ");
check("clicking a link asks VS Code to open it", dialog.includes("https://example.com/terax-link-test"), dialog.slice(0, 80));
await shot("06-link-dialog");
await page.keyboard.press("Escape");
await wait(500);

// --- Editor integration ----------------------------------------------------------------------
await page.locator(".explorer-viewlet .monaco-list-row", { hasText: "script.sh" }).first().click();
await wait(1500);
await page.locator(".monaco-editor .view-lines").first().click();
await page.keyboard.press("Control+a");
await palette("Terax: Run Selected Text in Terax Terminal");
await wait(1800);
check("'Run Selected Text' runs the editor's selection in the Terax terminal", read("editor") === "ran-from-editor");
await palette("Terax: Open in Terax Terminal");
await wait(2000);
await type(`pwd > ${TMP}/cwd`);
await wait(800);
check("'Open in Terax Terminal' starts a shell in the workspace folder", read("cwd") === WORKSPACE.replace(/\/$/, ""), `${read("cwd")}`);
await shot("07-editor-and-terminal");

// --- Theme -----------------------------------------------------------------------------------
frame = await teraxFrame();
const background = () => frame.evaluate(() => getComputedStyle(document.body).backgroundColor);
const before = await background();
await palette("Preferences: Toggle between Light/Dark Themes");
await wait(3000);
const after = await background();
check("the terminal follows a live light/dark theme change", before !== after, `${before} -> ${after}`);
await shot("08-theme-toggled");
await page.keyboard.press("Control+`");
await wait(1200);
await type(`echo after-theme > ${TMP}/theme`);
await wait(800);
check("the terminal still works after a theme change", read("theme") === "after-theme");
await palette("Preferences: Toggle between Light/Dark Themes");
await wait(2500);

// --- Full-screen program ---------------------------------------------------------------------
await page.keyboard.press("Control+`");
await wait(1200);
await type(`clear; seq 1 200 > ${TMP}/lines; less ${TMP}/lines`);
await wait(1200);
await shot("09-less");
await page.keyboard.press("Space");
await wait(400);
await page.keyboard.press("q");
await wait(700);
await type(`echo back > ${TMP}/less`);
await wait(800);
check("a full-screen program (less) runs and returns to the prompt", read("less") === "back");

check("the page logged no script errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
