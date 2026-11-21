// Detached jobs: `beefy -d`, jobs, log, cancel, retention; and a wrapper that is signalled or killed.
import "./tmpdir.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { refreshHolder, take, workerIdentity } from "../src/beefy-slot.mjs";
import { listJobs, prune } from "../src/jobs.mjs";

const CLI = fileURLToPath(new URL("../bin/beefy-slot.mjs", import.meta.url));
const folders = [];
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "jobs-"));
  folders.push(dir);
  return dir;
};
const env = (dir) => ({ ...process.env, BEEFY_SLOT_LOCK_DIR: dir, BEEFY_SLOT_LOAD_MAX: "1000000", BEEFY_SLOT_LOCK_POLL_SECONDS: "1", BEEFY_SLOT_LOCK_HEARTBEAT_SECONDS: "1" });
const beefy = (dir, args) => spawnSync(process.execPath, [CLI, ...args], { env: env(dir), encoding: "utf8" });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out");
    await wait(50);
  }
};
const jobs = (dir) => JSON.parse(beefy(dir, ["jobs", "--json"]).stdout);
const job = (dir, id) => jobs(dir).find((item) => item.id === id);
const detach = (dir, args) => {
  const result = beefy(dir, ["-d", ...args]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^[0-9a-f]{6}\n$/);
  return result.stdout.trim();
};
const free = (dir) => /no locks held/.test(beefy(dir, ["status"]).stdout);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// A command that records its own pid and its child's, then sits for 60 s. The test kills what it started.
const sitter = (file) => ["node", "-e", `const c = require("child_process").spawn("sleep", ["60"], { stdio: "ignore" }); require("fs").writeFileSync(${JSON.stringify(file)}, process.pid + " " + c.pid + " " + process.ppid); setInterval(() => {}, 1000)`];
const pids = (file) => readFileSync(file, "utf8").split(" ").map(Number);
const reap = (...list) => {
  for (const pid of list.flat().filter((pid) => pid && Math.abs(pid) !== process.pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
};

// Whatever a test left running (a wrapper, its command, a keeper) is stopped when the file ends: only pids named in this file's own folders.
after(() => {
  for (const dir of folders) {
    for (const job of listJobs(dir)) {
      for (const worker of [job.wrapper, job.child]) if (worker?.pid) reap(worker.pid, -worker.pid);
    }
    try {
      for (const name of readdirSync(dir).filter((file) => file.endsWith(".json"))) {
        const held = JSON.parse(readFileSync(join(dir, name), "utf8"));
        reap(held.keeper, held.watch, held.group ? [held.group.pid, -held.group.pid] : []);
      }
    } catch {}
  }
});

describe("beefy -d", () => {
  it("returns an id at once; the job runs, logs and records its exit", async () => {
    const dir = folder();
    // Under 0.5 s on a quiet machine; against a baseline of one plain beefy call so a loaded test run does not make it flaky.
    const plain = Date.now();
    beefy(dir, ["jobs"]);
    const base = Date.now() - plain;
    const started = Date.now();
    const id = detach(dir, ["sh", "-c", "echo hello; sleep 1"]);
    const took = Date.now() - started;
    assert.ok(took < 500 || took < base * 2 + 250,`took ${took} ms, a plain call ${base} ms`);
    await until(() => job(dir, id)?.state === "running");
    assert.match(beefy(dir, ["jobs"]).stdout, new RegExp(`${id}  running`));
    await until(() => job(dir, id)?.state === "done");
    assert.equal(job(dir, id).exit, 0);
    assert.match(beefy(dir, ["jobs"]).stdout, new RegExp(`${id}  done \\(exit 0\\)`));
    assert.equal(beefy(dir, ["log", id]).stdout, "hello\n");
    await until(() => free(dir));
  });

  it("records a failing exit code, and runs jobs in order", async () => {
    const dir = folder();
    const first = detach(dir, ["sh", "-c", "sleep 4"]);
    await until(() => job(dir, first)?.state === "running");
    const second = detach(dir, ["node", "-e", "process.exit(3)"]);
    await until(() => job(dir, second)?.state === "waiting");
    assert.equal(beefy(dir, ["jobs"]).stdout.split("\n")[0].startsWith(first), true, "running first");
    await until(() => job(dir, second)?.state === "failed");
    assert.equal(job(dir, second).exit, 3);
    assert.ok(job(dir, first).finished <= job(dir, second).started, "second started after the first ended");
    assert.match(beefy(dir, ["log", second]).stdout, /waiting: 0 ahead on heavy/);
  });

  it("follows a log until the job ends", async () => {
    const dir = folder();
    const id = detach(dir, ["sh", "-c", "echo one; sleep 1; echo two"]);
    const followed = await new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, "log", id, "-f"], { env: env(dir), stdio: ["ignore", "pipe", "inherit"] });
      let text = "";
      child.stdout.on("data", (data) => (text += data));
      child.on("close", () => resolve(text));
    });
    assert.equal(followed, "one\ntwo\n");
  });

  it("rejects what cannot be a job, and a bad id", () => {
    const dir = folder();
    assert.equal(beefy(dir, ["-d", "--wait", "x", "true"]).status, 2);
    assert.equal(beefy(dir, ["-d", "--on", "bad name", "true"]).status, 2);
    assert.equal(beefy(dir, ["-d"]).status, 2);
    assert.equal(beefy(dir, ["log", "000000"]).status, 1);
    assert.equal(beefy(dir, ["cancel", "000000"]).status, 1);
    assert.equal(beefy(dir, ["cancel", "../x"]).status, 2);
    assert.equal(beefy(dir, ["jobs"]).stdout, "no jobs\n");
  });
});

