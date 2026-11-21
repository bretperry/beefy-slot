/*
  Admission for CI jobs: a slot that lives while a worker process does, a reclaim that never takes a live
  record, slot counts and the load limit set by the config, and records written by 0.1.0.
  Run with node --test; real child processes stand in for workers, and time is injected where it can be.
*/
import "./tmpdir.mjs";
import assert from "node:assert/strict";
import { spawn as start, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { BUSY, WORKER_CHECK_SECONDS, bootId, free, holder, main, processInfo, readProcess, resolveSettings, slotsFor, take, validate, workerAlive, workerIdentity, workerState } from "../src/index.mjs";

const CLI = fileURLToPath(new URL("../bin/beefy-slot.mjs", import.meta.url));
const NOW = new Date("2026-11-16T12:00:00Z");

// A fresh lock folder and a quiet in-process main: run(argv, { config, load }) → exit code.
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-admission-"));
  const errors = [];
  const outs = [];
  const run = (argv, { config = {}, load = 0, ...opts } = {}) => main(argv, {
    load, judge: () => null, busiest: () => "", statusHeader: false,
    out: (t) => outs.push(t), err: (t) => errors.push(t), ...opts,
    settings: resolveSettings({ env: { BEEFY_SLOT_LOCK_DIR: dir, BEEFY_SLOT_LOCK_HEARTBEAT_SECONDS: "0.2" }, cores: 2, config, err: () => {} }),
  });
  return { dir, run, errors, outs };
};

// Workers: long-lived children, killed in `after` of each test through `reap`.
const children = [];
const worker = () => {
  const child = start(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  children.push(child);
  return child;
};
const kill = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.on("close", resolve));
  child.kill("SIGKILL");
  await closed;
};
after(async () => {
  for (const child of children.splice(0)) await kill(child);
});

// True when a process with this pid exists.
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

