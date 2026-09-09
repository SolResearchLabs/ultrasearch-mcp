#!/usr/bin/env node
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bundleRoot = join(repoRoot, "dist", "mcpb");
const manifestSource = join(repoRoot, "mcpb", "manifest.json");

function copyRequired(source, target) {
  if (!existsSync(source)) {
    throw new Error(`Missing required MCPB input: ${source}`);
  }
  cpSync(source, target, { recursive: true });
}

rmSync(bundleRoot, { recursive: true, force: true });
mkdirSync(bundleRoot, { recursive: true });
copyRequired(manifestSource, join(bundleRoot, "manifest.json"));
copyRequired(join(repoRoot, "build"), join(bundleRoot, "build"));
copyRequired(join(repoRoot, "domains.json"), join(bundleRoot, "domains.json"));
copyRequired(join(repoRoot, "pnpm-lock.yaml"), join(bundleRoot, "pnpm-lock.yaml"));
copyRequired(join(repoRoot, "package.json"), join(bundleRoot, "package.json"));
copyRequired(join(repoRoot, "README.md"), join(bundleRoot, "README.md"));
copyRequired(join(repoRoot, "LICENSE"), join(bundleRoot, "LICENSE"));
copyRequired(join(repoRoot, "NOTICE.md"), join(bundleRoot, "NOTICE.md"));

execSync("npx -y pnpm@10.30.3 install --prod --frozen-lockfile --ignore-scripts --node-linker=hoisted", {
  cwd: bundleRoot,
  stdio: "inherit",
});

writeFileSync(join(bundleRoot, ".mcpbignore"), "node_modules/.cache\n.pnpm-debug.log\n", "utf8");
console.log(`MCPB staging directory ready: ${bundleRoot}`);
