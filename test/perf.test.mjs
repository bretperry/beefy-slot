/*
  Perf settings, local and SSH command transport, bounded polling, and real lock records.
  Run with node --test; a temporary SSH substitute runs locally without network access.
  Perf keeps its own load limit, refuses bypass flags, and waits only on the caller.
*/
import "./tmpdir.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { resolveSettings } from "../src/index.mjs";
import { lockCommand, main, PERF_LOAD_MAX, PERF_RESOURCE, perfSettings } from "../src/perf.mjs";

// main() with the exec captured: { code, calls, errors, sleeps }. `statuses` are the answers, in order (the last repeats).
const drive = (argv, { env = {}, config = {}, statuses = [0] } = {}) => {
  const calls = [];
  const errors = [];
  const sleeps = [];
  let now = 1_000_000;
  const code = main(argv, {
    settings: resolveSettings({ env, config }),
    readSource: () => "// lock source",
    exec: (call) => (calls.push(call), { status: statuses[Math.min(calls.length - 1, statuses.length - 1)] }),
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    clock: () => now,
    err: (t) => errors.push(t),
  });
  return { code, calls, errors, sleeps };
};

describe("perf settings", () => {
  it("defaults to this machine and a line of 1.5; the project's values replace them, and this machine's env wins", () => {
    assert.deepEqual(perfSettings(resolveSettings({ env: {}, config: {} })), { host: "", loadMax: PERF_LOAD_MAX });
    assert.equal(PERF_LOAD_MAX, 1.5);
    assert.deepEqual(perfSettings(resolveSettings({ env: {}, config: { perfHost: "perf-box", perfLoadMax: 2 } })), { host: "perf-box", loadMax: 2 });
    assert.deepEqual(perfSettings(resolveSettings({ env: { BEEFY_SLOT_PERF_HOST: "other", BEEFY_SLOT_PERF_LOAD_MAX: "1" }, config: { perfHost: "perf-box", perfLoadMax: 2 } })), { host: "other", loadMax: 1 });
    for (const bad of ["0", "-1", "quiet", ""]) assert.equal(perfSettings(resolveSettings({ env: { BEEFY_SLOT_PERF_LOAD_MAX: bad }, config: {} })).loadMax, PERF_LOAD_MAX, bad);
    assert.equal(perfSettings(resolveSettings({ env: {}, config: { perfLoadMax: "fast" } })).loadMax, PERF_LOAD_MAX);
  });

  it("a host variable that is set but empty means this machine, over the project's host", () => {
    assert.equal(perfSettings(resolveSettings({ env: { BEEFY_SLOT_PERF_HOST: "" }, config: { perfHost: "perf-box" } })).host, "");
    const { calls } = drive(["take", "--as", "a"], { env: { BEEFY_SLOT_PERF_HOST: "" }, config: { perfHost: "perf-box" } });
    assert.equal(calls[0].command, process.execPath, "ran here, not over ssh");
  });
});