const waitFor = async (check, what, ms = 20_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

// The slot taken by `take` for a worker, as the CLI would record it.
const takeFor = (dir, resource, as, child, extra = {}) => take({ dir, resource, as, worker: workerIdentity(child.pid), now: new Date(), load: 0, ...extra });

// The environment a real CLI call runs in.
const envFor = (dir, extra = {}) => ({ ...process.env, BEEFY_SLOT_LOCK_DIR: dir, BEEFY_SLOT_LOAD_MAX: "1000000", BEEFY_SLOT_LOCK_HEARTBEAT_SECONDS: "0.2", ...extra });

describe("worker identity", () => {
  it("reads a live process's start and this boot, and nothing for a process that is not there", async () => {
    const child = worker();
    const id = await waitFor(() => workerIdentity(child.pid), "the worker's identity");
    assert.equal(id.pid, child.pid);
    assert.match(id.start, /\S/);
    assert.ok(bootId().length > 0, "a boot id");
    assert.equal(id.boot, bootId());
    assert.equal(workerAlive(id), true);
    await kill(child);
    assert.equal(workerAlive(id), false, "a killed worker is gone");
    assert.equal(workerIdentity(child.pid), null);
    assert.equal(processInfo(0), null);
    assert.equal(processInfo(2 ** 30), null);
  });

  it("a reused process ID never looks alive", () => {
    const { dir } = setup();
    const own = workerIdentity(process.pid);
    assert.equal(workerAlive(own), true, "this process, as it is");
    // The same process ID with another start time is a different process that was handed the number.
    assert.equal(workerAlive({ ...own, start: `${own.start}-not` }), false, "another start time");
    assert.equal(workerAlive({ ...own, boot: "other-boot" }), false, "another boot");
    assert.equal(workerAlive({ pid: own.pid }), false, "a record missing its start and boot");
    // In a lock record: the real identity holds the slot; the one with the wrong start frees it at once.
    assert.equal(take({ dir, resource: "ci", as: "a", worker: own, now: NOW, load: 0 }).ok, true);
    assert.equal(take({ dir, resource: "ci", as: "b", worker: workerIdentity(process.pid), now: NOW, load: 0 }).ok, false, "held by a live worker");
    free({ dir, resource: "ci", as: "a" });
    assert.equal(take({ dir, resource: "ci", as: "a", worker: { ...own, start: `${own.start}-not` }, now: NOW, load: 0, alive: () => true }).ok, true, "the take seam lets the record in");
    assert.equal(take({ dir, resource: "ci", as: "b", worker: own, now: NOW, load: 0 }).ok, true, "a record whose process ID was reused is stale");
    assert.equal(holder(dir, "ci").as, "b");
  });

  it("a worker that is only a zombie is not alive", async (t) => {
    // perl forks a child that exits at once and never waits for it, so the child stays a zombie while perl sleeps.
    const probe = spawnSync("perl", ["-e", "0"]);
    if (probe.status !== 0) return t.skip("perl is not installed");
    const parent = start("perl", ["-e", "$| = 1; my $p = fork(); if (!$p) { exit 0 } print \"$p\\n\"; sleep 60"], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(parent);
    let out = "";
    parent.stdout.on("data", (chunk) => (out += chunk));
    const zombie = Number(await waitFor(() => out.trim() || null, "the zombie's pid"));
    await waitFor(() => processInfo(zombie)?.zombie === true, "the child to show as a zombie");
    assert.equal(isAlive(zombie), true, "kill 0 still says a zombie exists");
    assert.equal(workerIdentity(zombie), null, "but it is no worker");
  });
});

describe("take --worker", () => {
  it("records the worker, and a keeper renews the slot after the caller exits, until the worker dies", async () => {
    const { dir } = setup();
    const child = worker();
    await waitFor(() => workerIdentity(child.pid), "the worker");
    const call = spawnSync(process.execPath, [CLI, "take", "ci", "--as", "job-1", "--worker", String(child.pid)], { env: envFor(dir), encoding: "utf8" });
    assert.equal(call.status, 0, call.stderr);
    const first = await waitFor(() => holder(dir, "ci")?.keeper && holder(dir, "ci"), "the keeper to name itself");
    assert.equal(first.worker.pid, child.pid);
    assert.equal(first.worker.boot, bootId());
    // The take is over; the keeper is what renews.
    await waitFor(() => new Date(holder(dir, "ci")?.until ?? 0) > new Date(first.until), "a renewal after the caller exited");
    assert.equal(take({ dir, resource: "ci", as: "other", now: new Date(), load: 0 }).ok, false, "held while the worker lives");
    await kill(child);
    assert.equal(take({ dir, resource: "ci", as: "other", now: new Date(), load: 0 }).ok, true, "free the moment the worker is gone");
    await waitFor(() => !isAlive(first.keeper), "the keeper to stop once its worker is gone");
  });

  it("a repeated take for the same worker refreshes its record and starts no second keeper", async () => {
    const { dir } = setup();
    const child = worker();
    await waitFor(() => workerIdentity(child.pid), "the worker");
    const argv = [CLI, "take", "ci", "--as", "job-1", "--worker", String(child.pid)];
    assert.equal(spawnSync(process.execPath, argv, { env: envFor(dir), encoding: "utf8" }).status, 0);
    const first = await waitFor(() => holder(dir, "ci")?.keeper && holder(dir, "ci"), "the keeper to name itself");
    assert.equal(spawnSync(process.execPath, argv, { env: envFor(dir), encoding: "utf8" }).status, 0, "a retry is a no-op");
    const again = holder(dir, "ci");
    assert.equal(again.id, first.id);
    assert.equal(again.keeper, first.keeper, "the keeper is the same one");
  });

  it("--ttl bounds the keeper, so a worker's slot ends at the ttl", async () => {
    const { dir } = setup();
    const child = worker();
    await waitFor(() => workerIdentity(child.pid), "the worker");
    const call = spawnSync(process.execPath, [CLI, "take", "ci", "--as", "job-1", "--worker", String(child.pid), "--ttl", "1"], { env: envFor(dir), encoding: "utf8" });
    assert.equal(call.status, 0, call.stderr);
    // A real minute is too long to wait: the keeper's own command line shows the end it was given.
    const keeper = await waitFor(() => holder(dir, "ci")?.keeper, "the keeper to name itself");
    const command = spawnSync("ps", ["-o", "command=", "-p", String(keeper)], { encoding: "utf8" }).stdout;
    const until = /--until (\S+)/.exec(command)?.[1];
    assert.ok(until, command);
    assert.ok(Math.abs(Date.parse(until) - (Date.now() + 60_000)) < 30_000, `until ${until}`);
    assert.match(command, new RegExp(`--pid ${child.pid} --start `));
  });

  it("a worker that is not running is refused, with no slot taken", () => {
    const { dir, run, errors } = setup();
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    assert.equal(run(["take", "ci", "--as", "a", "--worker", String(dead.pid)]), 1);
    assert.match(errors.join("\n"), /worker \d+ is not running/);
    assert.equal(holder(dir, "ci"), null);
  });

  it("is for take only, and perf is never taken for a worker", () => {
    const { run } = setup();
    for (const argv of [["status", "--worker", "5"], ["free", "ci", "--as", "a", "--worker", "5"], ["run", "ci", "--worker", "5", "--", "true"], ["waive", "ci", "--as", "a", "--reason", "x", "--worker", "5"]]) assert.equal(run(argv), 2, argv.join(" "));
    assert.equal(run(["take", "perf", "--as", "a", "--worker", String(process.pid)]), 2);
    for (const argv of [["take", "ci", "--as", "a", "--start", "x"], ["take", "ci", "--as", "a", "--boot", "x"], ["keep", "ci", "--id", "i", "--pid", "5", "--dir", "/x", "--every", "1", "--start", "only-start"]]) assert.equal(run(argv), 2, argv.join(" "));
  });

  it("status shows the worker", () => {
    const { dir, run, outs } = setup();
    takeFor(dir, "ci", "job-1", { pid: process.pid });
    assert.equal(run(["status", "ci"]), 0);
    assert.match(outs.join("\n"), new RegExp(`ci: job-1 \\(worker ${process.pid}\\) until `));
  });
});

describe("a waiting take watches its worker", () => {
  it("looks at the worker every 5 s at most, and returns gone once it is", () => {
    const { dir } = setup();
    assert.equal(take({ dir, resource: "ci", as: "other", now: NOW, load: 0 }).ok, true);
    const sleeps = [];
    let up = true;
    const result = take({
      dir, resource: "ci", as: "job", worker: { pid: 1, start: "s", boot: "b" }, wait: 10, pollSeconds: 20, load: 0, reload: () => 0, now: NOW,
      alive: () => up,
      sleep: (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 4) up = false;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.gone, true);
    assert.match(result.reason, /worker 1 is gone \(waited 0 min\)/);
    assert.deepEqual(sleeps, [5000, 5000, 5000, 5000], "a 20 s poll is cut to the worker check");
    assert.equal(WORKER_CHECK_SECONDS, 5);
    assert.equal(holder(dir, "ci").as, "other", "no slot was taken for a dead worker");
  });

  it("gets the slot when it frees, between two worker checks", () => {
    const { dir } = setup();
    take({ dir, resource: "ci", as: "other", now: NOW, load: 0 });
    let looks = 0;
    const result = take({
      dir, resource: "ci", as: "job", worker: { pid: 1, start: "s", boot: "b" }, wait: 10, pollSeconds: 20, load: 0, reload: () => 0, now: NOW, alive: () => true,
      sleep: () => {
        if (++looks === 3) free({ dir, resource: "ci", as: "other" });
      },
    });
    assert.equal(result.ok, true);
    assert.equal(looks, 3);
  });

  it("a real waiting take exits 1 soon after its worker is killed", async () => {
    const { dir } = setup();
    const holderChild = worker();
    await waitFor(() => workerIdentity(holderChild.pid), "the holder's worker");
    assert.equal(spawnSync(process.execPath, [CLI, "take", "ci", "--as", "first", "--worker", String(holderChild.pid)], { env: envFor(dir) }).status, 0);
    const waiter = worker();
    await waitFor(() => workerIdentity(waiter.pid), "the waiter's worker");
    const call = start(process.execPath, [CLI, "take", "ci", "--as", "second", "--worker", String(waiter.pid), "--wait", "5"], { env: envFor(dir, { BEEFY_SLOT_LOCK_POLL_SECONDS: "20" }), stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    call.stderr.on("data", (chunk) => (stderr += chunk));
    const closed = new Promise((resolve) => call.on("close", resolve));
    try {
      // Waiting means its ticket is in the line; a fixed pause is not proof, since a loaded machine can still be starting node.
      await waitFor(() => existsSync(join(dir, "tickets")) && readdirSync(join(dir, "tickets")).some((name) => name.startsWith("ci~")), "the take to queue");
      assert.equal(call.exitCode, null, "still waiting while its worker lives");
      const killedAt = Date.now();
      await kill(waiter);
      assert.equal(await closed, 1);
      assert.ok(Date.now() - killedAt < (WORKER_CHECK_SECONDS + 4) * 1000, `exited ${Date.now() - killedAt} ms after the kill`);
      assert.match(stderr, /worker \d+ is gone/);
      assert.equal(holder(dir, "ci").as, "first", "the first job still holds it");
    } finally {
      if (call.exitCode === null) call.kill("SIGKILL");
    }
  });
});

describe("a take by the same --as", () => {
  it("never reclaims a live record: another worker under the same name is turned away", async () => {
    const { dir } = setup();
    const a = worker();
    const b = worker();
    await waitFor(() => workerIdentity(a.pid) && workerIdentity(b.pid), "both workers");
    assert.equal(takeFor(dir, "ci", "runner-1", a).ok, true);
    const mine = holder(dir, "ci");
    const result = takeFor(dir, "ci", "runner-1", b);
    assert.equal(result.ok, false, "a live worker's record is not the new worker's to take");
    assert.match(result.reason, /held by runner-1/);
    assert.deepEqual(holder(dir, "ci").worker, mine.worker, "the record is untouched");
    // Nor can a take with no worker, which would strip the worker from the record.
    assert.equal(take({ dir, resource: "ci", as: "runner-1", now: new Date(), load: 0 }).ok, false);
    assert.deepEqual(holder(dir, "ci").worker, mine.worker);
  });

  it("a retry by the same worker refreshes its own record and keeps its id", async () => {
    const { dir } = setup();
    const a = worker();
    await waitFor(() => workerIdentity(a.pid), "the worker");
    const first = takeFor(dir, "ci", "runner-1", a);
    const again = takeFor(dir, "ci", "runner-1", a);
    assert.equal(again.ok, true);
    assert.equal(again.refreshed, true);
    assert.equal(again.id, first.id);
  });

  it("reclaims its own dead record at once, and only that", async () => {
    const { dir } = setup();
    const a = worker();
    const b = worker();
    await waitFor(() => workerIdentity(a.pid) && workerIdentity(b.pid), "both workers");
    takeFor(dir, "ci", "runner-1", a, { slots: 2 });
    takeFor(dir, "ci", "runner-2", b, { slots: 2 });
    await kill(a);
    const next = worker();
    await waitFor(() => workerIdentity(next.pid), "the next worker");
    // runner-1's job died; its next job takes under the same name and gets the slot back, not runner-2's.
    const slots = 2;
    const result = takeFor(dir, "ci", "runner-1", next, { slots });
    assert.equal(result.ok, true);
    assert.equal(holder(dir, "ci").worker.pid, next.pid, "the dead record was replaced");
    assert.equal(holder(dir, "ci~1").as, "runner-2");
    assert.equal(holder(dir, "ci~1").worker.pid, b.pid, "a live neighbour keeps its slot");
    const third = worker();
    await waitFor(() => workerIdentity(third.pid), "the third worker");
    assert.equal(takeFor(dir, "ci", "runner-3", third, { slots }).ok, false, "both slots are held by live workers");
  });
});

describe("a slot count from the config", () => {
  const config = (slots, extra = {}) => ({ resources: { ci: { slots, ...extra } } });

  it("is read from resources, for that resource only", () => {
    assert.equal(slotsFor("ci", resolveSettings({ env: {}, config: config(4) })), 4);
    assert.equal(slotsFor("other", resolveSettings({ env: {}, config: config(4) })), 1);
    assert.equal(slotsFor("heavy", resolveSettings({ env: {}, config: { heavySlots: 3, resources: { heavy: { slots: 9 } } } })), 3, "heavy stays heavySlots");
    for (const bad of [0, 17, "x", null, 1.5]) assert.equal(slotsFor("ci", resolveSettings({ env: {}, config: config(bad) })), 1, `slots ${bad}`);
    assert.equal(slotsFor("constructor", resolveSettings({ env: {}, config: {} })), 1);
  });

  it("limits holders to the count, and --slots never sets it", () => {
    const { dir, run, errors } = setup();
    const cfg = config(2, { loadGate: false });
    assert.equal(run(["take", "ci", "--as", "a"], { config: cfg }), 0);
    assert.equal(run(["take", "ci", "--as", "b"], { config: cfg }), 0);
    assert.equal(run(["take", "ci", "--as", "c"], { config: cfg }), BUSY);
    assert.equal(run(["take", "ci", "--as", "d", "--slots", "5"], { config: cfg }), 2);
    assert.match(errors.join("\n"), /ci's slots are the machine's \(resources\.ci\.slots in the config file\), not a flag/);
    assert.equal(run(["run", "ci", "--as", "e", "--slots", "5", "--", "true"], { config: cfg }), 2);
    assert.equal(holder(dir, "ci").as, "a");
    assert.equal(holder(dir, "ci~1").as, "b");
  });

  it("raising the count takes effect on a busy machine, holders and all", () => {
    const { run } = setup();
    assert.equal(run(["take", "ci", "--as", "a"], { config: config(2) }), 0);
    assert.equal(run(["take", "ci", "--as", "b"], { config: config(2) }), 0);
    assert.equal(run(["take", "ci", "--as", "c"], { config: config(2) }), BUSY);
    // a and b took it when it was 2 and are still running; the file now says 4.
    assert.equal(run(["take", "ci", "--as", "c"], { config: config(4) }), 0, "a new slot opens at once");
    assert.equal(run(["take", "ci", "--as", "d"], { config: config(4) }), 0);
    assert.equal(run(["take", "ci", "--as", "e"], { config: config(4) }), BUSY);
  });

  it("the CLI reads the file on every call", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-cli-"));
    const project = mkdtempSync(join(tmpdir(), "ci-project-"));
    mkdirSync(join(project, ".git"));
    const file = join(project, "beefy-slot.json");
    const call = (as) => spawnSync(process.execPath, [CLI, "take", "ci", "--as", as], { cwd: project, env: envFor(dir), encoding: "utf8" });
    writeFileSync(file, JSON.stringify({ lockDir: dir, resources: { ci: { slots: 1 } } }));
    assert.equal(call("a").status, 0);
    assert.equal(call("b").status, BUSY);
    writeFileSync(file, JSON.stringify({ lockDir: dir, resources: { ci: { slots: 2 } } }));
    assert.equal(call("b").status, 0, "the raise is read by the next call");
  });
});

describe("a resource with no load limit", () => {
  it("admits at any load, while heavy and a resource with a gate still wait", () => {
    const { run } = setup();
    const config = { resources: { ci: { slots: 3, loadGate: false }, gated: { slots: 3 } } };
    assert.equal(run(["take", "ci", "--as", "a"], { config, load: 400 }), 0);
    assert.equal(run(["take", "heavy", "--as", "a"], { config, load: 400 }), BUSY, "heavy work keeps the load limit");
    assert.equal(run(["take", "gated", "--as", "a"], { config, load: 400 }), BUSY, "a gate is the default");
    assert.equal(run(["take", "perf", "--as", "a"], { config, load: 400 }), BUSY);
    assert.equal(run(["take", "ci", "--as", "b"], { config, load: 400 }), 0);
  });

  it("a run inside the job, on heavy, still queues on the load limit", () => {
    const { run } = setup();
    const config = { resources: { ci: { loadGate: false } } };
    let inner;
    // The job's command asks for heavy, as a build step would: a separate resource, with the gate.
    const code = run(["run", "ci", "--as", "job", "--", "true"], { config, load: 400, spawn: () => (inner = run(["run", "heavy", "--as", "build", "--", "true"], { config, load: 400, spawn: () => 0 })) && 0 });
    assert.equal(code, 0, "admission does not wait on the load");
    assert.equal(inner, BUSY, "heavy work inside it does");
  });

  it("only an explicit false opens it; true or nothing is the gate", () => {
    const { run } = setup();
    assert.equal(run(["take", "ci", "--as", "a"], { config: { resources: { ci: { loadGate: false } } }, load: 1e9 }), 0);
    assert.equal(run(["take", "ci", "--as", "b"], { config: { resources: { ci: { loadGate: true } } }, load: 1e9 }), BUSY);
  });
});

describe("resources in beefy-slot.json", () => {
  it("accepts slots and loadGate, and refuses the rest, naming the key", () => {
    assert.equal(validate({ resources: {} }), null);
    assert.equal(validate({ resources: { ci: { slots: 4, loadGate: false }, "a:b.c": {} } }), null);
    for (const [resources, pattern] of [
      [[], /resources: expected an object/],
      [null, /resources: expected an object/],
      [{ ci: 1 }, /resources\.ci: expected an object/],
      [{ ci: [] }, /resources\.ci: expected an object/],
      [{ ci: { slot: 2 } }, /resources\.ci\.slot: unknown key/],
      [{ ci: { slots: 0 } }, /resources\.ci\.slots: expected an integer from 1 to 16/],
      [{ ci: { slots: 17 } }, /resources\.ci\.slots/],
      [{ ci: { slots: "2" } }, /resources\.ci\.slots/],
      [{ ci: { loadGate: "no" } }, /resources\.ci\.loadGate: expected true or false/],
      [{ heavy: { slots: 2 } }, /resources\.heavy: heavy is reserved; its slots are set by heavySlots/],
      [{ perf: {} }, /resources\.perf: perf is reserved; its load limit is set by perfLoadMax/],
      [{ "bad name": {} }, /not a resource name/],
      [{ constructor: { slots: 0 } }, /resources\.constructor\.slots/],
    ]) assert.match(validate({ resources }), pattern, JSON.stringify(resources));
  });

  it("a bad resources entry in a file refuses take and names the file and key", () => {
    const project = mkdtempSync(join(tmpdir(), "ci-bad-"));
    mkdirSync(join(project, ".git"));
    writeFileSync(join(project, "beefy-slot.json"), JSON.stringify({ resources: { ci: { slots: 99 } } }));
    const call = spawnSync(process.execPath, [CLI, "take", "ci", "--as", "a"], { cwd: project, env: envFor(mkdtempSync(join(tmpdir(), "ci-locks-"))), encoding: "utf8" });
    assert.equal(call.status, 2);
    assert.match(call.stderr, /beefy-slot\.json: resources\.ci\.slots/);
  });
});

describe("records written by 0.1.0", () => {
  // Exactly the fields 0.1.0 wrote: no worker, no keeper.
  const old = (dir, name, fields) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ resource: name.split("~")[0], slots: 1, at: "2026-11-16T11:59:00.000Z", pid: 4242, ...fields }));
  };
  const future = new Date(Date.now() + 3_600_000).toISOString();

  it("still read: status shows them and a take by another name is turned away", () => {
    const { dir, run, outs } = setup();
    old(dir, "heavy", { as: "old-build", id: "i1", until: future });
    old(dir, "ci", { as: "old-ci", id: "i2", until: future, watch: process.pid });
    assert.equal(run(["status"]), 0);
    assert.match(outs.join("\n"), /heavy: old-build until /);
    assert.match(outs.join("\n"), /ci: old-ci until /);
    assert.equal(holder(dir, "ci").as, "old-ci");
    assert.equal(run(["take", "ci", "--as", "new"]), BUSY);
    assert.equal(takeFor(dir, "ci", "new", { pid: process.pid }).ok, false, "a worker take does not displace a 0.1.0 holder either");
  });

  it("a 0.1.0 holder keeps refreshing and freeing its own record, and a lapsed or dead one is replaced", () => {
    const { dir, run } = setup();
    old(dir, "ci", { as: "old-ci", id: "i2", until: future });
    assert.equal(run(["take", "ci", "--as", "old-ci"]), 0, "its own retry refreshes");
    assert.equal(holder(dir, "ci").id, "i2", "the id it had");
    assert.equal(run(["free", "ci", "--as", "old-ci"]), 0);
    assert.equal(holder(dir, "ci"), null);
    old(dir, "ci", { as: "lapsed", id: "i3", until: "2026-11-16T11:00:00.000Z" });
    assert.equal(run(["take", "ci", "--as", "new"]), 0, "past its time");
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    old(dir, "gone", { as: "run", id: "i4", until: future, watch: dead.pid });
    assert.equal(run(["take", "gone", "--as", "new"]), 0, "a run whose process is gone");
  });

  it("its slots count against a configured pool", () => {
    const { dir, run } = setup();
    old(dir, "ci", { as: "old-1", id: "i1", until: future, slots: 2 });
    old(dir, "ci~1", { as: "old-2", id: "i2", until: future, slots: 2 });
    const config = { resources: { ci: { slots: 2 } } };
    assert.equal(run(["take", "ci", "--as", "new"], { config }), BUSY);
    assert.equal(run(["take", "ci", "--as", "new"], { config: { resources: { ci: { slots: 3 } } } }), 0, "and a raised count opens a slot beside them");
  });

  it("a record this version writes for a worker is one 0.1.0's reader still takes as live", async () => {
    const { dir } = setup();
    const child = worker();
    await waitFor(() => workerIdentity(child.pid), "the worker");
    takeFor(dir, "ci", "job", child);
    const record = holder(dir, "ci");
    for (const field of ["resource", "as", "id", "slots", "at", "until", "pid"]) assert.ok(field in record, field);
    assert.ok(new Date(record.until) > new Date(NOW), "valid under 0.1.0's reader: a string `as` and a parseable `until`");
    const raw = JSON.parse(readFileSync(join(dir, "ci.json"), "utf8"));
    assert.deepEqual(Object.keys(raw).filter((key) => !["resource", "as", "id", "slots", "at", "until", "pid", "worker"].includes(key)), []);
  });
});

