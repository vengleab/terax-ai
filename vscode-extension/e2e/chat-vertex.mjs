// End-to-end test of the chat with Google Vertex AI (a service account key file), in a real VS Code (code-server).
//
//   TERAX_E2E_WORKSPACE=/path/to/folder TERAX_E2E_SETTINGS=/path/to/user-data/User/settings.json \
//     node e2e/chat-vertex.mjs [screenshot-dir]
//
// This checks what a person does in VS Code: choosing the provider, a model and the key file, what is saved
// where, and what the chat says when sign-in fails. It does not reach Google: from a sandbox the sign-in cannot
// connect, and from a machine with a network Google rejects the test's made-up key. Both end the same way in the
// chat (an error that names Google and, for a rejected key, offers "Choose key file"), and either is accepted.
// The success path, with a real signature and Vertex's request format, is covered by src/ai/vertex.test.ts.
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(`${process.env.PLAYWRIGHT_NODE_MODULES ?? process.cwd()}/`);
const { chromium } = require("playwright");

const URL = process.env.TERAX_E2E_URL ?? "http://127.0.0.1:8090";
const WORKSPACE = process.env.TERAX_E2E_WORKSPACE;
const SETTINGS = process.env.TERAX_E2E_SETTINGS;
const SHOTS = process.argv[2];
if (!WORKSPACE || !SETTINGS) throw new Error("Set TERAX_E2E_WORKSPACE and TERAX_E2E_SETTINGS.");
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const KEYS = "/tmp/terax-e2e-vertex";
rmSync(KEYS, { recursive: true, force: true });
mkdirSync(KEYS, { recursive: true });
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const GOOD = join(KEYS, "service-account.json");
const BAD = join(KEYS, "not-a-service-account.json");
writeFileSync(
  GOOD,
  JSON.stringify({
    type: "service_account",
    project_id: "e2e-project",
    private_key_id: "e2e-key-1",
    private_key: privateKey,
    client_email: "terax-e2e@e2e-project.iam.gserviceaccount.com",
    token_uri: "https://oauth2.googleapis.com/token",
  }),
);
writeFileSync(BAD, JSON.stringify({ type: "authorized_user", client_id: "x", client_secret: "e2e-secret-value", refresh_token: "r" }));
const keyBody = privateKey.split("\n")[1];

// Start from the defaults; the test makes its choices through the palette, as a person would.
const MACHINE = join(dirname(dirname(SETTINGS)), "Machine", "settings.json");
rmSync(MACHINE, { force: true });
writeFileSync(SETTINGS, "{}");
const savedSettings = () => (existsSync(MACHINE) ? JSON.parse(readFileSync(MACHINE, "utf8")) : {});

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
}

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
const rows = () => page.locator(".quick-input-list .monaco-list-row").allInnerTexts();
const toasts = () => page.locator(".notification-toast, .notifications-toasts .notification-list-item").allInnerTexts();

