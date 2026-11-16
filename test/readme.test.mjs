// Runs each command in the README's Quickstart code blocks, in a temp project, so the steps cannot rot.
import "./tmpdir.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const CLI = fileURLToPath(new URL("../bin/beefy-slot.mjs", import.meta.url));
const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");

// Fenced `sh` blocks between "## Quickstart" and the next "## " heading, as single commands.
const quickstart = README.split(/^## Quickstart$/m)[1].split(/^## /m)[0];
const commands = [...quickstart.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((m) => m[1].split("\n").filter((line) => line.trim()));

describe("README quickstart", () => {
  it("has commands to run", () => assert.ok(commands.length >= 4, `found ${commands.length}`));

  it("runs each command in a temp folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "readme-"));
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "beefy-slot.json"), JSON.stringify({ lockDir: join(dir, "locks") }));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "node -e 0", test: "node -e 0" } }));
    // The README says `beefy-slot`; the temp folder's bin stands in for the installed command.
    const shim = join(dir, "bin", "beefy-slot");
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
    chmodSync(shim, 0o755);
    const env = { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, BEEFY_SLOT_LOAD_MAX: "1000000" };
    for (const command of commands) {
      const result = spawnSync("sh", ["-c", command], { cwd: dir, env, encoding: "utf8" });
      assert.equal(result.status, 0, `${command}\n${result.stdout}${result.stderr}`);
    }
  });
});
