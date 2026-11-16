/*
  Slots, bounded waits, waivers, heartbeat renewal, and dead-process recovery.
  Run with node --test; load, time, and sleep are injected except in process tests.
  Pools must respect their size, waivers excuse only load, and waits must end.
*/
import "./tmpdir.mjs";
import assert from "node:assert/strict";
import { spawn as start, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { activeWaiver, BUSY, free, HEAVY, HEARTBEAT_TTL_MINUTES, MAX_SLOTS, MAX_WAIT_MINUTES, MAX_WAIVER_MINUTES, PERF, PERF_LOAD_MAX, holder, main, resolveSettings, perfLoadLine, refreshHolder, slotNames, slotsFor, take, WAIVER_TTL_MINUTES, waive } from "../src/index.mjs";

const NOW = new Date("2026-10-20T12:00:00Z");
const later = (minutes) => new Date(NOW.getTime() + minutes * 60_000);

// A fresh lock dir and a quiet main: { run(argv, opts) → code, dir, errors }.
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-slots-"));
  const errors = [];
  const run = (argv, opts = {}) => main(argv, {
    now: NOW, load: 0, judge: () => null, busiest: () => "", statusHeader: false,
    out: () => {}, err: (t) => errors.push(t), ...opts,
    settings: resolveSettings({ env: { BEEFY_SLOT_LOCK_DIR: dir }, cores: 2, ...opts }),
  });
  run.dir = dir;
  return { dir, run, errors };
};

// The arguments of a quiet take on `heavy`, and of a take under a load of 40 against a line of 3.
const taker = (dir, overrides = {}) => ({ dir, resource: "heavy", slots: 1, now: NOW, load: 0, reload: () => 0, ...overrides });
const over = (dir, as, extra = {}) => take({ dir, resource: "heavy", as, slots: 1, now: NOW, load: 40, loadMax: 3, ...extra });

