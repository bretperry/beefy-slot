// Detached jobs: `beefy -d <cmd>` records a job and starts a wrapper process that waits its turn, runs the command with its output in a log file, and records the exit.
// Used by: the package entry point (`jobs`, `log`, `cancel`, `-d`, and the internal `job` wrapper verb).
// Run: `beefy -d <cmd…>`, `beefy jobs [--json]`, `beefy log <id> [-f]`, `beefy cancel <id>`; `beefy job <id>` is the wrapper and is not for people.
// Writes: `<lockDir>/jobs/<id>.json` (the record), `<id>.log` (the command's output), `<id>.cancel` (a cancel request); starts a detached wrapper.
// Exit: 0 done, 1 not found or could not start, 2 usage; the wrapper exits with its command's code.
// Exports: job record helpers, retention, and the verbs.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { alive, MAX_WAIT_MINUTES, RESOURCE, workerIdentity, workerState } from "./beefy-slot.mjs";

// Finished jobs kept (record and log); the oldest past this are removed whenever a job is added or ends.
export const JOB_RETENTION = 50;
// How long `cancel` waits for a command to leave after SIGTERM before it sends SIGKILL to the group.
export const CANCEL_GRACE_SECONDS = 10;

const ID = /^[0-9a-f]{6}$/;
const FINAL = ["done", "failed", "cancelled", "lost"];
const BIN = fileURLToPath(new URL("../bin/beefy-slot.mjs", import.meta.url));

export const jobsDir = (lockDir) => join(lockDir, "jobs");
const recordPath = (dir, id) => join(jobsDir(dir), `${id}.json`);
export const logPath = (dir, id) => join(jobsDir(dir), `${id}.log`);
const cancelPath = (dir, id) => join(jobsDir(dir), `${id}.cancel`);

// Written aside and renamed over, so a reader never sees half a record. Only the job's wrapper writes a record after it is created.
const write = (dir, id, record) => {
  const path = recordPath(dir, id);
  const aside = `${path}.${process.pid}.tmp`;
  writeFileSync(aside, JSON.stringify(record));
  renameSync(aside, path);
};

export const readJob = (dir, id) => {
  try {
    const record = JSON.parse(readFileSync(recordPath(dir, id), "utf8"));
    return record && typeof record === "object" && record.id === id && Array.isArray(record.command) ? record : null;
  } catch {
    return null;
  }
};

// Whether a recorded process (a wrapper, a command) may still be running: only a clear "dead" says no. A record that could not
// read the start time falls back to the pid alone.
const isUp = (worker, probe) => (worker.start === "" ? alive(worker.pid) : workerState(worker, probe) !== "dead");

const cancelRequested = (dir, id) => existsSync(cancelPath(dir, id));

// A job's state as of now: its record's, unless the wrapper that should be updating it is gone.
// A wrapper dead mid-wait or mid-run is `cancelled` when a cancel was asked for, else `lost`. A job whose wrapper never
// registered (it could not start) is `lost` once it is older than 30 s.
export const stateOf = (dir, record, { now = Date.now(), probe } = {}) => {
  if (FINAL.includes(record.state)) return record.state;
  const gone = record.wrapper ? !isUp(record.wrapper, probe) : now - Date.parse(record.created) > 30_000;
  if (!gone) return record.state;
  return cancelRequested(dir, record.id) ? "cancelled" : "lost";
};

// Every job, running first, then waiting (oldest first), then finished (newest first): [{ ...record, state }].
export const listJobs = (dir, opts = {}) => {
  let names = [];
  try {
    names = readdirSync(jobsDir(dir));
  } catch {
    return [];
  }
  const jobs = names.filter((name) => name.endsWith(".json")).map((name) => readJob(dir, name.slice(0, -5))).filter(Boolean).map((record) => ({ ...record, state: stateOf(dir, record, opts) }));
  const rank = (job) => (job.state === "running" ? 0 : job.state === "waiting" ? 1 : 2);
  const when = (job) => Date.parse(job.finished ?? job.created);
  return jobs.sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? when(b) - when(a) : Date.parse(a.created) - Date.parse(b.created)));
};

// Removes the oldest finished jobs (record, log and cancel marker) past `keep`. A job still waiting or running is never touched, nor is a
// finished one whose command is still up (a `lost` job: its wrapper was killed, and `cancel` must still reach the command). Also removes
// the half-written `.tmp` files of writers that died.
export const prune = (dir, { keep = JOB_RETENTION, probe } = {}) => {
  try {
    for (const name of readdirSync(jobsDir(dir))) {
      const writer = /\.json\.(\d+)\.tmp$/.exec(name);
      if (writer && !alive(Number(writer[1]))) rmSync(join(jobsDir(dir), name), { force: true });
    }
  } catch {}
  const finished = listJobs(dir, { probe }).filter((job) => FINAL.includes(job.state));
  const removable = finished.slice(keep).filter((job) => !(job.child && isUp(job.child, probe)));
  for (const job of removable) for (const path of [recordPath(dir, job.id), logPath(dir, job.id), cancelPath(dir, job.id)]) rmSync(path, { force: true });
  return removable.length;
};

