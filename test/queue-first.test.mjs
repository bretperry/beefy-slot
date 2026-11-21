// `beefy <cmd>`: a command with no verb queues with no cap and runs; a first word that is a verb stays a verb.
import "./tmpdir.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { isCommand } from "../src/beefy-slot.mjs";

const CLI = fileURLToPath(new URL("../bin/beefy-slot.mjs", import.meta.url));
const folder = () => mkdtempSync(join(tmpdir(), "qf-"));
const env = (dir) => ({ ...process.env, BEEFY_SLOT_LOCK_DIR: dir, BEEFY_SLOT_LOAD_MAX: "1000", BEEFY_SLOT_LOCK_POLL_SECONDS: "1" });
const beefy = (dir, args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { env: env(dir), encoding: "utf8", ...extra });
const sh = (code) => ["node", "-e", `process.exit(${code})`];

describe("beefy <cmd>", () => {
  it("runs a command and returns its exit code, freeing heavy", () => {
    const dir = folder();
    assert.equal(beefy(dir, sh(3)).status, 3);
    assert.match(beefy(dir, ["status"]).stdout, /no locks held/);
  });

  it("treats a first word that is a verb as the verb, and -- as a command", () => {
    const dir = folder();
    assert.equal(isCommand(["status"]), false);
    assert.equal(isCommand(["--", "status"]), true);
    assert.equal(beefy(dir, ["status"]).status, 0);
    const bin = join(dir, "bin");
    spawnSync("mkdir", [bin]);
    spawnSync("sh", ["-c", `printf '#!/bin/sh\\necho ran-status\\n' > ${bin}/status && chmod +x ${bin}/status`]);
    const result = spawnSync(process.execPath, [CLI, "--", "status"], { env: { ...env(dir), PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /ran-status/);
  });

  it("a bare beefy without a terminal prints usage and exits 2", () => {
    const result = beefy(folder(), []);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage/);
  });

  it("passes a flag-like word after -- to the command", () => {
    const result = beefy(folder(), ["--on", "heavy", "--", "echo", "--x"]);
    assert.equal(result.stdout.trim(), "--x");
  });

  it("waits with no cap and runs in ticket order", async () => {
    const dir = folder();
    const log = join(dir, "order.txt");
    const job = (name, ms) => ["node", "-e", `require("fs").appendFileSync(${JSON.stringify(log)}, "${name}\\n"); setTimeout(() => {}, ${ms})`];
    const run = (args) => new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { env: env(dir), stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => resolve({ code, err }));
    });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const first = run(job("a", 1500));
    await wait(700);
    const second = run(job("b", 100));
    await wait(700);
    const third = run(job("c", 100));
    const done = await Promise.all([first, second, third]);
    assert.deepEqual(done.map((d) => d.code), [0, 0, 0]);
    assert.equal(readFileSync(log, "utf8"), "a\nb\nc\n");
    assert.match(done[1].err, /waiting: 0 ahead on heavy/);
    assert.match(done[2].err, /waiting: 1 ahead on heavy/);
  });

  it("--wait 0 keeps the busy exit 75", () => {
    const dir = folder();
    const holder = spawn(process.execPath, [CLI, ...sh(0).slice(0, 2), "setTimeout(() => {}, 3000)"], { env: env(dir), stdio: "ignore" });
    const until = Date.now() + 2000;
    while (Date.now() < until && !/heavy/.test(beefy(dir, ["status"]).stdout)) spawnSync("sleep", ["0.1"]);
    const result = beefy(dir, ["--wait", "0", ...sh(0)]);
    holder.kill();
    assert.equal(result.status, 75);
  });

  it("matches run on a signal and on stdin", () => {
    const dir = folder();
    const kill = ["node", "-e", "process.kill(process.pid, 'SIGTERM')"];
    const viaRun = beefy(dir, ["run", "heavy", "--", ...kill]);
    const viaCmd = beefy(dir, kill);
    assert.equal(viaRun.status, 143);
    assert.equal(viaCmd.status, viaRun.status);
    const cat = ["node", "-e", "process.stdin.on('data', (d) => process.stdout.write(d)); process.stdin.on('end', () => process.exit(0))"];
    const runIn = beefy(dir, ["run", "heavy", "--", ...cat], { input: "piped" });
    const cmdIn = beefy(dir, cat, { input: "piped" });
    assert.equal(cmdIn.status, runIn.status);
    assert.equal(cmdIn.stdout, runIn.stdout);
    assert.equal(cmdIn.stderr, runIn.stderr);
    // From a shell pipe (a FIFO) the notice is printed, the same words as run.
    const piped = (args) => spawnSync("sh", ["-c", `echo hi | "$0" "$@"`, process.execPath, CLI, ...args], { env: env(dir), encoding: "utf8" });
    assert.match(piped(["node", "-e", "0"]).stderr, /gives its command no stdin/);
    assert.equal(piped(["node", "-e", "0"]).stderr, piped(["run", "heavy", "--", "node", "-e", "0"]).stderr);
  });

  it("prints the waiting line whatever the cap", async () => {
    const dir = folder();
    const holder = spawn(process.execPath, [CLI, ...sh(0).slice(0, 2), "setTimeout(() => {}, 1500)"], { env: env(dir), stdio: "ignore" });
    const until = Date.now() + 2000;
    while (Date.now() < until && !/heavy/.test(beefy(dir, ["status"]).stdout)) spawnSync("sleep", ["0.1"]);
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, "--wait", "1", ...sh(0)], { env: env(dir), stdio: ["ignore", "pipe", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => resolve({ code, err }));
    });
    holder.kill();
    assert.equal(result.code, 0);
    assert.match(result.err, /waiting: 0 ahead on heavy/);
  });

  it("says the load is the reason when that is what holds it", async () => {
    const dir = folder();
    const child = spawn(process.execPath, [CLI, ...sh(0)], { env: { ...env(dir), BEEFY_SLOT_LOAD_MAX: "0.0001" }, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const until = Date.now() + 5000;
    while (Date.now() < until && !/waiting/.test(err)) await new Promise((r) => setTimeout(r, 50));
    child.kill();
    assert.match(err, /^waiting: load [\d.]+ over 0\.0/);
  });

  it("rejects a flag with no value, a flag word as its value, and the = form, with usage and exit 2", () => {
    for (const args of [["--as"], ["--on", "heavy"], ["--as", "--wait", "echo", "hi"], ["--on", "--wait", "x"], ["--on=perf", "echo", "hi"], ["--bogus", "echo"]]) {
      const result = beefy(folder(), args);
      assert.equal(result.status, 2, args.join(" "));
      assert.match(result.stderr, /usage/);
    }
  });

  it("prints usage for -h and exits 0", () => {
    const result = beefy(folder(), ["-h"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /usage/);
    assert.match(result.stdout, /-- <command…>/);
  });

  it("lists the queue commands in --help and in the help verb, which exit 0", () => {
    for (const args of [["--help"], ["help"]]) {
      const result = beefy(folder(), args);
      assert.equal(result.status, 0, args.join(" "));
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /^ {2}beefy \[-d\] \[--on <resource>\] \[--wait <minutes>\] \[--as <who>\] \[--\] <command…>/m);
      assert.match(result.stdout, /^ {2}beefy {3}\(alone, on a terminal\) opens the queue screen/m);
      for (const line of ["jobs [--json]", "log <id> [-f]", "cancel <id>", "config [check", "take <resource>"]) assert.ok(result.stdout.includes(`  ${line}`), line);
    }
  });
});