// Polls `check` every 25 ms until it returns a truthy value, then resolves to it. A child process can start late on a
// busy machine, so the real-run tests wait for the state they need instead of a fixed sleep. Throws `what` at the deadline.
const waitFor = async (check, what, ms = 20_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

// Two slots for `heavy`, the way a machine that runs two heavy jobs at once sets it.
const TWO = { BEEFY_SLOT_HEAVY_SLOTS: "2" };

describe("lock slots", () => {
  it("counts a resource's slots: this machine's env, then the project's value, then one; only heavy is a pool", () => {
    assert.equal(slotsFor(HEAVY, resolveSettings({ env: {}, config: {} })), 1, "no setting keeps the one-holder lock");
    assert.equal(slotsFor(HEAVY, resolveSettings({ env: {}, config: { heavySlots: 3 } })), 3);
    assert.equal(slotsFor(HEAVY, resolveSettings({ env: { BEEFY_SLOT_HEAVY_SLOTS: "2" }, config: { heavySlots: 3 } })), 2, "the machine's own value wins");
    for (const bad of ["0", "-1", "1.5", "lots", "", String(MAX_SLOTS + 1)]) assert.equal(slotsFor(HEAVY, resolveSettings({ env: { BEEFY_SLOT_HEAVY_SLOTS: bad }, config: { heavySlots: 3 } })), 3, `env ${bad}`);
    for (const bad of [0, 99, "2", null, 1.5]) assert.equal(slotsFor(HEAVY, resolveSettings({ env: {}, config: { heavySlots: bad } })), bad === "2" ? 2 : 1, `config ${bad}`);
    assert.equal(slotsFor("port-3000", resolveSettings({ env: TWO, config: { heavySlots: 3 } })), 1, "a port stays exclusive");
    assert.deepEqual(slotNames("heavy", 3), ["heavy", "heavy~1", "heavy~2"]);
  });

  it("admits as many holders as there are slots, then answers 75 naming them", () => {
    const { dir, run, errors } = setup();
    const go = (who) => run(["take", "heavy", "--as", who], { env: { BEEFY_SLOT_LOCK_DIR: dir, ...TWO } });
    assert.equal(go("a"), 0);
    assert.equal(go("b"), 0);
    assert.equal(go("a"), 0, "a holder asking again refreshes its own slot, it does not take the second");
    assert.equal(go("c"), BUSY);
    assert.match(errors.at(-1), /all 2 heavy slots are held \(a until .*, b until /);
    assert.deepEqual([holder(dir, "heavy").as, holder(dir, "heavy~1").as], ["a", "b"]);
  });

  it("keeps one holder by default and for any other resource", () => {
    const { run } = setup();
    const one = { BEEFY_SLOT_LOCK_DIR: run.dir, BEEFY_SLOT_HEAVY_SLOTS: "1" };
    assert.equal(run(["take", "heavy", "--as", "a"], { env: one }), 0);
    assert.equal(run(["take", "heavy", "--as", "b"], { env: one }), BUSY);
    assert.equal(run(["take", "port-3000", "--as", "a"], { env: { ...one, ...TWO } }), 0);
    assert.equal(run(["take", "port-3000", "--as", "b"], { env: { ...one, ...TWO } }), BUSY);
    assert.equal(run(["take", "sim", "--as", "a", "--slots", "2"]), 0, "--slots gives any resource a pool");
    assert.equal(run(["take", "sim", "--as", "b", "--slots", "2"]), 0);
    assert.equal(run(["take", "sim", "--as", "c", "--slots", "2"]), BUSY);
  });

  it("frees only the slots that are yours, and lets the next waiter in", () => {
    const { dir, run } = setup();
    const env = { BEEFY_SLOT_LOCK_DIR: dir, ...TWO };
    run(["take", "heavy", "--as", "a"], { env });
    run(["take", "heavy", "--as", "b"], { env });
    assert.equal(run(["free", "heavy", "--as", "c"], { env }), 1, "someone else cannot free it");
    assert.equal(run(["free", "heavy", "--as", "b"], { env }), 0);
    assert.equal(holder(dir, "heavy~1"), null);
    assert.equal(holder(dir, "heavy").as, "a", "a's slot stays");
    assert.equal(run(["take", "heavy", "--as", "c"], { env }), 0);
    assert.equal(free({ dir, resource: "heavy", as: "nobody", now: NOW }).ok, false);
    assert.equal(free({ dir, resource: "idle", as: "nobody", now: NOW }).ok, true, "freeing what is free is fine");
  });

  it("run takes the second slot while the first is held, frees only that slot after, and passes the command's code on", () => {
    const { dir, run } = setup();
    const env = { BEEFY_SLOT_LOCK_DIR: dir, ...TWO };
    const real = new Date();
    run(["take", "heavy", "--as", "a"], { env, now: real });
    let inside;
    assert.equal(run(["run", "heavy", "--as", "b", "--", "pnpm", "e2e"], { env, now: real, spawn: () => ((inside = holder(dir, "heavy~1")?.as), 4) }), 4);
    assert.equal(inside, "b");
    assert.equal(holder(dir, "heavy~1"), null);
    assert.equal(holder(dir, "heavy").as, "a");
  });

  it("run answers 75 without starting the command when every slot is held", () => {
    const { dir, run } = setup();
    const env = { BEEFY_SLOT_LOCK_DIR: dir, ...TWO };
    run(["take", "heavy", "--as", "a"], { env });
    run(["take", "heavy", "--as", "b"], { env });
    assert.equal(run(["run", "heavy", "--as", "c", "--", "true"], { env, spawn: () => assert.fail("ran") }), BUSY);
  });

  it("two runs under one name are two holders: the first finishing does not free the second", () => {
    const { dir, run } = setup();
    const env = { BEEFY_SLOT_LOCK_DIR: dir, ...TWO };
    const real = new Date();
    const seen = [];
    const code = run(["run", "heavy", "--as", "x", "--", "outer"], {
      env,
      now: real,
      spawn: () => {
        seen.push([holder(dir, "heavy")?.id, holder(dir, "heavy~1")?.id]);
        // A second run under the same name, from outside the first (its environment is not the first's).
        const inner = run(["run", "heavy", "--as", "x", "--", "inner"], { env, now: real, spawn: () => ((seen.push([holder(dir, "heavy")?.id, holder(dir, "heavy~1")?.id]), 0)) });
        seen.push([holder(dir, "heavy")?.id, holder(dir, "heavy~1")?.id, inner]);
        return 0;
      },
    });
    assert.equal(code, 0);
    const [outer, both, after] = seen;
    assert.ok(outer[0] && !outer[1]);
    assert.ok(both[0] === outer[0] && both[1] && both[1] !== both[0], "the inner run took its own slot");
    assert.deepEqual([after[0], after[1]], [outer[0], undefined], "the inner run freed only its own");
    assert.equal(holder(dir, "heavy"), null, "and the outer freed its own after");
  });

  it("the guard still judges a command inside a run that holds the lock", () => {
    const { dir, run } = setup();
    const env = { BEEFY_SLOT_LOCK_DIR: dir, BEEFY_SLOT_HEAVY_SLOTS: "1" };
    const real = new Date();
    let ran = false;
    run(["run", "heavy", "--as", "outer", "--", "x"], {
      env,
      now: real,
      spawn: (_command, { env: child }) => {
        const code = run(["run", "heavy", "--as", "inner", "--", "git", "push"], { env: { ...child }, now: real, judge: () => ({ decision: "deny", reason: "no" }), spawn: () => ((ran = true), 0) });
        assert.equal(code, 1);
        return 0;
      },
    });
    assert.equal(ran, false);
  });

  it("a command inside a run does not wait on the lock its parent holds", () => {
    const { dir, run } = setup();
    const env = { BEEFY_SLOT_LOCK_DIR: dir, BEEFY_SLOT_HEAVY_SLOTS: "1" };
    const real = new Date();
    let nested;
    run(["run", "heavy", "--as", "outer", "--", "x"], {
      env,
      now: real,
      spawn: (_command, { env: child }) => {
        nested = run(["run", "heavy", "--as", "inner", "--", "y"], { env: { ...child }, now: real, spawn: () => 7 });
        assert.equal(run(["run", "heavy", "--as", "stranger", "--", "y"], { env, now: real, spawn: () => 7 }), BUSY, "without the parent's environment it still queues");
        return 0;
      },
    });
    assert.equal(nested, 7);
  });

  it("lists every holder in status", () => {
    const { dir, run } = setup();
    const env = { BEEFY_SLOT_LOCK_DIR: dir, ...TWO };
    run(["take", "heavy", "--as", "a"], { env });
    run(["take", "heavy", "--as", "b"], { env });
    const lines = [];
    run(["status"], { env, out: (t) => lines.push(t) });
    assert.match(lines.join("\n"), /^heavy: a until .*\nheavy~1: b until /);
  });

  it("refuses bad slot and wait values", () => {
    const { run } = setup();
    for (const argv of [["take", "x", "--as", "a", "--slots", "0"], ["take", "x", "--as", "a", "--slots", String(MAX_SLOTS + 1)], ["take", "x", "--as", "a", "--wait", "soon"], ["take", "x", "--as", "a", "--wait", "-1"]]) assert.equal(run(argv), 2, argv.join(" "));
  });
});

describe("lock queue", () => {
  it("looks again every poll until a slot frees, then takes it", () => {
    const { dir } = setup();
    take({ ...taker(dir), as: "a" });
    const slept = [];
    const taken = take({ ...taker(dir), as: "b", wait: 5, pollSeconds: 20, sleep: (ms) => (slept.push(ms), slept.length === 3 && free({ dir, resource: "heavy", as: "a" })) });
    assert.equal(taken.ok, true);
    assert.deepEqual(slept, [20_000, 20_000, 20_000]);
    assert.equal(holder(dir, "heavy").as, "b");
  });

  it("gives up when the minutes run out, with the last answer and how long it waited", () => {
    const { dir } = setup();
    take({ ...taker(dir), as: "a", ttl: 600 });
    const slept = [];
    const result = take({ ...taker(dir), as: "b", wait: 1, pollSeconds: 25, sleep: (ms) => slept.push(ms) });
    assert.equal(result.ok, false);
    assert.match(result.reason, /heavy is held by a.*\(waited 1 min\)$/);
    assert.deepEqual(slept, [25_000, 25_000, 10_000], "the last sleep stops at the deadline");
  });

  it("does not wait when asked not to", () => {
    const { dir } = setup();
    take({ ...taker(dir), as: "a" });
    assert.equal(take({ ...taker(dir), as: "b", sleep: () => assert.fail("slept") }).ok, false);
  });

  it("waits out a high load, reading it fresh each time", () => {
    const { dir } = setup();
    const loads = [9, 8, 2];
    const result = take({ ...taker(dir), as: "a", load: 10, loadMax: 3, wait: 5, pollSeconds: 30, sleep: () => {}, reload: () => loads.shift() });
    assert.equal(result.ok, true);
    assert.deepEqual(loads, []);
  });

  it("counts the time it slept, so a lock that expires meanwhile is taken", () => {
    const { dir } = setup();
    take({ ...taker(dir), as: "a", ttl: 1 });
    assert.equal(take({ ...taker(dir), as: "b", wait: 2, pollSeconds: 45, sleep: () => {} }).ok, true);
    assert.equal(holder(dir, "heavy").as, "b");
  });

  it("a process waiting on the command line gets in when the holder frees", async () => {
    const { dir } = setup();
    take({ ...taker(dir, { now: new Date() }), as: "a" });
    const env = { ...process.env, BEEFY_SLOT_LOCK_DIR: dir, BEEFY_SLOT_LOAD_MAX: "1000000", BEEFY_SLOT_LOCK_POLL_SECONDS: "0.1" };
    const child = start(process.execPath, ["bin/beefy-slot.mjs", "take", "heavy", "--as", "b", "--wait", "1"], { env, stdio: "ignore" });
    const done = new Promise((resolve) => child.on("close", resolve));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(free({ dir, resource: "heavy", as: "a" }).ok, true);
    assert.equal(await done, 0);
    assert.equal(holder(dir, "heavy").as, "b");
  });
});

describe("lock waivers", () => {
  it("lets a recorded waiver past the load line, and writes it into the lock it grants", () => {
    const { dir } = setup();
    assert.equal(over(dir, "a").ok, false);
    assert.equal(waive({ dir, resource: "heavy", as: "a", reason: "owner OK: perf is idle", now: NOW }).ok, true);
    assert.equal(over(dir, "a").ok, true);
    assert.deepEqual(holder(dir, "heavy").waived, { reason: "owner OK: perf is idle", at: NOW.toISOString() });
  });

  it("covers only the one holder it names and only until it expires", () => {
    const { dir } = setup();
    waive({ dir, resource: "heavy", as: "a", reason: "r", ttl: 10, now: NOW });
    assert.equal(activeWaiver(dir, "heavy", "b", NOW), null);
    assert.equal(over(dir, "b").ok, false, "another holder is still turned away");
    assert.equal(over(dir, "a", { now: later(11) }).ok, false, "past its life it is gone");
    assert.equal(over(dir, "a", { now: later(9) }).ok, true);
  });

  it("two waivers for two holders both stand", () => {
    const { dir } = setup();
    waive({ dir, resource: "heavy", as: "a", reason: "r", now: NOW });
    waive({ dir, resource: "heavy", as: "feat/b", reason: "r", now: NOW });
    assert.ok(activeWaiver(dir, "heavy", "a", NOW) && activeWaiver(dir, "heavy", "feat/b", NOW));
  });

  it("never opens a full resource: only the load line is waived", () => {
    const { dir } = setup();
    take({ dir, resource: "heavy", as: "a", now: NOW, load: 0 });
    waive({ dir, resource: "heavy", as: "b", reason: "r", now: NOW });
    const result = over(dir, "b");
    assert.equal(result.ok, false);
    assert.match(result.reason, /heavy is held by a/);
  });

  it("is recorded in waivers.log and shown by status, and needs a reason and a bounded life", () => {
    const { dir, run, errors } = setup();
    assert.equal(run(["waive", "heavy", "--as", "a", "--reason", "owner OK"]), 0);
    assert.equal(run(["waive", "heavy", "--as", "a"]), 2, "no reason");
    assert.equal(run(["waive", "heavy", "--reason", "x"]), 2, "no holder");
    assert.equal(run(["waive", "heavy", "--as", "a", "--reason", "x", "--ttl", String(MAX_WAIVER_MINUTES + 1)]), 2);
    assert.match(errors.at(-1), /1 to 120 minutes/);
    const log = readFileSync(join(dir, "waivers.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(log.length, 1);
    assert.equal(log[0].until, new Date(NOW.getTime() + WAIVER_TTL_MINUTES * 60_000).toISOString());
    const lines = [];
    run(["status"], { out: (t) => lines.push(t) });
    assert.match(lines[0], /waiver for a: owner OK until /);
    assert.equal(waive({ dir, resource: "heavy", as: "a", reason: "  " }).ok, false);
  });

  it("run and take on the command line honor it, and --ignore-load is recorded the same way", () => {
    const { dir, run } = setup();
    assert.equal(run(["take", "heavy", "--as", "a"], { load: 40 }), BUSY);
    run(["waive", "heavy", "--as", "a", "--reason", "owner OK"]);
    assert.equal(run(["take", "heavy", "--as", "a"], { load: 40 }), 0);
    assert.equal(holder(dir, "heavy").waived.reason, "owner OK");
    assert.equal(run(["take", "other", "--as", "b", "--ignore-load", "--reason", "owner OK too"], { load: 40 }), 0);
    assert.equal(holder(dir, "other").waived.reason, "owner OK too");
  });
});

const PERF_ENV = (dir, extra = {}) => ({ BEEFY_SLOT_LOCK_DIR: dir, BEEFY_SLOT_PERF_LOAD_MAX: "1.5", ...extra });

describe("lock: perf is reserved inside the lock", () => {
  it("resolves the perf line itself: env, then the project's value, then 1.5", () => {
    assert.equal(PERF_LOAD_MAX, 1.5);
    assert.equal(perfLoadLine(resolveSettings({ env: {}, config: {} })), 1.5);
    assert.equal(perfLoadLine(resolveSettings({ env: {}, config: { perfLoadMax: 2 } })), 2);
    assert.equal(perfLoadLine(resolveSettings({ env: { BEEFY_SLOT_PERF_LOAD_MAX: "1" }, config: { perfLoadMax: 2 } })), 1);
    for (const bad of ["0", "-1", "quiet", ""]) assert.equal(perfLoadLine(resolveSettings({ env: { BEEFY_SLOT_PERF_LOAD_MAX: bad }, config: {} })), 1.5, bad);
  });

  it("a plain `take perf` waits at 1.5 where another resource at the same load (2 on 2 cores) runs", () => {
    const { dir, run } = setup();
    assert.equal(run(["take", PERF, "--as", "a"], { env: PERF_ENV(dir), load: 2 }), BUSY);
    assert.equal(run(["take", "e2e", "--as", "a"], { env: PERF_ENV(dir), load: 2 }), 0);
    assert.equal(run(["take", PERF, "--as", "a"], { env: PERF_ENV(dir), load: 1.4 }), 0);
  });

  it("the load line for perf is not BEEFY_SLOT_LOAD_MAX", () => {
    const { dir, run } = setup();
    assert.equal(run(["take", PERF, "--as", "a"], { env: PERF_ENV(dir, { BEEFY_SLOT_LOAD_MAX: "1000" }), load: 2 }), BUSY);
  });

  it("refuses --ignore-load and --slots on perf at the lock itself, with or without a reason", () => {
    const { dir, run, errors } = setup();
    for (const argv of [["take", PERF, "--as", "a", "--ignore-load"], ["take", PERF, "--as", "a", "--ignore-load", "--reason", "x"], ["take", PERF, "--as", "a", "--slots", "2"], ["run", PERF, "--as", "a", "--ignore-load", "--reason", "x", "--", "true"], ["run", PERF, "--as", "a", "--slots", "2", "--", "true"]]) {
      assert.equal(run(argv, { env: PERF_ENV(dir), load: 40, spawn: () => assert.fail("ran") }), 2, argv.join(" "));
    }
    assert.match(errors.at(-1), /not accepted/);
    assert.equal(holder(dir, PERF), null);
  });

  it("a recorded waiver gets one holder past the perf line", () => {
    const { dir, run } = setup();
    assert.equal(run(["take", PERF, "--as", "a"], { env: PERF_ENV(dir), load: 9 }), BUSY);
    assert.equal(run(["waive", PERF, "--as", "a", "--reason", "owner OK"], { env: PERF_ENV(dir) }), 0);
    assert.equal(run(["take", PERF, "--as", "a"], { env: PERF_ENV(dir), load: 9 }), 0);
  });
});

describe("lock: a take never breaks a holder who took the resource for fewer", () => {
  it("--slots 2 on a resource held with one slot is turned away, and the holder keeps it", () => {
    const { dir, run, errors } = setup();
    assert.equal(run(["take", "port-3000", "--as", "a"]), 0);
    assert.equal(run(["take", "port-3000", "--as", "b", "--slots", "2"]), BUSY);
    assert.match(errors.at(-1), /held by a .* who took it with 1 slot; a take for 2 cannot share it/);
    assert.equal(holder(dir, "port-3000").as, "a");
    assert.equal(holder(dir, "port-3000~1"), null);
  });

  it("a take for 16 never beats a holder who took it for 1", () => {
    const { dir } = setup();
    assert.equal(take({ dir, resource: "sim", as: "a", slots: 1, now: NOW, load: 0 }).ok, true);
    assert.equal(take({ dir, resource: "sim", as: "b", slots: MAX_SLOTS, now: NOW, load: 0 }).ok, false);
  });

  it("records the count in each holder's file, and holds a later taker to the smallest", () => {
    const { dir, run } = setup();
    assert.equal(run(["take", "sim", "--as", "a", "--slots", "3"]), 0);
    assert.equal(holder(dir, "sim").slots, 3);
    assert.equal(run(["take", "sim", "--as", "b", "--slots", "2"]), 0);
    assert.equal(holder(dir, "sim~1").slots, 2, "b took it for 2, so it can share only two");
    assert.equal(run(["take", "sim", "--as", "c", "--slots", "3"]), BUSY, "c asked for 3 but b recorded 2");
    assert.equal(holder(dir, "sim~2"), null);
  });

  it("refuses --slots on heavy: its count is the machine's", () => {
    const { dir, run, errors } = setup();
    assert.equal(run(["take", HEAVY, "--as", "a", "--slots", "16"], { env: { BEEFY_SLOT_LOCK_DIR: dir } }), 2);
    assert.match(errors.at(-1), /heavy's slots are the machine's/);
    assert.equal(run(["run", HEAVY, "--as", "a", "--slots", "2", "--", "true"], { env: { BEEFY_SLOT_LOCK_DIR: dir }, spawn: () => assert.fail("ran") }), 2);
    assert.equal(holder(dir, HEAVY), null);
  });
});

describe("lock: unreadable and other people's records", () => {
  it("free clears an unreadable record, and a take can use the slot again", () => {
    const { dir, run } = setup();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "heavy.json"), "");
    assert.equal(run(["free", HEAVY, "--as", "a"]), 0);
    assert.equal(existsSync(join(dir, "heavy.json")), false);
    assert.equal(run(["take", HEAVY, "--as", "a"]), 0);
  });

  it("a take clears an unreadable record itself", () => {
    const { dir, run } = setup();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sim.json"), "{ half a rec");
    assert.equal(run(["take", "sim", "--as", "a"]), 0);
    assert.equal(holder(dir, "sim").as, "a");
  });

  it("a refresh leaves a whole record and no scratch file", () => {
    const { dir, run } = setup();
    run(["take", "sim", "--as", "a"]);
    run(["take", "sim", "--as", "a"]);
    assert.equal(holder(dir, "sim").as, "a");
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
  });

  it("free never removes someone else's record, stale or not", () => {
    const { dir } = setup();
    take({ dir, resource: "sim", as: "old", ttl: 1, now: NOW, load: 0 });
    // old's lock is stale at +5; a free by someone who holds nothing leaves it for the next taker's guarded takeover.
    assert.equal(free({ dir, resource: "sim", as: "other", now: later(5) }).ok, true);
    assert.equal(holder(dir, "sim").as, "old");
    // A fresh lock another taker made is untouched too.
    take({ dir, resource: "sim", as: "new", now: later(5), load: 0 });
    assert.equal(free({ dir, resource: "sim", as: "other", now: later(5) }).ok, false);
    assert.equal(holder(dir, "sim").as, "new");
  });
});

const live = (dir, as, ttl = HEARTBEAT_TTL_MINUTES) => take({ dir, resource: "sim", as, id: `id-${as}`, watch: process.pid, ttl, now: NOW, load: 0 });

describe("lock: a run keeps its slot for as long as it lives and not a minute after", () => {
  it("a renewal carries a lock past the TTL it was taken with", () => {
    const { dir } = setup();
    live(dir, "a");
    const other = (minutes) => take({ dir, resource: "sim", as: "b", now: later(minutes), load: 0 }).ok;
    assert.equal(other(1), false);
    assert.equal(refreshHolder({ dir, resource: "sim", id: "id-a", now: later(1.5) }), true);
    assert.equal(other(3), false, "renewed at +1.5, good until +3.5");
    // Renewed every half minute for an hour and more: still its own, past the hour a plain TTL would end it.
    for (let minute = 2; minute <= 62; minute += 0.5) assert.equal(refreshHolder({ dir, resource: "sim", id: "id-a", now: later(minute) }), true, `at +${minute}`);
    assert.equal(other(62.4), false, "a run at +62 minutes still holds it while it keeps renewing");
    assert.equal(other(65), true, "and it is free a couple of minutes after the renewals stop");
  });

  it("without renewals the lock is gone after the short TTL", () => {
    const { dir } = setup();
    live(dir, "a");
    assert.equal(take({ dir, resource: "sim", as: "b", now: later(HEARTBEAT_TTL_MINUTES + 0.1), load: 0 }).ok, true);
    assert.equal(refreshHolder({ dir, resource: "sim", id: "id-a", now: later(3) }), false, "and a late renewal can't bring it back over b's");
    assert.equal(holder(dir, "sim").as, "b");
  });

  it("a run whose process is gone frees the lock at once", () => {
    const { dir } = setup();
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    assert.equal(dead.status, 0);
    // A pid that has exited (the child's own, now reaped).
    take({ dir, resource: "sim", as: "a", id: "x", watch: dead.pid, ttl: 60, now: NOW, load: 0 });
    assert.equal(take({ dir, resource: "sim", as: "b", now: NOW, load: 0 }).ok, true);
    // The same record with this live process as its run holds.
    take({ dir, resource: "held", as: "a", id: "y", watch: process.pid, ttl: 60, now: NOW, load: 0 });
    assert.equal(take({ dir, resource: "held", as: "b", now: NOW, load: 0 }).ok, false);
  });

  for (const configOnly of [false, true]) it(`a real run renews its record while the command lives, and frees it after (${configOnly ? "config" : "env"} folder)`, async () => {
    const { dir } = setup();
    const env = { ...process.env, BEEFY_SLOT_LOAD_MAX: "1000000", BEEFY_SLOT_LOCK_HEARTBEAT_SECONDS: "0.2" };
    const project = mkdtempSync(join(tmpdir(), "keeper-project-"));
    mkdirSync(join(project, ".git"));
    if (configOnly) {
      delete env.BEEFY_SLOT_LOCK_DIR;
      writeFileSync(join(project, "beefy-slot.json"), JSON.stringify({ lockDir: dir }));
    } else env.BEEFY_SLOT_LOCK_DIR = dir;
    // The command lives until the test has seen the renewal: it exits once the marker file exists. A 30 s cap keeps a failed test from leaving it running.
    const marker = join(dir, "beat-seen");
    const command = "const fs = require('node:fs'); const end = Date.now() + 30000; const t = setInterval(() => { if (fs.existsSync(process.argv[1]) || Date.now() > end) clearInterval(t); }, 25);";
    const child = start(process.execPath, [fileURLToPath(new URL("../bin/beefy-slot.mjs", import.meta.url)), "run", "beat", "--as", "a", "--", process.execPath, "-e", command, marker], { env, cwd: project, stdio: "ignore" });
    const done = new Promise((resolve) => child.on("close", resolve));
    try {
      const first = await waitFor(() => holder(dir, "beat"), "beat's lock to be taken");
      assert.equal(first.as, "a");
      assert.equal(first.watch, child.pid);
      await waitFor(() => new Date(holder(dir, "beat")?.until ?? 0) > new Date(first.until), "beat's lock to be renewed");
      assert.ok(new Date(holder(dir, "beat").until) > new Date(first.until), "renewed");
      writeFileSync(marker, "");
      assert.equal(await done, 0);
      assert.equal(holder(dir, "beat"), null);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });

  it("a killed run frees its lock at once: the next taker gets it", async () => {
    const { dir } = setup();
    const env = { ...process.env, BEEFY_SLOT_LOCK_DIR: dir, BEEFY_SLOT_LOAD_MAX: "1000000", BEEFY_SLOT_LOCK_HEARTBEAT_SECONDS: "0.2" };
    const child = start(process.execPath, ["bin/beefy-slot.mjs", "run", "dead", "--as", "a", "--", process.execPath, "-e", "setTimeout(() => {}, 4000)"], { env, stdio: "ignore" });
    const closed = new Promise((resolve) => child.on("close", resolve));
    try {
      await waitFor(() => holder(dir, "dead")?.as === "a", "dead's lock to be taken");
      assert.equal(holder(dir, "dead").as, "a");
      child.kill("SIGKILL");
      await closed;
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    assert.equal(take({ dir, resource: "dead", as: "b", now: new Date(), load: 0 }).ok, true, "a dead run does not hold the lock for an hour");
  });
});

const lines = (dir) => readFileSync(join(dir, "waivers.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

describe("lock: waivers are logged and capped", () => {
  it("--ignore-load needs a reason", () => {
    const { run, errors } = setup();
    assert.equal(run(["take", "e2e", "--as", "a", "--ignore-load"], { load: 40 }), 2);
    assert.match(errors.at(-1), /needs --reason/);
    assert.equal(run(["run", "e2e", "--as", "a", "--ignore-load", "--", "true"], { load: 40, spawn: () => assert.fail("ran") }), 2);
  });

  it("--ignore-load leaves a log line with its reason when it got the take through, and none when the load was fine", () => {
    const { dir, run } = setup();
    assert.equal(run(["take", "quiet", "--as", "a", "--ignore-load", "--reason", "not needed"], { load: 0 }), 0);
    assert.equal(existsSync(join(dir, "waivers.log")), false, "nothing was ignored");
    assert.equal(run(["take", "e2e", "--as", "a", "--ignore-load", "--reason", "owner OK"], { load: 40 }), 0);
    const [entry] = lines(dir);
    assert.deepEqual([entry.kind, entry.resource, entry.as, entry.reason], ["ignore-load", "e2e", "a", "owner OK"]);
  });

  it("a refused take logs nothing", () => {
    const { dir, run } = setup();
    run(["take", "e2e", "--as", "holder"]);
    assert.equal(run(["take", "e2e", "--as", "b", "--ignore-load", "--reason", "x"], { load: 40 }), BUSY);
    assert.equal(existsSync(join(dir, "waivers.log")), false);
  });

  it("renewing a live waiver keeps its first start and stops at the cap, logging each", () => {
    const { dir } = setup();
    assert.equal(waive({ dir, resource: "heavy", as: "a", reason: "r", ttl: 100, now: NOW }).ok, true);
    assert.equal(waive({ dir, resource: "heavy", as: "a", reason: "r", ttl: 30, now: later(90) }).ok, true, "to +120, the cap");
    const refused = waive({ dir, resource: "heavy", as: "a", reason: "r", ttl: 30, now: later(100) });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /since 2026-10-20T12:00:00\.000Z.*may not run past 120 minutes/);
    assert.equal(activeWaiver(dir, "heavy", "a", later(119)).first, NOW.toISOString());
    const log = lines(dir);
    assert.deepEqual(log.map((entry) => [entry.kind, entry.renewed]), [["waive", false], ["waive", true]]);
    // After it lapses, a new chain starts.
    assert.equal(waive({ dir, resource: "heavy", as: "a", reason: "r", now: later(125) }).ok, true);
  });
});

describe("lock: a wait has an upper limit", () => {
  it("exits 2 above MAX_WAIT_MINUTES, for huge and non-finite values too", () => {
    const { run, errors } = setup();
    assert.equal(run(["take", "x", "--as", "a", "--wait", String(MAX_WAIT_MINUTES)]), 0);
    for (const value of [String(MAX_WAIT_MINUTES + 1), "99999999999999999999999", "Infinity", "NaN", "1e9"]) assert.equal(run(["take", "y", "--as", "a", "--wait", value]), 2, value);
    assert.match(errors.at(-1), /--wait is 0 to 240 minutes|usage/);
    assert.equal(run(["run", "z", "--as", "a", "--wait", String(MAX_WAIT_MINUTES + 1), "--", "true"], { spawn: () => assert.fail("ran") }), 2);
  });

  it("take() refuses a wait it was handed above the limit, or not a number", () => {
    const { dir } = setup();
    for (const wait of [MAX_WAIT_MINUTES + 1, Number.POSITIVE_INFINITY, Number.NaN, -1]) assert.equal(take({ dir, resource: "x", as: "a", wait, now: NOW, load: 0 }).ok, false, String(wait));
  });
});

describe("lock: status shows every slot and waiver of the resource asked about", () => {
  it("status heavy lists a holder that is only in the second slot", () => {
    const { dir, run } = setup();
    const env = { BEEFY_SLOT_LOCK_DIR: dir, ...TWO };
    run(["take", HEAVY, "--as", "a"], { env });
    run(["take", HEAVY, "--as", "b"], { env });
    run(["free", HEAVY, "--as", "a"], { env });
    const out = [];
    run(["status", HEAVY], { env, out: (t) => out.push(t) });
    assert.match(out.join("\n"), /^heavy~1: b until /);
  });

  it("status of a resource shows its live waiver", () => {
    const { dir, run } = setup();
    run(["waive", PERF, "--as", "a", "--reason", "owner OK"]);
    const out = [];
    run(["status", PERF], { out: (t) => out.push(t) });
    assert.match(out.join("\n"), /waiver for a: owner OK until /);
    out.length = 0;
    run(["status", "heavy"], { out: (t) => out.push(t) });
    assert.equal(out.join("\n"), "no locks held", "and not another resource's");
    assert.ok(dir);
  });
});

describe("lock: the wait reads the clock", () => {
  it("counts real elapsed time from a clock, not the sleep it asked for", () => {
    const { dir } = setup();
    take({ dir, resource: "sim", as: "a", ttl: 600, now: NOW, load: 0 });
    let ticks = 0;
    // Each look is 90 s later than the last, however short the sleep was.
    const clock = () => new Date(NOW.getTime() + ticks++ * 90_000);
    const slept = [];
    const result = take({ dir, resource: "sim", as: "b", wait: 5, pollSeconds: 1, clock, sleep: (ms) => slept.push(ms), reload: () => 0 });
    assert.equal(result.ok, false);
    assert.ok(slept.length <= 4, `slept ${slept.length} times: the clock, not the sleeps, ended the wait`);
    assert.match(result.reason, /\(waited [3-9] min\)$/);
  });

  it("takes a lock that expired by the clock while it waited", () => {
    const { dir } = setup();
    take({ dir, resource: "sim", as: "a", ttl: 1, now: NOW, load: 0 });
    let ticks = 0;
    const clock = () => new Date(NOW.getTime() + ticks++ * 40_000);
    assert.equal(take({ dir, resource: "sim", as: "b", wait: 5, clock, sleep: () => {}, reload: () => 0 }).ok, true);
  });
});

describe("lock: many takers, few slots", () => {
  it("N processes racing for M slots: exactly M win, the rest answer 75", async () => {
    const { dir } = setup();
    const env = { ...process.env, BEEFY_SLOT_LOCK_DIR: dir, BEEFY_SLOT_LOAD_MAX: "1000000", BEEFY_SLOT_HEAVY_SLOTS: "3" };
    const codes = await Promise.all(Array.from({ length: 9 }, (_, i) => new Promise((resolve) => start(process.execPath, ["bin/beefy-slot.mjs", "take", HEAVY, "--as", `p${i}`], { env, stdio: "ignore" }).on("close", resolve))));
    assert.equal(codes.filter((code) => code === 0).length, 3, `exit codes ${codes.join(",")}`);
    assert.equal(codes.filter((code) => code === BUSY).length, 6, `exit codes ${codes.join(",")}`);
    const holders = slotNames(HEAVY, 3).map((name) => holder(dir, name)?.as);
    assert.equal(new Set(holders).size, 3, `three different holders in three slots: ${holders.join(",")}`);
  });
});
