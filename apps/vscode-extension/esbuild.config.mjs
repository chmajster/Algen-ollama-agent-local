import { mkdir } from "node:fs/promises";

import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const common = { bundle: true, sourcemap: true, logLevel: "info" };

await mkdir("dist/runtime", { recursive: true });
await mkdir("dist/webview", { recursive: true });

const builds = [
  {
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    target: "node22",
    format: "cjs",
    external: ["vscode"],
  },
  {
    ...common,
    entryPoints: ["../agent-runtime/src/serverEntry.ts"],
    outfile: "dist/runtime/server.js",
    platform: "node",
    target: "node22",
    format: "cjs",
  },
  {
    ...common,
    entryPoints: ["src/webview/main.ts"],
    outfile: "dist/webview/main.js",
    platform: "browser",
    target: "es2022",
    format: "iife",
  },
  {
    ...common,
    entryPoints: ["src/webview/main.css"],
    outfile: "dist/webview/main.css",
    minify: true,
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log("Watching extension, runtime and webview bundles…");
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