describe("perf command", () => {
  it("runs the lock core here, which owns the perf line", () => {
    const { code, calls } = drive(["take", "--as", "a"]);
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, process.execPath);
    assert.deepEqual(calls[0].args.slice(2), ["take", PERF_RESOURCE, "--as", "a"]);
    assert.deepEqual(calls[0].args.slice(0, 2), ["--input-type=module", "-"]);
    assert.match(calls[0].input, /^\/\/ lock source\nprocess\.exitCode = main\(/);
  });

  it("goes over ssh to the named host, sends the lock core on stdin, and quotes every word it sends", () => {
    const { calls } = drive(["waive", "--as", "feat/x y", "--reason", "it's fine; rm -rf /"], { config: { perfHost: "perf-box", perfLoadMax: 2 } });
    const [call] = calls;
    assert.equal(call.command, "ssh");
    assert.deepEqual(call.args.slice(0, 6), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30"]);
    assert.equal(call.args[6], "perf-box");
    assert.equal(call.args[7], "node --input-type=module - 'waive' 'perf' '--as' 'feat/x y' '--reason' 'it'\\''s fine; rm -rf /'");
    assert.match(call.input, /^\/\/ lock source\nprocess\.exitCode = main\(process\.argv\.slice\(2\), \{ settings: resolveSettings\(/);
  });

  it("asks for status of the perf slot only", () => {
    assert.deepEqual(drive(["status"]).calls[0].args.slice(2), ["status", PERF_RESOURCE]);
  });

  it("passes the lock's exit codes through, so 75 still means busy", () => {
    for (const status of [0, 1, 2, 75]) assert.equal(drive(["take", "--as", "a"], { statuses: [status] }).code, status);
  });

  it("reports anything else as the machine not answering, never as busy", () => {
    for (const status of [255, 127, null]) {
      const { code, errors } = drive(["take", "--as", "a"], { config: { perfHost: "perf-box" }, statuses: [status] });
      assert.equal(code, 1, String(status));
      assert.match(errors.at(-1), /^beefy-slot perf: could not run the lock on perf-box/);
    }
  });

  it("refuses the flags that would loosen the bound, a bad verb, and a host that could pass for an option", () => {
    for (const argv of [["take", "--as", "a", "--ignore-load"], ["take", "--as", "a", "--slots", "2"], ["nope"], []]) {
      const { code, calls } = drive(argv);
      assert.equal(code, 2, argv.join(" "));
      assert.equal(calls.length, 0, "nothing ran");
    }
    for (const host of ["-oProxyCommand=x", "a b", "h;x", "$(x)"]) {
      const { code, calls } = drive(["take", "--as", "a"], { env: { BEEFY_SLOT_PERF_HOST: host } });
      assert.equal(code, 2, host);
      assert.equal(calls.length, 0);
    }
  });

  it("starts every perf message with the beefy-slot perf: prefix", () => {
    const usage = drive(["take", "--as", "a", "--slots", "2"]);
    assert.match(usage.errors.at(-1), /^usage: beefy-slot perf take /);
    assert.match(usage.errors.at(-1), /\nbeefy-slot perf: --ignore-load and --slots are not accepted; waive the load limit with `waive`$/);
    assert.match(drive(["take", "--as", "a", "--wait", "soon"]).errors.at(-1), /\nbeefy-slot perf: --wait is for take, 0 to \d+ minutes$/);
    assert.match(drive(["take", "--as", "a"], { env: { BEEFY_SLOT_PERF_HOST: "a b" } }).errors.at(-1), /^beefy-slot perf: the perf host "a b" is not a host name ssh would take$/);
  });

  it("builds the ssh command from a plain object too", () => {
    const call = lockCommand({ host: "h", loadMax: 1.5, lockArgs: ["status", "perf"], source: "S", settings: resolveSettings({ env: {} }) });
    assert.equal(call.args.at(-1), "node --input-type=module - 'status' 'perf'");
  });
});

describe("perf waits on the caller's side", () => {
  it("asks again every poll until the slot is free, and never sends --wait to the lock", () => {
    const { code, calls, sleeps } = drive(["take", "--as", "a", "--wait", "5"], { statuses: [75, 75, 0], env: { BEEFY_SLOT_LOCK_POLL_SECONDS: "20" }, config: { perfHost: "perf-box" } });
    assert.equal(code, 0);
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [20_000, 20_000]);
    for (const call of calls) assert.ok(!call.args.some((arg) => arg.includes("--wait")), "nothing on the host waits, so nothing on the host outlives a killed caller");
  });

  it("gives up at the deadline with 75 and the last answer", () => {
    const { code, calls, sleeps } = drive(["take", "--as", "a", "--wait", "1"], { statuses: [75], env: { BEEFY_SLOT_LOCK_POLL_SECONDS: "25" } });
    assert.equal(code, 75);
    assert.deepEqual(sleeps, [25_000, 25_000, 10_000]);
    assert.equal(calls.length, 4);
  });

  it("does not wait without --wait, nor on an answer that is not busy", () => {
    assert.deepEqual(drive(["take", "--as", "a"], { statuses: [75] }).sleeps, []);
    assert.deepEqual(drive(["take", "--as", "a", "--wait", "5"], { statuses: [1] }).sleeps, []);
  });

  it("refuses a wait above the limit, one that is not a number, and --wait on anything but take", () => {
    for (const argv of [["take", "--as", "a", "--wait", "241"], ["take", "--as", "a", "--wait", "soon"], ["take", "--as", "a", "--wait"], ["take", "--as", "a", "--wait", "99999999999999999999"], ["free", "--as", "a", "--wait", "5"]]) {
      const { code, calls } = drive(argv);
      assert.equal(code, 2, argv.join(" "));
      assert.equal(calls.length, 0);
    }
  });
});

// A stand-in `ssh` that skips its -o options and the host, records the host, and runs the rest as the remote shell would.
const standInSsh = (home) => {
  const bin = mkdtempSync(join(tmpdir(), "ssh-bin-"));
  const log = join(bin, "hosts.log");
  writeFileSync(join(bin, "ssh"), `#!/bin/sh\nwhile [ "$1" = "-o" ]; do shift 2; done\nhost="$1"; shift\necho "$host" >> ${JSON.stringify(log)}\n${home ? `export HOME=${JSON.stringify(home)}\n` : ""}exec sh -c "$*"\n`);
  chmodSync(join(bin, "ssh"), 0o755);
  return { bin, log };
};

describe("perf over a stand-in ssh", { skip: process.platform === "win32" }, () => {
  it("runs the real lock through the whole ssh command: take, busy, status, waive with a hostile reason, free", () => {
    const { bin, log } = standInSsh();
    const dir = mkdtempSync(join(tmpdir(), "perf-"));
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, BEEFY_SLOT_LOCK_DIR: dir, BEEFY_SLOT_PERF_HOST: "perf-box", BEEFY_SLOT_PERF_LOAD_MAX: "1000000" };
    const run = (...argv) => spawnSync(process.execPath, ["bin/beefy-slot.mjs", "perf", ...argv], { env, encoding: "utf8" });
    assert.equal(run("take", "--as", "a").status, 0);
    assert.equal(run("take", "--as", "b").status, 75);
    assert.match(run("status").stdout, /^perf: a until /);
    const waived = run("waive", "--as", "b", "--reason", "it's fine; touch pwned");
    assert.equal(waived.status, 0, waived.stderr);
    assert.match(run("status").stdout, /waiver for b: it's fine; touch pwned until /);
    assert.equal(run("free", "--as", "b").status, 1);
    assert.equal(run("free", "--as", "a").status, 0);
    assert.equal(
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .every((host) => host === "perf-box"),
      true,
      "every call went to the named host",
    );
  });

  it("resolves a config-only ~/ lock folder in the host's home", () => {
    const project = mkdtempSync(join(tmpdir(), "perf-project-"));
    const hostHome = mkdtempSync(join(tmpdir(), "perf-home-"));
    mkdirSync(join(project, ".git"));
    writeFileSync(join(project, "beefy-slot.json"), JSON.stringify({ lockDir: "~/.beefy-slot/locks", perfHost: "perf-box" }));
    const { bin } = standInSsh(hostHome);
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, BEEFY_SLOT_PERF_LOAD_MAX: "1000000" };
    delete env.BEEFY_SLOT_LOCK_DIR;
    delete env.BEEFY_SLOT_PERF_HOST;
    const cli = fileURLToPath(new URL("../bin/beefy-slot.mjs", import.meta.url));
    const run = (...args) => spawnSync(process.execPath, [cli, "perf", ...args], { cwd: project, env, encoding: "utf8" });
    const taken = run("take", "--as", "config-holder");
    assert.equal(taken.status, 0, taken.stderr);
    const path = join(hostHome, ".beefy-slot", "locks", "perf.json");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).as, "config-holder");
    assert.match(run("status").stdout, /perf: config-holder until /);
    assert.equal(run("free", "--as", "config-holder").status, 0);
    assert.equal(existsSync(path), false);
  });

  it("applies the perf line that went over the ssh command, and a reachable host that answers 75 keeps that code", () => {
    if (loadavg()[0] <= 0.000000001) return;
    const { bin } = standInSsh();
    const dir = mkdtempSync(join(tmpdir(), "perf-"));
    // A line below any real load: the host's lock must refuse, and say so as busy.
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, BEEFY_SLOT_LOCK_DIR: dir, BEEFY_SLOT_PERF_HOST: "perf-box", BEEFY_SLOT_PERF_LOAD_MAX: "0.000000001" };
    const taken = spawnSync(process.execPath, ["bin/beefy-slot.mjs", "perf", "take", "--as", "a"], { env, encoding: "utf8" });
    assert.equal(taken.status, 75);
    assert.match(taken.stderr, /load is/);
  });
});

