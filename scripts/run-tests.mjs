import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const files = readdirSync(resolve("test"))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => resolve("test", name));

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
