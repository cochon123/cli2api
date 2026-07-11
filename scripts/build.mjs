import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const outDir = "dist";
const outfile = join(outDir, "index.js");
const noticedPackages = [
  "@hono/node-server",
  "ajv",
  "commander",
  "fast-deep-equal",
  "fast-uri",
  "hono",
  "json-schema-traverse",
  "zod",
];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: ["src/index.ts"],
  outfile,
  bundle: true,
  packages: "bundle",
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  sourcemap: false,
  legalComments: "eof",
  metafile: true,
  banner: {
    js: "import { createRequire as __cli2apiCreateRequire } from \"node:module\"; const require = __cli2apiCreateRequire(import.meta.url);",
  },
});

const bundledPackages = new Set(
  Object.keys(result.metafile.inputs).flatMap((input) => {
    const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
    return match?.[1] ? [match[1]] : [];
  }),
);
const missingNotices = [...bundledPackages].filter((name) => !noticedPackages.includes(name));
const unusedNotices = noticedPackages.filter((name) => !bundledPackages.has(name));
if (missingNotices.length || unusedNotices.length) {
  throw new Error(`Bundled dependency notice mismatch; missing=[${missingNotices}] unused=[${unusedNotices}]`);
}

copyFileSync("src/adapters/gemini-safe-settings.json", join(outDir, "gemini-safe-settings.json"));
copyFileSync("src/adapters/gemini-readonly-policy.toml", join(outDir, "gemini-readonly-policy.toml"));

const notice = [
  "cli2api bundled third-party notices",
  "",
  "The distributed JavaScript bundle contains the following packages.",
  "Their license texts are reproduced below.",
  "",
  ...noticedPackages.flatMap((name) => {
    const root = join("node_modules", ...name.split("/"));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const license = readFileSync(join(root, "LICENSE"), "utf8").trim();
    return [`===== ${name}@${pkg.version} (${pkg.license ?? "license in text"}) =====`, license, ""];
  }),
].join("\n");
writeFileSync(join(outDir, "THIRD_PARTY_NOTICES.txt"), notice, "utf8");

const output = readFileSync(outfile, "utf8");
if (!output.startsWith("#!/usr/bin/env node\n")) {
  throw new Error("esbuild did not preserve the cli2api executable shebang");
}
chmodSync(outfile, 0o755);