describe("retention", () => {
  it("prunes finished jobs past the count, oldest first, and never a live one", () => {
    const dir = folder();
    const jobsDir = join(dir, "jobs");
    spawnSync("mkdir", ["-p", jobsDir]);
    const put = (id, extra) => {
      writeFileSync(join(jobsDir, `${id}.json`), JSON.stringify({ id, command: ["x"], created: "2026-11-20T00:00:00.000Z", ...extra }));
      writeFileSync(join(jobsDir, `${id}.log`), "x");
    };
    for (let n = 1; n <= 5; n++) put(`00000${n}`, { state: "done", exit: 0, finished: `2026-11-20T00:00:0${n}.000Z` });
    // A "running" job whose wrapper is this test process is live and stays, however old.
    put("0000aa", { state: "running", wrapper: { pid: process.pid, start: "", boot: "" } });
    assert.equal(prune(dir, { keep: 2 }), 3);
    assert.deepEqual(listJobs(dir).map((item) => item.id).sort(), ["000004", "000005", "0000aa"]);
    assert.equal(existsSync(join(jobsDir, "000001.log")), false);
    assert.equal(existsSync(join(jobsDir, "000005.log")), true);
  });
});

describe("cancel", () => {
  it("cancel mid-run kills the whole group and frees the slot", async () => {
    const dir = folder();
    const file = join(dir, "pids");
    const id = detach(dir, sitter(file));
    await until(() => existsSync(file) && readFileSync(file, "utf8").split(" ").length === 3);
    const [command, grandchild] = pids(file);
    try {
      assert.equal(free(dir), false);
      const result = beefy(dir, ["cancel", id]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(alive(command), false);
      assert.equal(alive(grandchild), false);
      assert.equal(job(dir, id).state, "cancelled");
      assert.equal(free(dir), true);
    } finally {
      reap(command, grandchild);
    }
  });

  it("escalates to SIGKILL when the command ignores SIGTERM", async () => {
    const dir = folder();
    const file = join(dir, "pid");
    const id = detach(dir, ["node", "-e", `process.on("SIGTERM", () => {}); require("fs").writeFileSync(${JSON.stringify(file)}, String(process.pid)); setInterval(() => {}, 1000)`]);
    await until(() => existsSync(file) && readFileSync(file, "utf8") !== "");
    const pid = Number(readFileSync(file, "utf8"));
    try {
      const started = Date.now();
      const result = spawnSync(process.execPath, ["-e", `import("${new URL("../src/jobs.mjs", import.meta.url)}").then(async (m) => process.exit(await m.cancelJob({ id: ${JSON.stringify(id)}, dir: ${JSON.stringify(dir)}, grace: 1 })))`], { env: env(dir), encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(Date.now() - started < 6000);
      assert.equal(alive(pid), false);
      assert.equal(free(dir), true);
    } finally {
      reap(pid);
    }
  });

  it("cancel mid-wait removes the job from the line and it never runs", async () => {
    const dir = folder();
    const file = join(dir, "pids");
    const holder = detach(dir, sitter(file));
    await until(() => existsSync(file) && readFileSync(file, "utf8").split(" ").length === 3);
    const [command, grandchild] = pids(file);
    const marker = join(dir, "ran");
    try {
      const waiting = detach(dir, ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`]);
      await until(() => job(dir, waiting)?.state === "waiting" && job(dir, waiting).wrapper);
      assert.match(beefy(dir, ["status"]).stdout, /heavy: waiting/);
      assert.equal(beefy(dir, ["cancel", waiting]).status, 0);
      assert.equal(job(dir, waiting).state, "cancelled");
      assert.doesNotMatch(beefy(dir, ["status"]).stdout, /heavy: waiting/);
      // The slot goes on to the next job in line, not to the cancelled one.
      const third = detach(dir, ["node", "-e", "0"]);
      assert.equal(beefy(dir, ["cancel", holder]).status, 0);
      await until(() => job(dir, third)?.state === "done");
      assert.equal(existsSync(marker), false);
    } finally {
      reap(command, grandchild);
    }
  });

  it("cancel mid-start: a cancel that lands before the wrapper registers still stops the job", async () => {
    const dir = folder();
    const marker = join(dir, "pid");
    const id = detach(dir, ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`]);
    // At once, whatever the wrapper has got to: queued, registered, or already running.
    const result = beefy(dir, ["cancel", id]);
    assert.equal(result.status, 0, result.stderr);
    await until(() => job(dir, id)?.state === "cancelled");
    await wait(300);
    if (existsSync(marker)) assert.equal(alive(Number(readFileSync(marker, "utf8"))), false);
    assert.equal(free(dir), true);
  });

  it("will not cancel a finished job", async () => {
    const dir = folder();
    const id = detach(dir, ["node", "-e", "0"]);
    await until(() => job(dir, id)?.state === "done");
    assert.equal(beefy(dir, ["cancel", id]).status, 1);
    assert.equal(job(dir, id).state, "done");
  });
});

// A command that takes 1.2 s to leave once told to, and writes the time it left; it also starts a child that never leaves on its own.
const slowLeaver = (file, left) => ["node", "-e", `const c = require("child_process").spawn("sleep", ["60"], { stdio: "ignore" }); const bye = () => setTimeout(() => process.exit(0), 1200); process.on("SIGTERM", bye); process.on("SIGHUP", bye); process.on("exit", () => require("fs").writeFileSync(${JSON.stringify(left)}, String(Date.now()))); require("fs").writeFileSync(${JSON.stringify(file)}, process.pid + " " + c.pid + " " + process.ppid); setInterval(() => {}, 1000)`];

describe("a wrapper that dies", () => {
  it("wrapper killed (SIGKILL): the job is lost, its group is stopped first, and the slot frees only after", async () => {
    const dir = folder();
    const file = join(dir, "pids");
    const left = join(dir, "left");
    const marker = join(dir, "next");
    const id = detach(dir, slowLeaver(file, left));
    await until(() => existsSync(file) && readFileSync(file, "utf8").split(" ").length === 3);
    const [command, grandchild] = pids(file);
    try {
      const record = await until(() => job(dir, id)?.state === "running" && job(dir, id));
      // A job queued behind it must not start while the orphan is still there.
      const next = detach(dir, ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, String(Date.now()))`]);
      process.kill(record.wrapper.pid, "SIGKILL");
      await until(() => !alive(record.wrapper.pid));
      assert.equal(job(dir, id).state, "lost");
      assert.match(beefy(dir, ["jobs"]).stdout, new RegExp(`${id}  lost`));
      // The command is told to go (it needs 1.2 s), and the slot stays held until it has.
      await wait(200);
      assert.equal(free(dir), false, "the slot is held while the command is still there");
      assert.equal(existsSync(marker), false, "the next job has not started");
      await until(() => job(dir, next)?.state === "done", 15000);
      assert.equal(alive(command), false);
      assert.equal(alive(grandchild), false);
      assert.ok(Number(readFileSync(marker, "utf8")) >= Number(readFileSync(left, "utf8")), "the next job started after the command left");
      assert.equal(job(dir, id).state, "lost");
    } finally {
      reap(command, grandchild);
    }
  });

  it("the guard signals only a command whose identity still matches", async () => {
    const dir = folder();
    const dead = spawn("true");
    await new Promise((resolve) => dead.on("close", resolve));
    const alone = () => spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    const ours = alone();
    // Stands in for a pid that was reused: the record's start time is not this process's.
    const reused = alone();
    const identity = workerIdentity(ours.pid);
    try {
      for (const [resource, group] of [["ours", { pid: ours.pid, tree: false, start: identity.start, boot: identity.boot }], ["reused", { pid: reused.pid, tree: false, start: "Thu Jan  1 00:00:00 1970", boot: identity.boot }]]) {
        take({ dir, resource, as: "a", id: resource, watch: dead.pid, ttl: 2, load: 0 });
        refreshHolder({ dir, resource, id: resource, extra: { group } });
        const result = spawnSync(process.execPath, [CLI, "keep", resource, "--id", resource, "--pid", String(dead.pid), "--dir", dir, "--every", "1", "--guard"], { env: env(dir), encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(existsSync(join(dir, `${resource}.json`)), false, `${resource}: the slot is freed`);
      }
      await until(() => ours.exitCode !== null || ours.signalCode !== null, 3000);
      assert.equal(alive(reused.pid), true, "an unrelated process is left alone");
    } finally {
      ours.kill("SIGKILL");
      reused.kill("SIGKILL");
    }
  });

  it("prune leaves a lost job whose command is still up, and takes it once it is gone", async () => {
    const dir = folder();
    const sitting = spawn("sleep", ["60"], { stdio: "ignore" });
    const gone = spawn("true");
    await new Promise((resolve) => gone.on("close", resolve));
    mkdirSync(join(dir, "jobs"));
    writeFileSync(join(dir, "jobs", "0000bb.json"), JSON.stringify({ id: "0000bb", command: ["x"], state: "running", created: "2026-11-20T00:00:00.000Z", wrapper: { pid: gone.pid, start: "", boot: "" }, child: { pid: sitting.pid, start: "", boot: "" } }));
    try {
      assert.equal(listJobs(dir)[0].state, "lost");
      assert.equal(prune(dir, { keep: 0 }), 0);
      assert.equal(listJobs(dir).length, 1);
      sitting.kill("SIGKILL");
      await new Promise((resolve) => sitting.on("close", resolve));
      assert.equal(prune(dir, { keep: 0 }), 1);
      assert.equal(listJobs(dir).length, 0);
    } finally {
      sitting.kill("SIGKILL");
    }
  });

  it("prune removes the temp file of a writer that died and keeps a live writer's", async () => {
    const dir = folder();
    mkdirSync(join(dir, "jobs"));
    const gone = spawn("true");
    await new Promise((resolve) => gone.on("close", resolve));
    writeFileSync(join(dir, "jobs", `0000cc.json.${gone.pid}.tmp`), "{");
    writeFileSync(join(dir, "jobs", `0000dd.json.${process.pid}.tmp`), "{");
    prune(dir);
    assert.deepEqual(readdirSync(join(dir, "jobs")), [`0000dd.json.${process.pid}.tmp`]);
  });

  it("cancel escalates to SIGKILL when the child's start time was never read", async () => {
    const dir = folder();
    const stubborn = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { detached: true, stdio: "ignore" });
    mkdirSync(join(dir, "jobs"));
    const record = { id: "0000ee", command: ["x"], state: "running", created: "2026-11-20T00:00:00.000Z", wrapper: { pid: stubborn.pid, start: "", boot: "" }, child: { pid: stubborn.pid, start: "", boot: "" } };
    writeFileSync(join(dir, "jobs", "0000ee.json"), JSON.stringify(record));
    try {
      await wait(300);
      // Asynchronous, so the test process can reap the stand-in wrapper it started (a zombie would still look alive by pid).
      const cancel = spawn(process.execPath, ["-e", `import("${new URL("../src/jobs.mjs", import.meta.url)}").then(async (m) => process.exit(await m.cancelJob({ id: "0000ee", dir: ${JSON.stringify(dir)}, grace: 1 })))`], { env: env(dir), stdio: "ignore" });
      assert.equal(await new Promise((resolve) => cancel.on("close", resolve)), 0);
      await new Promise((resolve) => (stubborn.exitCode !== null || stubborn.signalCode !== null ? resolve() : stubborn.on("close", resolve)));
      assert.equal(alive(stubborn.pid), false);
    } finally {
      stubborn.kill("SIGKILL");
    }
  });
});

describe("a signal while the command starts", () => {
  it("never leaves a command behind, whenever it lands", async () => {
    const dir = folder();
    const token = `61.${process.pid}`;
    const survivors = () => spawnSync("ps", ["-A", "-o", "command="], { encoding: "utf8" }).stdout.split("\n").filter((line) => line.startsWith(`sleep ${token}`));
    for (let delay = 40; delay <= 280; delay += 15) {
      const wrapper = spawn(process.execPath, [CLI, "sleep", token], { env: env(dir), stdio: "ignore" });
      const closed = new Promise((resolve) => wrapper.on("close", resolve));
      await wait(delay);
      wrapper.kill("SIGTERM");
      await closed;
      await wait(100);
      assert.deepEqual(survivors(), [], `delay ${delay} ms`);
    }
  });
});

// A pty for the wrapper, so it sees a terminal (`script` gives one without a tool of ours).
// macOS only: BSD script(1) keeps the child going when its own stdin is /dev/null; util-linux's behaviour there is not checked, so Linux skips.
const hasScript = process.platform === "darwin" && spawnSync("script", ["-q", "/dev/null", "true"], { stdio: "ignore" }).status === 0;
const onTty = (dir, args) => {
  const quoted = [process.execPath, CLI, ...args].map((word) => `'${word.replace(/'/g, "'\\''")}'`).join(" ");
  const argv = ["-q", "/dev/null", "sh", "-c", quoted];
  const child = spawn("script", argv, { env: env(dir), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  return { child, output: () => output, closed: new Promise((resolve) => child.on("close", resolve)) };
};

describe("a wrapper on a terminal", { skip: !hasScript && "needs macOS script(1) for a pty" }, () => {
  it("keeps the command in the foreground group, so a tty prompt would work", async () => {
    const dir = folder();
    const run = onTty(dir, ["sh", "-c", "ps -o pgid=,tpgid= -p $$"]);
    try {
      await run.closed;
      const match = /(\d+)\s+(\d+)/.exec(run.output());
      assert.ok(match, run.output());
      assert.equal(match[1], match[2], `pgid ${match[1]}, foreground ${match[2]}`);
    } finally {
      run.child.kill("SIGKILL");
    }
  });

  it("kill -TERM on the wrapper stops the command and its children, and the slot frees after", async () => {
    const dir = folder();
    const file = join(dir, "pids");
    const left = join(dir, "left");
    const run = onTty(dir, slowLeaver(file, left));
    await until(() => existsSync(file) && readFileSync(file, "utf8").split(" ").length === 3);
    const [command, grandchild, wrapper] = pids(file);
    try {
      process.kill(wrapper, "SIGTERM");
      await wait(300);
      assert.equal(free(dir), false, "held while the command leaves");
      await until(() => free(dir), 15000);
      assert.equal(alive(command), false);
      assert.equal(alive(grandchild), false);
      assert.ok(existsSync(left));
    } finally {
      reap(command, grandchild, wrapper);
      run.child.kill("SIGKILL");
    }
  });

  it("a wrapper killed outright: its guard stops the command before the slot frees", async () => {
    const dir = folder();
    const file = join(dir, "pids");
    const left = join(dir, "left");
    const run = onTty(dir, slowLeaver(file, left));
    await until(() => existsSync(file) && readFileSync(file, "utf8").split(" ").length === 3);
    const [command, grandchild, wrapper] = pids(file);
    try {
      process.kill(wrapper, "SIGKILL");
      await until(() => free(dir), 15000);
      assert.equal(alive(command), false);
      assert.equal(alive(grandchild), false);
    } finally {
      reap(command, grandchild);
      run.child.kill("SIGKILL");
    }
  });
});

describe("a foreground wrapper", () => {
  // A command that takes a second to leave once it is told to, so the slot is seen held in between.
  const slowStop = (file) => ["node", "-e", `process.on("SIGTERM", () => setTimeout(() => process.exit(0), 1000)); process.on("SIGHUP", () => setTimeout(() => process.exit(0), 1000)); process.on("SIGINT", () => setTimeout(() => process.exit(0), 1000)); require("fs").writeFileSync(${JSON.stringify(file)}, String(process.pid)); setInterval(() => {}, 1000)`];

  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) {
    it(`wrapper signalled (${signal}): the command is stopped too, and the slot frees only after it exits`, async () => {
      const dir = folder();
      const file = join(dir, "pid");
      const wrapper = spawn(process.execPath, [CLI, ...slowStop(file)], { env: env(dir), stdio: "ignore" });
      const closed = new Promise((resolve) => wrapper.on("close", (code, sig) => resolve({ code, sig })));
      await until(() => existsSync(file) && readFileSync(file, "utf8") !== "");
      const pid = Number(readFileSync(file, "utf8"));
      try {
        wrapper.kill(signal);
        await wait(400);
        // Told, not gone: the command is still leaving, so the wrapper lives and the slot is held.
        assert.equal(alive(wrapper.pid), true);
        assert.equal(alive(pid), true);
        assert.equal(free(dir), false);
        const end = await closed;
        assert.equal(end.sig, null, "the wrapper ended by its command's exit, not by the signal");
        assert.equal(end.code, 0);
        assert.equal(alive(pid), false);
        assert.equal(free(dir), true);
      } finally {
        reap(pid);
        wrapper.kill("SIGKILL");
      }
    });
  }

  it("wrapper signalled: a command killed by the signal gives 128+n", async () => {
    const dir = folder();
    const file = join(dir, "pid");
    const wrapper = spawn(process.execPath, [CLI, "node", "-e", `require("fs").writeFileSync(${JSON.stringify(file)}, "x"); setInterval(() => {}, 1000)`], { env: env(dir), stdio: "ignore" });
    const closed = new Promise((resolve) => wrapper.on("close", (code) => resolve(code)));
    await until(() => existsSync(file));
    wrapper.kill("SIGTERM");
    assert.equal(await closed, 143);
    assert.equal(free(dir), true);
  });
});
