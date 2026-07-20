import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { applyEdits, modify, parse } from "jsonc-parser";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [settingsPath, host, model] = process.argv.slice(2);
if (!settingsPath || !host || !model) {
  fail("Usage: node configure-vscode-settings.mjs <settings-path> <ollama-host> <model>");
}

const directory = path.dirname(settingsPath);
fs.mkdirSync(directory, { recursive: true });
const existed = fs.existsSync(settingsPath);
const original = existed ? fs.readFileSync(settingsPath, "utf8") : "{}\n";
const parseErrors = [];
parse(original, parseErrors, { allowTrailingComma: true, disallowComments: false });
if (parseErrors.length > 0) {
  fail(`VS Code settings contain invalid JSONC (first error offset: ${parseErrors[0].offset}).`);
}

const eol = original.includes("\r\n") ? "\r\n" : "\n";
const insertSpaces = !/^\t/m.test(original);
const tabSize = insertSpaces ? Math.max(2, original.match(/^[ ]+(?=\S)/m)?.[0].length ?? 2) : 1;
const formattingOptions = { insertSpaces, tabSize, eol };
let updated = original;
for (const [key, value] of [
  ["localCodeAgent.ollama.host", host],
  ["localCodeAgent.ollama.model", model],
  ["localCodeAgent.runtime.autoStart", true],
]) {
  updated = applyEdits(updated, modify(updated, [key], value, { formattingOptions }));
}

if (updated === original) {
  console.log("VS Code settings already contain the requested values.");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
const backupPath = `${settingsPath}.backup-${stamp}`;
const temporaryPath = path.join(directory, `.${path.basename(settingsPath)}.${process.pid}.tmp`);
fs.writeFileSync(temporaryPath, updated, { encoding: "utf8", flag: "wx" });

try {
  if (existed) {
    fs.renameSync(settingsPath, backupPath);
  }
  fs.renameSync(temporaryPath, settingsPath);
} catch (error) {
  if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  if (existed && !fs.existsSync(settingsPath) && fs.existsSync(backupPath)) {
    fs.renameSync(backupPath, settingsPath);
  }
  throw error;
}

console.log(
  existed ? `Updated settings; backup: ${backupPath}` : `Created settings: ${settingsPath}`,
);