describe("a worker's slot without its keeper", () => {
  const MIN = 60_000;

  it("lives while the worker does, whatever the record's time says", async () => {
    const { dir } = setup();
    const child = worker();
    await waitFor(() => workerIdentity(child.pid), "the worker");
    const at = Date.now();
    assert.equal(takeFor(dir, "ci", "a", child, { now: new Date(at), ttl: 2 }).ok, true);
    // The keeper was killed, or the machine slept: the 2-minute record time passed with no renewal.
    const later = new Date(at + 10 * MIN);
    assert.ok(Date.parse(holder(dir, "ci").until) < later.getTime(), "the record's time is up");
    const other = worker();
    await waitFor(() => workerIdentity(other.pid), "the second worker");
    const second = take({ dir, resource: "ci", as: "b", worker: workerIdentity(other.pid), now: later, load: 0 });
    assert.equal(second.ok, false, "a live worker keeps its slot");
    assert.equal(holder(dir, "ci").as, "a");
    await kill(child);
    assert.equal(take({ dir, resource: "ci", as: "b", worker: workerIdentity(other.pid), now: later, load: 0 }).ok, true, "free once the worker is dead");
  });

  it("still ends at the --ttl's end, which the record carries", async () => {
    const { dir } = setup();
    const child = worker();
    await waitFor(() => workerIdentity(child.pid), "the worker");
    const at = Date.now();
    assert.equal(takeFor(dir, "ci", "a", child, { now: new Date(at), ttl: 2 }).ok, true);
    const held = holder(dir, "ci");
    writeFileSync(join(dir, "ci.json"), JSON.stringify({ ...held, cap: new Date(at + 5 * MIN).toISOString() }));
    const later = (minutes) => new Date(at + minutes * MIN);
    assert.equal(take({ dir, resource: "ci", as: "b", now: later(3), load: 0 }).ok, false, "before the end");
    assert.equal(take({ dir, resource: "ci", as: "b", now: later(6), load: 0 }).ok, true, "past the end, though the worker lives");
  });
});

