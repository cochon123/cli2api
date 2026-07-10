import { readFileSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";

const file = "dist/index.js";
const src = readFileSync(file, "utf8");
const withShebang = src.startsWith("#!") ? src : `#!/usr/bin/env node\n${src}`;
writeFileSync(file, withShebang);
chmodSync(file, 0o755);
