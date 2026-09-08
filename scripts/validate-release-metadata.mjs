#!/usr/bin/env node
import { readFileSync } from "node:fs";

const expectedTag = process.argv[2] ?? process.env.RELEASE_TAG ?? "";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const server = JSON.parse(readFileSync("server.json", "utf8"));
const manifest = JSON.parse(readFileSync("mcpb/manifest.json", "utf8"));

function fail(message) {
  console.error(`release metadata check failed: ${message}`);
  process.exitCode = 1;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertTruthy(value, label) {
  if (!value) fail(`${label}: missing`);
}

assertTruthy(pkg.name, "package name");
assertTruthy(pkg.version, "package version");
assertTruthy(pkg.mcpName, "package mcpName");
assertTruthy(server.name, "server name");
assertTruthy(server.version, "server version");
assertTruthy(manifest.version, "mcpb manifest version");

assertEqual(pkg.name, "@solresearchlabs/ultrasearch-mcp", "package name");
assertEqual(pkg.mcpName, server.name, "mcpName and server.json name");
assertEqual(pkg.version, server.version, "package and server.json version");assertEqual(pkg.version, manifest.version, "package and MCPB manifest version");

const npmPackage = server.packages?.find((p) => p.registryType === "npm");
assertTruthy(npmPackage, "server.json npm package entry");
if (npmPackage) {
  assertEqual(npmPackage.identifier, pkg.name, "server.json npm identifier");
  assertEqual(npmPackage.version, pkg.version, "server.json npm version");
  assertEqual(npmPackage.transport?.type, "stdio", "server.json npm transport");
}

if (pkg.repository?.url && !pkg.repository.url.startsWith("git+https://")) {
  fail("package repository URL must use git+https:// for npm publish hygiene");
}

if (expectedTag) {
  const expectedVersion = expectedTag.startsWith("v")
    ? expectedTag.slice(1)
    : expectedTag;
  assertEqual(pkg.version, expectedVersion, "tag and package version");
}

const secrets = server.packages?.flatMap((p) => p.environmentVariables ?? []) ?? [];
for (const envVar of secrets) {
  if (envVar.name.endsWith("_API_KEY") && envVar.isSecret !== true) {
    fail(`${envVar.name} must be marked isSecret=true in server.json`);
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log(`release metadata check passed for ${pkg.name}@${pkg.version}`);
