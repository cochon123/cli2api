import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is required for the package smoke test");

function npm(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`npm ${args[0]} exited ${code}: ${stderr}`)));
  });
}

const root = await mkdtemp(join(tmpdir(), "cli2api-package-smoke-"));
try {
  const packDir = join(root, "pack");
  const installDir = join(root, "install");
  await mkdir(packDir, { recursive: true });
  const packed = await npm(["pack", "--ignore-scripts", "--json", "--pack-destination", packDir], process.cwd());
  const packResult = JSON.parse(packed.stdout);
  const tarball = join(packDir, packResult[0].filename);
  await npm(["install", "--prefix", installDir, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", tarball], process.cwd());
  const packageRoot = join(installDir, "node_modules", "@cochon123", "cli2api");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (manifest.dependencies && Object.keys(manifest.dependencies).length) throw new Error("packed manifest contains runtime dependencies");
  const topLevelPackages = (await readdir(join(installDir, "node_modules")))
    .filter((name) => !name.startsWith("."));
  if (topLevelPackages.length !== 1 || topLevelPackages[0] !== "@cochon123") {
    throw new Error(`packed install contains unexpected top-level packages: ${topLevelPackages}`);
  }
  for (const asset of [
    "dist/gemini-safe-settings.json",
    "dist/gemini-readonly-policy.toml",
    "dist/THIRD_PARTY_NOTICES.txt",
    "SECURITY.md",
  ]) {
    if (!existsSync(join(packageRoot, asset))) throw new Error(`packed artifact is missing ${asset}`);
  }
  const result = await npm([
    "exec", "--prefix", installDir, "--", "cli2api",
    "completion", "--model", "mock/echo", "--prompt", "package-smoke",
  ], process.cwd());
  if (!result.stdout.includes("package-smoke")) throw new Error("packed mock completion returned unexpected output");
  const packedVersion = await npm([
    "exec", "--prefix", installDir, "--", "cli2api", "--version",
  ], process.cwd());
  if (packedVersion.stdout.trim() !== manifest.version) throw new Error("packed CLI version does not match its manifest");
  const wrappedNpm = await npm([
    "exec", "--prefix", installDir, "--", "cli2api",
    "run", "--adapter", "mock", "--", "npm", "--version",
  ], process.cwd());
  if (!/\d+\.\d+\.\d+/.test(wrappedNpm.stdout)) throw new Error("packed cli2api run could not execute the npm shim");
  process.stdout.write("package smoke ok (zero separately installed runtime npm dependencies)\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
