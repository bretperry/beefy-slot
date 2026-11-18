/*
  Lock ownership, stale takeover, load limits, command quoting, and injected judge refusals.
  Run with node --test; uses temporary records and the package CLI for process races.
  A busy resource returns 75; a judge refusal returns 1 before taking or spawning.
*/
import "./tmpdir.mjs";
import assert from "node:assert/strict";
import { spawn as start, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { BUSY, busiestProcess, LOAD_MAX, LOAD_PER_CORE, holder, loadLine, main, resolveSettings, quoteCommand, sinkRefusal, take } from "../src/index.mjs";

const NOW = new Date("2026-10-20T12:00:00Z");
const later = (minutes) => new Date(NOW.getTime() + minutes * 60_000);

// A fresh lock dir and a quiet main (its judge allows everything unless a test passes one): { run(argv, opts) → code, dir, errors }.
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  const errors = [];
  const run = (argv, opts = {}) => main(argv, {
    now: NOW, load: 0, judge: () => null, busiest: () => "", statusHeader: false,
    out: () => {}, err: (t) => errors.push(t), ...opts,
    settings: resolveSettings({ env: { BEEFY_SLOT_LOCK_DIR: dir }, cores: 2, ...opts }),
  });
  return { dir, run, errors };
};

describe("lock", () => {
  it("lets one holder in and turns the next away with 75", () => {
    const { dir, run, errors } = setup();
    assert.equal(run(["take", "port-3000", "--as", "a"]), 0);
    assert.equal(run(["take", "port-3000", "--as", "a"]), 0, "taking your own lock refreshes it");
    assert.equal(run(["take", "port-3000", "--as", "b"]), BUSY);
    assert.match(errors.at(-1), /held by a/);
    assert.equal(holder(dir, "port-3000").as, "a");
  });

  it("only the holder frees it", () => {
    const { run } = setup();
    run(["take", "db", "--as", "a"]);
    assert.equal(run(["free", "db", "--as", "b"]), 1);
    assert.equal(run(["free", "db", "--as", "a"]), 0);
    assert.equal(run(["take", "db", "--as", "b"]), 0);
  });

  it("treats a lock past its TTL as free", () => {
    const { run } = setup();
    run(["take", "sim", "--as", "a", "--ttl", "5"]);
    assert.equal(run(["take", "sim", "--as", "b"], { now: later(4) }), BUSY);
    assert.equal(run(["take", "sim", "--as", "b"], { now: later(6) }), 0);
  });

  it("lets only one of two takers racing on a stale lock win", () => {
    const { dir } = setup();
    const fresh = { dir, resource: "sim", ttl: 5, now: NOW, load: 0 };
    take({ ...fresh, as: "old" });
    const later10 = later(10);
    // B takes the stale lock after A has seen it stale and before A acts on it: A must not
    // delete B's fresh lock and create its own on top.
    let b;
    const a = take({ ...fresh, as: "a", now: later10, onStale: () => (b = take({ ...fresh, as: "b", now: later10 })) });
    assert.equal(b.ok, true);
    assert.equal(a.ok, false);
    assert.equal(holder(dir, "sim").as, "b");
  });

  it("lets only one of several processes racing on a stale lock win", async () => {
    const { dir } = setup();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sim.json"), JSON.stringify({ resource: "sim", as: "old", at: NOW.toISOString(), until: NOW.toISOString(), pid: 1 }));
    const codes = await Promise.all(
      Array.from({ length: 8 }, (_, i) => new Promise((done) => start(process.execPath, ["bin/beefy-slot.mjs", "take", "sim", "--as", `p${i}`, "--ignore-load", "--reason", "race test"], { env: { ...process.env, BEEFY_SLOT_LOCK_DIR: dir }, stdio: "ignore" }).on("close", done))),
    );
    assert.equal(codes.filter((code) => code === 0).length, 1, `exit codes ${codes.join(",")}`);
    assert.equal(codes.filter((code) => code === BUSY).length, 7, `exit codes ${codes.join(",")}`);
  });

  it("waits while the load is above the line, unless told to ignore it", () => {
    const { run, errors } = setup();
    assert.equal(run(["take", "e2e", "--as", "a"], { load: LOAD_MAX + 1 }), BUSY);
    assert.match(errors.at(-1), /load/);
    assert.equal(run(["take", "e2e", "--as", "a", "--ignore-load", "--reason", "test"], { load: LOAD_MAX + 1 }), 0);
  });

  it("scales the load limit with the cores, never below LOAD_MAX, and takes this machine's own setting", () => {
    assert.equal(loadLine(resolveSettings({ env: {}, cores: 2 })), LOAD_MAX);
    assert.equal(loadLine(resolveSettings({ env: {}, cores: 10 })), 10 * LOAD_PER_CORE);
    assert.equal(loadLine(resolveSettings({ env: { BEEFY_SLOT_LOAD_MAX: "12" }, cores: 2 })), 12);
    for (const bad of ["", "0", "-1", "lots"]) assert.equal(loadLine(resolveSettings({ env: { BEEFY_SLOT_LOAD_MAX: bad }, cores: 2 })), LOAD_MAX, bad);
    // A desktop's idle load of 3.4 on 8 cores runs; a forgotten simulator's 350 does not.
    const { run } = setup();
    assert.equal(run(["take", "e2e", "--as", "a"], { load: 3.4, cores: 8 }), 0);
    // Every core busy is not overloaded: 9.5 on 10 cores runs, 10.5 (work queueing) waits.
    assert.equal(run(["take", "build", "--as", "a"], { load: 9.5, cores: 10 }), 0);
    assert.equal(run(["take", "perf", "--as", "a"], { load: 10.5, cores: 10 }), BUSY);
    assert.equal(run(["take", "sim", "--as", "a"], { load: 350, cores: 8 }), BUSY);
  });

  it("names the busiest process when the load refuses", () => {
    const { run, errors } = setup();
    assert.equal(run(["take", "e2e", "--as", "a"], { load: 350, busiest: () => "4242 Simulator (380.5%)" }), BUSY);
    assert.match(errors.at(-1), /load is 350\.0, above the limit of 3\.0; busiest process: 4242 Simulator \(380\.5%\)/);
    // The real ps answers in that shape, or not at all.
    assert.match(busiestProcess(), /^(\d+ .+ \([\d.]+%\))?$/);
  });

  it("run holds the lock for the command, frees it after, and passes its code on", () => {
    const { dir, run } = setup();
    let seen;
    const spawn = (command) => {
      seen = { command, holder: holder(dir, "e2e")?.as };
      return 3;
    };
    assert.equal(run(["run", "e2e", "--as", "a", "--", "pnpm", "e2e"], { spawn }), 3);
    assert.deepEqual(seen, { command: ["pnpm", "e2e"], holder: "a" });
    assert.equal(holder(dir, "e2e"), null);
  });

  it("run never starts the command while someone else holds the lock", () => {
    const { run } = setup();
    run(["take", "e2e", "--as", "a"]);
    let ran = false;
    assert.equal(run(["run", "e2e", "--", "true"], { spawn: () => ((ran = true), 0) }), BUSY);
    assert.equal(ran, false);
  });

  it("refuses bad input with exit 2", () => {
    const { run } = setup();
    for (const argv of [[], ["take", "x"], ["take", "../etc", "--as", "a"], ["take", "x", "--as", "a", "--bogus"], ["run", "x"], ["nope", "x"]]) assert.equal(run(argv), 2, argv.join(" "));
  });
});

