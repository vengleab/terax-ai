import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateSeams } from "./seams-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const config = JSON.parse(readFileSync(join(here, "seams.json"), "utf8"));

const SKIP = /(\.lock|pnpm-lock\.yaml|\.(png|jpe?g|gif|ico|icns|wasm|woff2?|ttf|otf|zip|gz))$/i;
const MAX_BYTES = 2 * 1024 * 1024;

const listed = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { cwd: root, maxBuffer: 64 * 1024 * 1024 },
)
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const files = new Map();
for (const path of listed) {
  if (SKIP.test(path)) continue;
  try {
    const buf = readFileSync(join(root, path));
    if (buf.length > MAX_BYTES || buf.includes(0)) continue;
    files.set(path, buf.toString("utf8"));
  } catch {
    // deleted in the working tree but still indexed
  }
}

const errors = evaluateSeams(config, files);
if (errors.length > 0) {
  console.error("fork seam check failed:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`fork seam check passed (${config.seams.length} registered files)`);