describe("perf against the real lock", () => {
  it("holds one slot for one holder, turns the next away with 75, and frees", () => {
    const dir = mkdtempSync(join(tmpdir(), "perf-"));
    // A line no machine's load reaches, so the test is about the slot and not the host it runs on.
    const env = { ...process.env, BEEFY_SLOT_LOCK_DIR: dir, BEEFY_SLOT_PERF_LOAD_MAX: "1000000" };
    delete env.BEEFY_SLOT_PERF_HOST;
    const run = (...argv) => spawnSync(process.execPath, ["bin/beefy-slot.mjs", "perf", ...argv], { env, encoding: "utf8" });
    assert.equal(run("take", "--as", "a").status, 0);
    assert.equal(run("take", "--as", "b").status, 75);
    assert.match(run("status").stdout, /^perf: a until /);
    assert.equal(run("free", "--as", "b").status, 1);
    assert.equal(run("free", "--as", "a").status, 0);
    assert.equal(run("take", "--as", "b").status, 0);
  });

  it("turns a loaded machine away at the perf line, and a waiver lets that one holder through", () => {
    const dir = mkdtempSync(join(tmpdir(), "perf-"));
    // A line below any real load: 1e-9.
    const env = { ...process.env, BEEFY_SLOT_LOCK_DIR: dir, BEEFY_SLOT_PERF_LOAD_MAX: "0.000000001" };
    delete env.BEEFY_SLOT_PERF_HOST;
    const run = (...argv) => spawnSync(process.execPath, ["bin/beefy-slot.mjs", "perf", ...argv], { env, encoding: "utf8" });
    if (loadavg()[0] <= 0.000000001) return; // a machine with exactly zero load has nothing to test
    assert.equal(run("take", "--as", "a").status, 75);
    assert.match(run("take", "--as", "a").stderr, /load/);
    assert.equal(run("waive", "--as", "a", "--reason", "owner OK").status, 0);
    assert.equal(run("take", "--as", "a").status, 0);
    assert.equal(run("take", "--as", "a", "--ignore-load").status, 2);
  });
});