/** Types a path into VS Code's file dialog (in the browser it is a box with a path in it) and accepts it. */
async function pickFile(file) {
  await page.waitForSelector(".quick-input-widget", { state: "visible", timeout: 10_000 });
  await wait(500);
  await page.keyboard.press("Control+a");
  await page.keyboard.type(file);
  await wait(400);
  await page.keyboard.press("Enter");
  await wait(1500);
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
async function say(text) {
  await frame.locator(".composer-input").click();
  await page.keyboard.type(text, { delay: 4 });
  await page.keyboard.press("Enter");
}

// --- Choosing the provider, the model and the key file ----------------------------------------
await palette("Terax: Select AI Model");
await page.waitForSelector(".quick-input-widget", { state: "visible", timeout: 10_000 });
await page.keyboard.type("Google Vertex");
await wait(600);
const providers = (await rows()).join(" | ");
check("the provider list offers Google Vertex AI and says it needs a key file", providers.includes("Google Vertex AI") && providers.includes("service account key file"), providers);
await page.keyboard.press("Enter");
await wait(1500);
const models = (await rows()).join(" | ");
check("it lists Gemini models by their real ids", ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"].every((m) => models.includes(m)) && !models.includes("google-vertex-custom"), models.slice(0, 140));
await page.keyboard.type("gemini-2.5-flash");
await wait(500);
await page.keyboard.press("Enter");
await wait(1500);
check("with no key file yet, it goes on to ask for one", (await page.locator(".quick-input-widget").innerText()).includes("service account key file"));
await shot("v01-key-dialog");
await pickFile(BAD);
check("a file that is not a service account key is refused, and nothing is saved", await until(async () => (await toasts()).some((t) => t.includes("service_account")), "the refusal", 8000) && !savedSettings()["terax.ai.vertex.keyFile"]);
await palette("Terax: Choose Google Service Account Key File");
await pickFile(GOOD);
check("a service account key file is accepted, naming its account and project", await until(async () => (await toasts()).some((t) => t.includes("terax-e2e@e2e-project.iam.gserviceaccount.com") && t.includes("e2e-project")), "the confirmation", 8000));
await shot("v02-chosen");
const saved = savedSettings();
check("only the path is saved, in the user's settings, never the key", saved["terax.ai.vertex.keyFile"] === GOOD && saved["terax.ai.provider"] === "google-vertex" && saved["terax.ai.model"] === "gemini-2.5-flash" && !JSON.stringify(saved).includes(keyBody), JSON.stringify(saved).slice(0, 160));
frame = await teraxFrame();
check("the header names the provider and model", (await frame.locator(".chat-model").innerText()).includes("Google Vertex AI · gemini-2.5-flash"), await frame.locator(".chat-model").innerText());

// --- Signing in ---------------------------------------------------------------------------------
await say("hello");
await until(async () => (await frame.locator(".msg.error").count()) > 0, "an error", 30_000);
const error = await frame.locator(".msg.error").last().innerText();
const network = error.includes("Could not reach Google");
const rejected = error.includes("Google rejected");
console.log(`  (sign-in ended as: ${network ? "Google could not be reached" : rejected ? "Google rejected the made-up key" : "something else"}: ${error.replace(/\s+/g, " ").slice(0, 150)})`);
check("when sign-in fails the chat says so in words, naming Google", (network || rejected) && (await until(idle, "idle", 10_000)), error.slice(0, 120));
check("a rejected key offers Choose key file; an unreachable Google does not blame the key", rejected ? (await frame.locator(".msg.error .msg-action", { hasText: "Choose key file" }).count()) === 1 : (await frame.locator(".msg.error .msg-action").count()) === 0);
check("the private key is nowhere in the page", !(await frame.content()).includes(keyBody) && !error.includes("PRIVATE KEY"));
await shot("v03-sign-in-error");

// --- Forgetting the key file ---------------------------------------------------------------------
await palette("Terax: Forget Google Service Account Key File");
await wait(1500);
check("forgetting the key file removes only the setting", !savedSettings()["terax.ai.vertex.keyFile"] && existsSync(GOOD));
await say("hello again");
await until(async () => (await frame.locator(".msg.error").count()) >= 2, "the second error", 15_000);
const second = await frame.locator(".msg.error").last().innerText();
check("without a key file the chat asks for one", second.includes("Choose Google Service Account Key File") && (await frame.locator(".msg.error .msg-action", { hasText: "Choose key file" }).count()) >= 1, second.slice(0, 120));
await until(idle, "idle", 10_000);
await frame.locator(".msg.error .msg-action", { hasText: "Choose key file" }).last().click();
await page.waitForSelector(".quick-input-widget", { state: "visible", timeout: 10_000 });
check("its button opens the file chooser", (await page.locator(".quick-input-widget").innerText()).includes("service account key file"));
await shot("v04-button-dialog");
await page.keyboard.press("Escape");
await wait(500);

check("the page logged no script errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