describe("a look at a process that fails", () => {
  const unknown = () => ({ state: "unknown" });

  it("is unknown, not dead: the record's time decides", async () => {
    const { dir } = setup();
    const child = worker();
    const identity = await waitFor(() => workerIdentity(child.pid), "the worker");
    assert.equal(workerState(identity, unknown), "unknown");
    assert.equal(workerState(identity), "alive");
    assert.equal(workerState({ ...identity, start: "other" }), "dead");
    await kill(child);
    assert.equal(readProcess(child.pid).state, "gone");
    assert.equal(workerState(identity), "dead");
  });

  it("does not free a slot whose worker could not be read, until its time is up", async () => {
    const { dir } = setup();
    const child = worker();
    await waitFor(() => workerIdentity(child.pid), "the worker");
    const at = Date.now();
    assert.equal(takeFor(dir, "ci", "a", child, { now: new Date(at), ttl: 2 }).ok, true);
    const ask = (minutes) => take({ dir, resource: "ci", as: "b", now: new Date(at + minutes * 60_000), load: 0, probe: unknown });
    assert.equal(ask(1).ok, false, "a failed look is not a death");
    assert.equal(ask(3).ok, true, "with nothing known, the lapsed time frees it");
  });

  it("does not stop the keeper, which renews through misses and stops only on a dead worker", async () => {
    const { dir, run } = setup();
    const child = worker();
    const identity = await waitFor(() => workerIdentity(child.pid), "the worker");
    const result = takeFor(dir, "ci", "a", child);
    assert.equal(result.ok, true);
    const looks = ["ok", "unknown", "unknown", "unknown", "gone"];
    let sleeps = 0;
    let renewed = 0;
    let until = holder(dir, "ci").until;
    const probe = (pid) => {
      const state = looks.shift();
      return state === "ok" ? readProcess(pid) : { state };
    };
    const code = run(["keep", "ci", "--id", result.id, "--pid", String(child.pid), "--start", identity.start, "--boot", identity.boot, "--dir", dir, "--every", "1"], {
      probe,
      sleep: () => {
        sleeps += 1;
        const now = holder(dir, "ci").until;
        if (now !== until) renewed += 1;
        until = now;
      },
    });
    assert.equal(code, 0);
    assert.equal(sleeps, 4, "it went on through three failed looks and stopped at the dead one");
    assert.ok(renewed >= 1, "and kept renewing");
  });
});

describe("lowering a configured count", () => {
  it("counts live holders in every slot name, so a take cannot join them below the new count", () => {
    const { dir, run, errors } = setup();
    const three = { resources: { ci: { slots: 3, loadGate: false } } };
    const two = { resources: { ci: { slots: 2, loadGate: false } } };
    for (const who of ["a", "b", "c"]) assert.equal(run(["take", "ci", "--as", who], { config: three }), 0);
    assert.equal(run(["free", "ci", "--as", "a"], { config: three }), 0);
    assert.equal(holder(dir, "ci~2").as, "c");
    // b and c still run, in ci~1 and ci~2; the cap is now 2.
    assert.equal(run(["take", "ci", "--as", "d"], { config: two }), BUSY, "two live holders fill a cap of two");
    assert.equal(holder(dir, "ci"), null, "nothing was taken in the free slot");
    assert.match(errors.join("\n"), /all 2 ci slots are held/);
    assert.equal(run(["take", "ci", "--as", "d"], { config: three }), 0, "at the old count there is room");
  });
});
