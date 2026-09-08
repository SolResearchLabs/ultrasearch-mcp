import { chmodSync, existsSync } from "node:fs";

const entry = "build/src/index.js";
if (existsSync(entry)) {
  chmodSync(entry, 0o755);
}