const DENY = () => ({ decision: "deny", reason: "no pushes" });

describe("lock run: the sink check", () => {
  it("quotes an argv so a POSIX shell reads back the same words", () => {
    for (const argv of [["git", "push", "-f", "origin", "main"], ["sh", "-c", "echo 'a b'; git push"], ["echo", "", "$(id)", "a\nb", "it's", "--x=y z", "~", "*"]]) {
      const result = spawnSync("/bin/sh", ["-c", `printf '%s\\0' ${quoteCommand(argv)}`], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.stdout.split("\0").slice(0, -1), argv, quoteCommand(argv));
    }
  });

  it("refuses what the judge denies, before taking the lock or spawning", () => {
    const { dir, run, errors } = setup();
    let ran = false;
    assert.equal(run(["run", "e2e", "--", "git", "push", "-f", "origin", "main"], { judge: DENY, spawn: () => ((ran = true), 0) }), 1);
    assert.equal(ran, false);
    assert.equal(holder(dir, "e2e"), null);
    assert.match(errors.at(-1), /refused.*git push -f origin main.*\(deny\): no pushes/);
    assert.match(errors.at(-1), /`run` cannot ask for confirmation, so it does not start a command the judge would deny or ask about\./);
  });

  it("refuses an ask too: lock runs unattended, so nobody can confirm", () => {
    const { run, errors } = setup();
    let ran = false;
    assert.equal(run(["run", "e2e", "--", "gh", "pr", "merge", "1"], { judge: () => ({ decision: "ask", reason: "merge needs the user" }), spawn: () => ((ran = true), 0) }), 1);
    assert.equal(ran, false);
    assert.match(errors.at(-1), /\(ask\): merge needs the user/);
  });

  it("fails closed: a judge that throws, answers oddly, or was never given refuses", () => {
    for (const options of [{ judge: () => { throw new Error("boom"); } }, { judge: () => undefined }, { judge: () => ({ decision: "allow" }) }, { judge: () => "ok" }, { judge: undefined }]) {
      const { run, errors } = setup();
      let ran = false;
      assert.equal(run(["run", "e2e", "--", "echo", "hi"], { spawn: () => ((ran = true), 0), ...options }), 1, JSON.stringify(Object.keys(options)));
      assert.equal(ran, false);
      assert.match(errors.at(-1), /refused/);
    }
  });

  it("says why a judge that failed or answered oddly stops the command", () => {
    assert.match(sinkRefusal(["echo", "hi"], () => { throw new Error("boom"); }), /^the judge failed \(boom\), so `echo hi` is not run$/);
    for (const verdict of [undefined, { decision: "allow" }, "ok"]) {
      assert.match(sinkRefusal(["echo", "hi"], () => verdict), /^the judge returned an answer beefy-slot cannot read for `echo hi`, so it is not run$/);
    }
  });

});