// Creates the record under a new id: an exclusive create (`wx`), retried with another id if that one is taken.
const createJob = (dir, fields) => {
  for (;;) {
    const record = { id: randomBytes(3).toString("hex"), ...fields };
    try {
      writeFileSync(recordPath(dir, record.id), JSON.stringify(record), { flag: "wx" });
      return record;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `beefy -d <cmd>`: records the job, starts the wrapper in its own process group with its output in the log, prints the id and returns.
// `argv` is the `run` argv `commandArgv` built; `refusal` is the judge's look at the command, made here so a refused command never becomes a job.
export const startJob = ({ argv, uncapped, dir, refusal = () => null, out = console.log, err = console.error }) => {
  const split = argv.indexOf("--");
  const command = argv.slice(split + 1);
  const resource = argv[1];
  const flag = (name) => (argv.slice(0, split).includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const wait = flag("--wait");
  if (!RESOURCE.test(resource ?? "")) {
    err(`beefy-slot: ${resource} is not a resource name`);
    return 2;
  }
  if (wait !== undefined && !(/^\d+$/.test(wait) && Number(wait) <= MAX_WAIT_MINUTES)) {
    err(`beefy-slot: --wait is 0 to ${MAX_WAIT_MINUTES} minutes, not ${wait}`);
    return 2;
  }
  const refused = refusal(command);
  if (refused !== null) {
    err(`beefy-slot: refused: ${refused}`);
    return 1;
  }
  mkdirSync(jobsDir(dir), { recursive: true });
  const { id } = createJob(dir, { state: "waiting", resource, as: flag("--as"), command, argv, uncapped, cwd: process.cwd(), created: new Date().toISOString() });
  let fd;
  try {
    fd = openSync(logPath(dir, id), "a");
    const child = spawn(process.execPath, [BIN, "job", id], { detached: true, stdio: ["ignore", fd, fd], env: process.env, cwd: process.cwd() });
    child.on("error", () => {});
    child.unref();
    if (child.pid === undefined) throw new Error("the wrapper did not start");
  } catch (error) {
    rmSync(recordPath(dir, id), { force: true });
    rmSync(logPath(dir, id), { force: true });
    err(`beefy-slot: could not start the job: ${error.message}`);
    return 1;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  prune(dir);
  out(id);
  if (process.stderr.isTTY) err(`beefy jobs  ·  beefy log ${id} -f  ·  beefy cancel ${id}`);
  return 0;
};

// The wrapper (`beefy job <id>`, detached): registers itself, runs the job through `run` (the same queue and run path as a foreground
// `beefy <cmd>`: no cap, waiting lines to the log), and records the exit. `run(argv, options)` is `main` with the judge and settings bound.
export const wrapJob = async ({ id, dir, run, err = console.error }) => {
  const record = readJob(dir, id);
  if (!record) {
    err(`beefy-slot: no job ${id}`);
    return 1;
  }
  const wrapper = workerIdentity(process.pid) ?? { pid: process.pid, start: "", boot: "" };
  let current = { ...record, wrapper };
  const save = (extra) => write(dir, id, (current = { ...current, ...extra }));
  let recorded = false;
  const finish = (code) => {
    if (recorded) return;
    recorded = true;
    const cancelled = cancelRequested(dir, id);
    save({ state: cancelled ? "cancelled" : code === 0 ? "done" : "failed", exit: code, finished: new Date().toISOString() });
    prune(dir);
  };
  save({});
  // A cancel asked for before the wrapper registered (or while it queued and was not signalled) means the command never starts.
  if (cancelRequested(dir, id)) {
    finish(143);
    return 143;
  }
  const code = await run(record.argv, {
    uncapped: record.uncapped,
    command: true,
    job: {
      proceed: () => !cancelRequested(dir, id),
      started: (child) => {
        const info = child.identity ?? workerIdentity(child.pid);
        save({ state: "running", started: new Date().toISOString(), child: info ?? { pid: child.pid, start: "", boot: "" } });
      },
      exited: finish,
    },
  });
  finish(code);
  return code;
};

const stopGroup = (pid, signal) => {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
};

// `beefy cancel <id>`: stops a waiting or running job. The request goes in a marker file first (so a wrapper that has not registered, or is between
// the queue and the start, sees it). A waiting wrapper is blocked in its queue wait with no handler, so SIGTERM ends it and its place in line goes
// with it (a ticket whose process is gone is swept). A running wrapper forwards SIGTERM to the command's process group and frees the slot only when
// the command is gone; if the group is still there after the grace, SIGKILL goes to the whole group.
export const cancelJob = async ({ id, dir, grace = CANCEL_GRACE_SECONDS, out = console.log, err = console.error }) => {
  const record = readJob(dir, id);
  if (!record) {
    err(`beefy-slot: no job ${id}`);
    return 1;
  }
  const state = stateOf(dir, record);
  if (["done", "failed", "cancelled"].includes(state)) {
    err(`beefy-slot: job ${id} already ${state === "cancelled" ? "cancelled" : "finished"}`);
    return 1;
  }
  writeFileSync(cancelPath(dir, id), "");
  const wrapperUp = () => Boolean(record.wrapper && isUp(record.wrapper));
  const childUp = () => {
    const child = readJob(dir, id)?.child ?? record.child;
    return Boolean(child && isUp(child));
  };
  if (wrapperUp()) {
    try {
      process.kill(record.wrapper.pid, "SIGTERM");
    } catch {}
  }
  // A lost job's command may still be running with no wrapper: its group gets the same two-step stop.
  const child = readJob(dir, id)?.child ?? record.child;
  if (!wrapperUp() && childUp()) stopGroup(child.pid, "SIGTERM");
  const until = Date.now() + grace * 1000;
  while (Date.now() < until && (wrapperUp() || childUp())) await sleep(50);
  if (childUp()) {
    const live = readJob(dir, id)?.child ?? child;
    stopGroup(live.pid, "SIGKILL");
    for (let i = 0; i < 100 && (wrapperUp() || childUp()); i++) await sleep(50);
  }
  if (wrapperUp()) {
    err(`beefy-slot: job ${id} did not stop`);
    return 1;
  }
  const after = readJob(dir, id);
  if (after && !FINAL.includes(after.state)) write(dir, id, { ...after, state: "cancelled", finished: new Date().toISOString() });
  prune(dir);
  out(`cancelled ${id}`);
  return 0;
};

const age = (iso, now = Date.now()) => {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return seconds < 90 ? `${seconds}s` : seconds < 5400 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;
};

const jobLine = (job) => {
  const when = job.state === "running" ? `running ${age(job.started)}` : job.state === "waiting" ? `waiting ${age(job.created)}` : `${job.state}${job.exit !== undefined && job.state !== "cancelled" ? ` (exit ${job.exit})` : ""} ${age(job.finished ?? job.created)} ago`;
  return `${job.id}  ${when.padEnd(22)}  ${job.command.join(" ")}`;
};

// `beefy log <id> [-f]`: the job's output; `-f` follows until the job ends.
const logJob = async ({ id, dir, follow, err }) => {
  const record = readJob(dir, id);
  if (!record) {
    err(`beefy-slot: no job ${id}`);
    return 1;
  }
  let offset = 0;
  const drain = () => {
    try {
      const size = statSync(logPath(dir, id)).size;
      if (size > offset) {
        const fd = openSync(logPath(dir, id), "r");
        try {
          const buffer = Buffer.alloc(size - offset);
          readSync(fd, buffer, 0, buffer.length, offset);
          offset = size;
          process.stdout.write(buffer);
        } finally {
          closeSync(fd);
        }
      }
    } catch {}
  };
  drain();
  while (follow && !FINAL.includes(stateOf(dir, readJob(dir, id) ?? record))) {
    await sleep(200);
    drain();
  }
  if (follow) drain();
  return 0;
};

export const JOBS_USAGE = "  jobs [--json]\n  log <id> [-f]\n  cancel <id>";

// `jobs`, `log`, `cancel` and the internal `job` verb. `run` is `main` with the judge and settings bound (the wrapper uses it).
export const jobsMain = (argv, { settings, run, out = console.log, err = console.error } = {}) => {
  const [verb, ...args] = argv;
  const dir = settings.lockDir;
  const usage = () => {
    err(`usage: beefy-slot <command> …\n${JOBS_USAGE}`);
    return 2;
  };
  if (verb === "jobs") {
    if (args.some((arg) => arg !== "--json")) return usage();
    const jobs = listJobs(dir);
    if (args.includes("--json")) out(JSON.stringify(jobs));
    else out(jobs.length === 0 ? "no jobs" : jobs.map(jobLine).join("\n"));
    return 0;
  }
  const id = args.find((arg) => !arg.startsWith("-"));
  if (!ID.test(id ?? "") || args.some((arg) => arg.startsWith("-") && !(verb === "log" && arg === "-f")) || args.filter((arg) => !arg.startsWith("-")).length !== 1) return usage();
  if (verb === "log") return logJob({ id, dir, follow: args.includes("-f"), err });
  if (verb === "cancel") return cancelJob({ id, dir, out, err });
  if (verb === "job") return wrapJob({ id, dir, run, err });
  return usage();
};
