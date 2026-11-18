// Runs each command in the README's Quickstart code blocks, in a temp project, so the steps cannot rot.
import "./tmpdir.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { BUSY } from "../src/index.mjs";

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

  it("prints help to stdout and exits 0, listing every command in the README", () => {
    const result = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    // The README's Commands block, one command per line, without the leading `beefy-slot `.
    const block = README.split(/^## Commands$/m)[1].match(/```\n([\s\S]*?)```/)[1];
    const listed = block.split("\n").filter((line) => line.trim()).map((line) => line.replace(/^beefy-slot /, ""));
    assert.ok(listed.length >= 7, `found ${listed.length} commands`);
    // The README spells `<min>` where --help spells `<minutes>`; --help itself is not a line of its own in --help.
    const normal = (text) => text.replace(/<minutes>/g, "<min>").replace(/…/g, "...").replace(/\s+/g, " ").trim();
    const help = result.stdout.split("\n").slice(1).map((line) => normal(line.trim())).filter(Boolean);
    assert.deepEqual(listed.filter((line) => line !== "--help").map(normal).sort(), [...help].sort());
    assert.ok(listed.includes("--help"), "the README lists --help");
  });

  it("returns the exit codes the README states", () => {
    const section = README.split(/^## Exit codes$/m)[1].split(/^## /m)[0];
    const rows = [...section.matchAll(/^\| (\d+) \| (.*) \|$/gm)].map((m) => ({ code: Number(m[1]), meaning: m[2] }));
    const stated = (word) => rows.find((row) => new RegExp(`^${word}`).test(row.meaning))?.code;
    const dir = mkdtempSync(join(tmpdir(), "readme-codes-"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "beefy-slot.json"), JSON.stringify({ lockDir: join(dir, "locks") }));
    const env = { ...process.env, BEEFY_SLOT_LOAD_MAX: "1000000" };
    const code = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env, encoding: "utf8" }).status;
    assert.equal(rows.length, 4, "four rows: done, refused, usage error, busy");
    assert.equal(code("take", "heavy", "--as", "a"), stated("Done"));
    assert.equal(code("take", "heavy", "--as", "b"), stated("Busy"), "pool busy");
    assert.equal(code("free", "heavy", "--as", "b"), stated("Refused"), "free by a non-holder");
    assert.equal(code("take", "heavy"), stated("Usage error"), "usage error");
    assert.equal(code("free", "heavy", "--as", "a"), stated("Done"));
    assert.equal(stated("Busy"), BUSY, "the busy code the source exports");
  });
});
