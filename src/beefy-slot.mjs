#!/usr/bin/env node
// Machine-wide records, slots, waivers, and renewable runs; self-contained for transport on stdin.
// Used by: the package entry point and perf transport.
// Run: internal `keep <resource> --id <id> --pid <pid> [--start <time> --boot <id>] --dir <folder> --every <seconds> [--until <time>]`.
// When: a run starts its keeper; callers use the package entry point for other verbs.
// Env: BEEFY_SLOT_LOCK_DIR, BEEFY_SLOT_LOAD_MAX, BEEFY_SLOT_PERF_LOAD_MAX, BEEFY_SLOT_HEAVY_SLOTS, BEEFY_SLOT_PERF_HOST, BEEFY_SLOT_LOCK_POLL_SECONDS, BEEFY_SLOT_LOCK_HEARTBEAT_SECONDS, BEEFY_SLOT_LOCK_HELD; the CHUTE_BOSS_ twin of each is read too (legacy alias, one release); aliases supplied by embedders.
// Writes: lock records, waiver records and waivers.log; starts the run's command and keeper.
// Exit: 0 done, 1 refused, 2 usage, 75 busy; run returns the command's exit code.
// Exports: settings resolution, lock verbs, record helpers, worker identity, and lock constants.

import { spawn as spawnAsync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, constants as osConstants, homedir, loadavg } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

// Knobs: the load past which heavy work waits, and a lock's default life.
// The limit is LOAD_MAX, or LOAD_PER_CORE per core when that is higher. Why per core: a flat 3 sat
// under an idle desktop's own load (3.2–3.5 on a laptop), so every heavy step needed a waiver, and a
// limit everyone waives guards nothing; a forgotten Simulator (load ~350) still trips it anywhere.
// Why 1 per core, not less: a load up to the core count means the cores are busy, not oversubscribed
// (work is not yet queueing for a core); at 0.75 a shared 10-core Mac still hit the limit on its
// agents' ordinary builds. Past the core count, timing-sensitive work (Simulator UI tests, perf
// numbers) goes flaky and stacked builds slow each other, so the limit stops there.
export const LOAD_MAX = 3;
export const LOAD_PER_CORE = 1;
export const DEFAULT_TTL_MINUTES = 60;
export const BUSY = 75;

// Slots: the reserved pool name for heavy work, how many holders it admits when nothing says otherwise
// (1 admits one holder), and the most any resource may admit (a typo like 200 is refused).
// Why a cap of 16: slots are files scanned on every free and status; no machine runs more heavy jobs than that.
export const HEAVY = "heavy";
export const DEFAULT_HEAVY_SLOTS = 1;
export const MAX_SLOTS = 16;

// The reserved resource for strict perf runs, and its load limit. Why 1.5: a perf run measures frames and
// timings, and one other busy core already moves them; the heavy-work limit (a core per core) is for
// builds that only need to finish.
export const PERF = "perf";
export const PERF_LOAD_MAX = 1.5;

// How long --wait sleeps between looks, how long a wait may be at most, and how long a waiver lasts.
// Why 20 s: a slot frees on the scale of minutes, so a tighter poll only costs process starts. Why a 4 h
// ceiling: a longer queue is a stuck one, and an unbounded value (a typo of 1e9) would hold a terminal forever.
// Why 30 / 120 minutes: a waiver covers one working stretch and a retry, never a day, so a forgotten one
// cannot become a standing exemption.
export const POLL_SECONDS = 20;
export const MAX_WAIT_MINUTES = 240;
export const WAIVER_TTL_MINUTES = 30;
export const MAX_WAIVER_MINUTES = 120;

// A `run` renews its lock every HEARTBEAT_SECONDS, and each renewal makes the record good for
// HEARTBEAT_TTL_MINUTES. Why 30 s / 2 min: a killed run frees its slot within 2 minutes (at once on
// the same machine, by pid), and a few missed renewals under heavy load do not lose the slot.
export const HEARTBEAT_SECONDS = 30;
export const HEARTBEAT_TTL_MINUTES = 2;

// A waiting take whose caller passed `--worker` looks at that process at least this often, so a wait
// never outlives its caller by more than this. It also looks for a free slot each time.
export const WORKER_CHECK_SECONDS = 5;

// A whole number from 1 to MAX_SLOTS, else null.
const slotCount = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_SLOTS ? n : null;
};

// A positive number, else null.
const positive = (value) => {
  const n = Number(value);
  return value !== undefined && value !== null && value !== "" && Number.isFinite(n) && n > 0 ? n : null;
};

const text = (value) => typeof value === "string" && value.length > 0 ? value : null;
const host = (value) => typeof value === "string" ? value : null;

// The settings a variable can set: the key, its variable, the check a value must pass, and what it expects in words.
// `config check` reads this to name a variable whose value is ignored.
export const ENV_KNOBS = [
  ["lockDir", "BEEFY_SLOT_LOCK_DIR", text, "a path"],
  ["heavySlots", "BEEFY_SLOT_HEAVY_SLOTS", slotCount, `a whole number from 1 to ${MAX_SLOTS}`],
  ["loadMax", "BEEFY_SLOT_LOAD_MAX", positive, "a positive number"],
  ["perfLoadMax", "BEEFY_SLOT_PERF_LOAD_MAX", positive, "a positive number"],
  ["perfHost", "BEEFY_SLOT_PERF_HOST", host, "a host name"],
  ["pollSeconds", "BEEFY_SLOT_LOCK_POLL_SECONDS", positive, "a positive number of seconds"],
  ["heartbeatSeconds", "BEEFY_SLOT_LOCK_HEARTBEAT_SECONDS", positive, "a positive number of seconds"],
].map(([key, env, valid, expects]) => ({ key, env, valid, expects }));

// The pre-rename name of a BEEFY_SLOT_ variable: CHUTE_BOSS_ is still read, so machines set up before the rename keep working.
const legacyName = (name) => name.replace(/^BEEFY_SLOT_/, "CHUTE_BOSS_");

// Resolve every machine setting once; helpers and children use this snapshot.
export const resolveSettings = ({ env = process.env, config = {}, envAliases = {}, cores = availableParallelism(), home = homedir(), err = console.error } = {}) => {
  const read = (name, valid, fallback) => {
    const aliases = envAliases[name] ?? [];
    const names = [name, legacyName(name), ...(Array.isArray(aliases) ? aliases : [aliases])];
    if (env[name] !== undefined && names.slice(1).some((alias) => env[alias] !== undefined && env[alias] !== env[name])) err(`beefy-slot: ${name} differs from its alias; ${name} wins when valid`);
    for (const key of names) {
      const value = valid(env[key]);
      if (value !== null) return value;
    }
    return fallback;
  };
  const heldNames = ["BEEFY_SLOT_LOCK_HELD", legacyName("BEEFY_SLOT_LOCK_HELD"), ...(envAliases.BEEFY_SLOT_LOCK_HELD ?? [])];
  const held = heldNames.map((name) => env[name]).filter(Boolean).join(",");
  // The default folder is ~/.beefy-slot/locks. A machine that only has the pre-rename ~/.chute-boss/locks keeps using it, so its slots do not split; legacy, one release.
  const legacyDefault = !existsSync(join(home, ".beefy-slot", "locks")) && existsSync(join(home, ".chute-boss", "locks"));
  const folder = read("BEEFY_SLOT_LOCK_DIR", text, text(config.lockDir) ?? (legacyDefault ? "~/.chute-boss/locks" : "~/.beefy-slot/locks"));
  return {
    lockDir: folder.startsWith("~/") ? join(home, folder.slice(2)) : folder,
    heavySlots: read("BEEFY_SLOT_HEAVY_SLOTS", slotCount, slotCount(config.heavySlots) ?? DEFAULT_HEAVY_SLOTS),
    loadMax: read("BEEFY_SLOT_LOAD_MAX", positive, positive(config.loadMax) ?? Math.max(LOAD_MAX, cores * LOAD_PER_CORE)),
    perfLoadMax: read("BEEFY_SLOT_PERF_LOAD_MAX", positive, positive(config.perfLoadMax) ?? PERF_LOAD_MAX),
    perfHost: read("BEEFY_SLOT_PERF_HOST", host, host(config.perfHost) ?? ""),
    pollSeconds: read("BEEFY_SLOT_LOCK_POLL_SECONDS", positive, positive(config.pollSeconds) ?? POLL_SECONDS),
    heartbeatSeconds: read("BEEFY_SLOT_LOCK_HEARTBEAT_SECONDS", positive, positive(config.heartbeatSeconds) ?? HEARTBEAT_SECONDS),
    resources: resourceSettings(config.resources),
    held, heldNames, childEnv: { ...env }, config: { ...config }, envAliases,
  };
};

// The named resources a config sets up, as { name: { slots: n | null, loadGate: boolean } }. A value passed
// in code that does not fit is skipped, as for the other settings; a file is checked strictly before this.
// `heavy` and `perf` are reserved and set by their own keys.
const resourceSettings = (resources) => {
  const out = Object.create(null);
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) return out;
  for (const [name, entry] of Object.entries(resources)) {
    if (name === HEAVY || name === PERF || !RESOURCE.test(name) || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    out[name] = { slots: slotCount(entry.slots), loadGate: entry.loadGate !== false };
  }
  return out;
};

// How many holders a resource admits: `heavy` from heavySlots, a named resource from its entry in the config, else one.
export const slotsFor = (resource, settings) => resource === HEAVY ? settings.heavySlots : settings.resources?.[resource]?.slots ?? 1;
// True when the machine sets the resource's slot count (a config entry), so a flag never does.
export const slotsFixed = (resource, settings) => resource !== HEAVY && (settings.resources?.[resource]?.slots ?? null) !== null;
// False for a named resource whose config entry turns its load limit off; every other resource is gated.
export const loadGated = (resource, settings) => resource === HEAVY || resource === PERF || settings.resources?.[resource]?.loadGate !== false;
export const perfLoadLine = (settings) => settings.perfLoadMax;
export const loadLine = (settings) => settings.loadMax;
export const lockDir = (settings) => settings.lockDir;

// The record names of a resource's slots: the resource itself, then resource~1, resource~2 …
// `~` is outside the resource alphabet, so a slot never collides with another resource.
export const slotNames = (resource, slots) => Array.from({ length: slots }, (_, i) => (i === 0 ? resource : `${resource}~${i}`));

// A status line's subject: the holder (with its load waiver, if it rides on one), or a waiver record's holder and reason.
const describeHolder = (held) => (held.reason ? `waiver for ${held.as}: ${held.reason}` : `${held.as}${held.worker ? ` (worker ${held.worker.pid})` : ""}${held.waived ? ` (load waived: ${held.waived.reason})` : ""}`);

// Queue options use the same snapshot as the take and the keeper.
const queue = (opts, settings) => ({ slots: opts.slots ?? slotsFor(opts.rest[0], settings), fixed: slotsFixed(opts.rest[0], settings), wait: opts.wait, pollSeconds: settings.pollSeconds });

// The process using the most CPU (`pid command (pcpu%)`), not this one, or "" when ps can't say.
// Named in a load refusal so a forgotten simulator or dev server is obvious at a glance.
export const busiestProcess = () => {
  const ps = spawnSync("ps", ["-Ao", "pid=,pcpu=,comm="], { encoding: "utf8", timeout: 2000 });
  if (ps.status !== 0 || typeof ps.stdout !== "string") return "";
  let top = null;
  for (const line of ps.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+([\d.]+)\s+(.+)$/.exec(line);
    if (!match || Number(match[1]) === process.pid) continue;
    const cpu = Number(match[2]);
    if (!top || cpu > top.cpu) top = { pid: match[1], cpu, command: match[3].trim() };
  }
  return top ? `${top.pid} ${top.command} (${top.cpu}%)` : "";
};

// A resource name becomes a file name, so it stays to a safe alphabet.
export const RESOURCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const safeName = (resource) => resource.replace(/:/g, "_");
const fileOf = (dir, resource) => join(dir, `${safeName(resource)}.json`);

// The holder of a resource, or null when free or unreadable.
// A record without an object shape, a holder name, and a valid `until` counts as unreadable (null).
export const holder = (dir, resource) => {
  try {
    const record = JSON.parse(readFileSync(fileOf(dir, resource), "utf8"));
    const valid = record && typeof record === "object" && !Array.isArray(record) && typeof record.as === "string" && record.as !== "" && typeof record.until === "string" && Number.isFinite(Date.parse(record.until));
    return valid ? record : null;
  } catch {
    return null;
  }
};

// True when a process with this pid exists (EPERM means it exists and is someone else's).
export const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

// One look at a process: { state: "gone" } when it is certainly not there, { state: "unknown" } when the look
// itself failed (ps missing, slow, or unreadable on a loaded machine), else { state: "ok", start, zombie }.
// The start time is what tells a process from a later one that was handed its process ID: on Linux the start
// tick from /proc, elsewhere `ps`'s start time (LC_ALL=C so its shape does not depend on the locale).
export const readProcess = (pid) => {
  if (!Number.isInteger(pid) || pid < 1 || !alive(pid)) return { state: "gone" };
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // The command name sits in parentheses and may hold spaces; the fields that matter follow its last ")".
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[19] !== undefined && /^\d+$/.test(fields[19])) return { state: "ok", start: `ticks:${fields[19]}`, zombie: fields[0] === "Z" || fields[0] === "X" };
    } catch {}
  }
  const ps = spawnSync("ps", ["-o", "lstart=,stat=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, env: { ...process.env, LC_ALL: "C" } });
  if (ps.error || ps.signal || typeof ps.stdout !== "string") return { state: "unknown" };
  const match = ps.status === 0 ? /^\s*(\w{3} \w{3}\s+\d+ [\d:]{8} \d{4})\s+(\S+)/.exec(ps.stdout) : null;
  if (match) return { state: "ok", start: match[1].replace(/\s+/g, " "), zombie: match[2].startsWith("Z") };
  // `ps -p` for a process that has gone exits 1 and prints nothing; any other failure is a look that did not work.
  return ps.status === 1 && ps.stdout.trim() === "" ? { state: "gone" } : { state: "unknown" };
};

// Start time and state of a process, or null when it does not exist or its start can't be read.
export const processInfo = (pid) => {
  const read = readProcess(pid);
  return read.state === "ok" ? { start: read.start, zombie: read.zombie } : null;
};

// An id for this boot of the machine, or "" when none can be read. A process ID means nothing across a reboot.
let boot;
export const bootId = () => {
  if (boot) return boot;
  boot = "";
  try {
    boot = `linux:${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}`;
  } catch {
    // macOS: a per-boot UUID, else the boot time, which the system adjusts when its clock is set.
    for (const [key, tag] of [["kern.bootsessionuuid", "uuid"], ["kern.boottime", "time"]]) {
      const out = spawnSync("sysctl", ["-n", key], { encoding: "utf8", timeout: 2000 });
      const value = out.status === 0 && typeof out.stdout === "string" ? (key === "kern.boottime" ? /sec = (\d+)/.exec(out.stdout)?.[1] : out.stdout.trim()) : "";
      if (value) {
        boot = `${tag}:${value}`;
        break;
      }
    }
  }
  return boot;
};

// Two boot ids name the same boot. Boot times are close enough within a minute, since a clock change moves them.
const sameBoot = (a, b) => a === b || (a.startsWith("time:") && b.startsWith("time:") && Math.abs(Number(a.slice(5)) - Number(b.slice(5))) <= 60);

// The identity a worker is held to: { pid, start, boot }, or null when the process is not there to be read.
export const workerIdentity = (pid) => {
  const info = processInfo(pid);
  const id = bootId();
  return info && !info.zombie && id ? { pid, start: info.start, boot: id } : null;
};

// What is known of a worker, from one look at its process: "alive" (this very process, not a later one with
// the same process ID, on this boot), "dead" (absent, another start time, a zombie, another boot) or "unknown"
// (the look failed, so nothing is known). `probe` is the test seam for the look.
export const workerState = (worker, probe = readProcess) => {
  if (!worker || typeof worker !== "object" || !Number.isInteger(worker.pid) || typeof worker.start !== "string" || typeof worker.boot !== "string") return "dead";
  const read = probe(worker.pid);
  if (read.state === "gone") return "dead";
  if (read.state !== "ok") return "unknown";
  if (read.zombie || read.start !== worker.start) return "dead";
  const now = bootId();
  return now === "" ? "unknown" : sameBoot(worker.boot, now) ? "alive" : "dead";
};

// True when this worker is known to be running.
export const workerAlive = (worker, probe) => workerState(worker, probe) === "alive";

const sameWorker = (a, b) => (!a && !b) || Boolean(a && b && a.pid === b.pid && a.start === b.start && a.boot === b.boot);

// A record is stale when it names a run (`watch`) whose process is gone (and no guard is stopping its command), when its `cap` (the end a --ttl set) has passed,
// or when it names a `worker`: dead means stale, alive means live whatever its time says (the slot lives while the
// process does), and unknown (the look failed) falls back to the time. Without a worker, a record is stale when its time is up.
const stale = (held, now, probe) => {
  if (!held) return true;
  // A run whose wrapper is gone still holds the slot while its guard is stopping the command (`group`): the guard frees it.
  if (typeof held.watch === "number" && !alive(held.watch) && !(typeof held.guard === "number" && held.group && alive(held.guard))) return true;
  if (held.worker !== undefined) {
    if (typeof held.cap === "string" && Date.parse(held.cap) <= now.getTime()) return true;
    const state = workerState(held.worker, probe);
    if (state === "dead") return true;
    if (state === "alive") return false;
  }
  return new Date(held.until).getTime() <= now.getTime();
};

// A takeover guard older than this was left by a crashed taker and may be cleared.
const GUARD_STALE_MS = 10_000;

// Folders on some network and FAT-style disks cannot make hard links. Say so, and say what to change.
const NO_LINKS = ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"];
export const linkFailure = (error, path) => {
  if (!NO_LINKS.includes(error?.code)) return error;
  return Object.assign(new Error(`beefy-slot: could not create a lock in ${dirname(path)} (${error.code}): this folder may not support hard links, or you may not be allowed to write there. Set lockDir in ~/.beefy-slot/config.json or BEEFY_SLOT_LOCK_DIR to a local folder you can write to.`), { code: "ENOHARDLINK", cause: error });
};

// Creates the lock file with its whole record or not at all: written aside, then hard-linked into
// place, which fails if the file exists. Returns true when this taker created it.
const create = (path, record) => {
  const aside = `${path}.${process.pid}.tmp`;
  writeFileSync(aside, record);
  try {
    linkSync(aside, path);
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw linkFailure(error, path);
    return false;
  } finally {
    rmSync(aside, { force: true });
  }
};

// Replaces a record whole: written aside, then renamed over, so a reader never sees half a file.
const replace = (path, record) => {
  const aside = `${path}.${process.pid}.tmp`;
  writeFileSync(aside, record);
  renameSync(aside, path);
};

// Whether `held` is the record of the taker `as` (and of the take `id`, when one is named). A take
// with no id is the CLI's `take`, which refreshes whatever `as` holds; a `run` always has one.
const isMine = (held, as, id) => held?.as === as && (id === undefined || held.id === id);

// A take is its holder's own only when it comes from the same worker too: the same name from another worker
// (or none) is another job asking for a slot that is held, so a live record is never taken over by its own name.
const ownedBy = (held, as, id, worker) => isMine(held, as, id) && sameWorker(held?.worker, worker);

// Takes one slot, or says who has it: { ok: true } | { ok: false, reason }.
// `onStale` is a test seam: it runs once a taker has seen a stale lock and before it acts on it.
// `waived` is the load waiver this take rides on, written into the lock it grants; `slots` is the
// count it takes the resource with; `watch` is a run's pid, whose death frees the lock; `worker` is a
// process identity ({ pid, start, boot }) whose death does too. `probe` is the test seam for looking at a worker's process.
const takeOne = ({ dir, resource, as, id, slots = 1, watch, worker, ttl = DEFAULT_TTL_MINUTES, now = new Date(), waived = /** @type {{ reason: string, at: string } | null} */ (null), onStale = () => {}, probe }) => {
  mkdirSync(dir, { recursive: true });
  const path = fileOf(dir, resource);
  const held = holder(dir, resource);
  const mine = ownedBy(held, as, id, worker);
  const recordId = id ?? (mine ? held?.id : undefined) ?? randomUUID();
  const record = JSON.stringify({ resource, as, id: recordId, slots, at: now.toISOString(), until: new Date(now.getTime() + ttl * 60_000).toISOString(), pid: process.pid, ...(watch === undefined ? {} : { watch }), ...(worker ? { worker } : {}), ...(mine && held.keeper ? { keeper: held.keeper } : {}), ...(waived ? { waived } : {}) });
  const busy = () => {
    const current = holder(dir, resource);
    return { ok: false, reason: `${resource} is held by ${current?.as ?? "someone"} until ${current?.until ?? "?"}. Try again later, or use --wait <minutes> to queue.` };
  };
  // Yours already: refresh the TTL.
  if (mine) {
    replace(path, record);
    return { ok: true, id: recordId, refreshed: true };
  }
  // A stale lock, or a file that exists but can't be read, is cleared by one taker at a time.
  if ((held && stale(held, now, probe)) || (!held && existsSync(path))) {
    onStale();
    // Only one taker at a time may clear a stale lock; without this, a second taker's removal could
    // delete the fresh lock the first had just created. Inside the guard, look again before removing.
    const guard = `${path}.takeover`;
    try {
      closeSync(openSync(guard, "wx"));
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      // A guard left by a crashed taker is cleared; this call still answers busy.
      try {
        if (Date.now() - statSync(guard).mtimeMs > GUARD_STALE_MS) rmSync(guard, { force: true });
      } catch {}
      return busy();
    }
    try {
      if (stale(holder(dir, resource), now, probe)) rmSync(path, { force: true });
      return create(path, record) ? { ok: true, id: recordId } : busy();
    } finally {
      rmSync(guard, { force: true });
    }
  }
  return create(path, record) ? { ok: true, id: recordId } : busy();
};

// A waiver is a record, not a sentence in chat: one file per (resource, holder), so waiving for one
// agent never replaces another's. It excuses the load limit only, never a full resource.
const waiverName = (resource, as) => `${resource}~waiver~${createHash("sha256").update(as).digest("hex").slice(0, 12)}`;

// The live waiver for this holder on this resource, or null.
export const activeWaiver = (dir, resource, as, now = new Date()) => {
  const waiver = holder(dir, waiverName(resource, as));
  return waiver && waiver.as === as && !stale(waiver, now) ? waiver : null;
};

// Appends one line to waivers.log: every waiver and every --ignore-load that got a take through (never read back).
const logWaiver = (dir, entry) => {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "waivers.log"), `${JSON.stringify(entry)}\n`);
};

// Records a waiver of the load limit for `as` on `resource`: { ok: true, until } | { ok: false, reason }.
// The reason is required and kept, in the waiver and in waivers.log. Renewing a live waiver keeps its
// first start (`first`), and no chain of renewals runs past MAX_WAIVER_MINUTES from it.
export const waive = ({ dir, resource, as, reason, ttl = WAIVER_TTL_MINUTES, now = new Date() }) => {
  if (!reason?.trim()) return { ok: false, reason: "a waiver needs a reason (--reason)" };
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_WAIVER_MINUTES) return { ok: false, reason: `a waiver lasts 1 to ${MAX_WAIVER_MINUTES} minutes, not ${ttl}` };
  mkdirSync(dir, { recursive: true });
  const current = activeWaiver(dir, resource, as, now);
  const first = current?.first ?? current?.at ?? now.toISOString();
  const until = new Date(now.getTime() + ttl * 60_000).toISOString();
  if (new Date(until).getTime() > new Date(first).getTime() + MAX_WAIVER_MINUTES * 60_000) return { ok: false, reason: `${as} has held a waiver on ${resource} since ${first}; waivers for the same holder may not run past ${MAX_WAIVER_MINUTES} minutes from their first start. Let it lapse, or fix what is loading the machine.` };
  const record = { resource, as, reason: reason.trim().slice(0, 300), at: now.toISOString(), first, until };
  replace(fileOf(dir, waiverName(resource, as)), JSON.stringify(record));
  logWaiver(dir, { kind: "waive", renewed: current !== null, ...record });
  return { ok: true, until };
};

// One look at the slots: the first the taker already holds (refreshed), else the first free one.
// The load limit is checked once, first; over it, only a live waiver or --ignore-load gets through.
// `loadMax` is the load limit; `busiest` names the top CPU process for a load refusal.
// A live holder's recorded count caps the slots this take may use: it never shares a resource
// with someone who took it for fewer. Not when `fixed`: the machine's config sets that resource's count,
// so a raised count is open to the next take at once, whatever the holders took it with.
const takeSlots = ({ dir, resource, as, id, slots = 1, fixed = false, worker, load, loadMax = LOAD_MAX, busiest = () => "", ignoreLoad = false, reason, now = new Date(), probe, ...rest }) => {
  let waived = null;
  if (load > loadMax) {
    const waiver = ignoreLoad ? { reason: reason ?? "--ignore-load", at: now.toISOString() } : activeWaiver(dir, resource, as, now);
    if (!waiver) {
      const top = busiest();
      return { ok: false, reason: `the machine is busy: 1-minute load is ${load.toFixed(1)}, above the limit of ${loadMax.toFixed(1)}${top ? `; busiest process: ${top}` : ""}. Try again later.` };
    }
    waived = { reason: waiver.reason, at: waiver.at };
  }
  const every = slotNames(resource, MAX_SLOTS).map((name) => [name, holder(dir, name)]);
  const live = every.filter(([, held]) => held && !stale(held, now, probe)).map(([, held]) => held);
  const cap = fixed ? slots : Math.min(slots, ...live.map((held) => slotCount(held.slots) ?? 1));
  const done = (result) => {
    if (result.ok && waived && ignoreLoad) logWaiver(dir, { kind: "ignore-load", resource, as, load, loadMax, ...waived });
    return result;
  };
  const mine = every.find(([, held]) => ownedBy(held, as, id, worker));
  if (mine) return done(takeOne({ dir, resource: mine[0], as, id, slots: cap, worker, now, waived, probe, ...rest }));
  // A configured count caps the holders across every slot name, not just the first `cap`: lowering it
  // while a holder sits in a higher slot must not let a new take join the others in the lower ones.
  if (fixed && live.length >= cap) {
    return cap === 1
      ? { ok: false, reason: `${resource} is held by ${live[0].as} until ${live[0].until}. Try again later, or use --wait <minutes> to queue.` }
      : { ok: false, reason: `all ${cap} ${resource} slots are held (${live.map((held) => `${held.as} until ${held.until}`).join(", ")}). Try again later, or queue with --wait <minutes>.` };
  }
  let last;
  for (const name of slotNames(resource, cap)) {
    last = takeOne({ dir, resource: name, as, id, slots: cap, worker, now, waived, probe, ...rest });
    if (last.ok) return done(last);
  }
  if (cap < slots) {
    const limiter = live.find((held) => (slotCount(held.slots) ?? 1) < slots);
    return { ok: false, reason: `${resource} is held by ${limiter?.as ?? "someone"} until ${limiter?.until ?? "?"}, who took it with ${cap} slot${cap === 1 ? "" : "s"}; a take for ${slots} cannot share it. Try again later, or use the same --slots.` };
  }
  if (cap === 1) return last;
  return { ok: false, reason: `all ${cap} ${resource} slots are held (${live.map((held) => `${held.as} until ${held.until}`).join(", ")}). Try again later, or queue with --wait <minutes>.` };
};

// The live holders of a resource, across every slot name: [{ slot, ...record }].
export const liveHolders = (dir, resource, now = new Date(), probe) => slotNames(resource, MAX_SLOTS).map((name) => [name, holder(dir, name)]).filter(([, held]) => held && !stale(held, now, probe)).map(([slot, held]) => ({ slot, ...held }));

// Tickets: a waiting take's place in line, one file each in `tickets/` under the lock folder, so the
// first to wait is the first served. A ticket is live while its waiter's process is and its lease has
// not run out; the waiter renews the lease at every look. Why a lease as well as the process: a waiter
// that is stopped but not dead (Ctrl-Z) would hold the line for good. Why 60 s at least: a few slow
// looks on a loaded machine must not lose a place.
const TICKETS = "tickets";
export const TICKET_LEASE_SECONDS = 60;
const ticketFile = (dir, resource, id) => join(dir, TICKETS, `${safeName(resource)}~${id}.json`);

// Every live ticket in the folder, first come first. `sweep` removes the dead ones it meets (a take does; status only reads).
const tickets = (dir, now, sweep = false) => {
  const folder = join(dir, TICKETS);
  let names;
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const live = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let ticket = null;
    try {
      ticket = JSON.parse(readFileSync(join(folder, name), "utf8"));
    } catch {}
    const valid = ticket && typeof ticket === "object" && typeof ticket.resource === "string" && typeof ticket.as === "string" && typeof ticket.id === "string" && typeof ticket.at === "string" && Number.isFinite(Date.parse(ticket.until));
    if (valid && Date.parse(ticket.until) > now.getTime() && (typeof ticket.pid !== "number" || alive(ticket.pid))) live.push(ticket);
    else if (sweep) rmSync(join(folder, name), { force: true });
  }
  return live.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
};

// The takes waiting for a resource, first come first: [{ resource, as, id, at, until, pid, yield? }].
export const waiting = (dir, resource, now = new Date()) => tickets(dir, now).filter((ticket) => ticket.resource === resource);

// What the lock folder holds, for `status --json` and the config screen: the load, and for `heavy`, `perf`,
// each configured resource and any other with a holder or a waiter, its count, holders, waiters and waivers.
export const snapshot = ({ dir, settings, now = new Date(), probe, load = loadavg()[0], only }) => {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
  const records = files.map((name) => holder(dir, name)).filter((held) => held && !stale(held, now, probe));
  const base = (held) => (typeof held.resource === "string" ? held.resource.split("~")[0] : "");
  const line = tickets(dir, now);
  const names = new Set([HEAVY, PERF, ...Object.keys(settings.resources ?? {})]);
  for (const held of records) if (base(held)) names.add(base(held));
  for (const ticket of line) names.add(ticket.resource);
  const resources = [...names].filter((name) => only === undefined || name === only).map((name) => ({
    name,
    slots: slotsFor(name, settings),
    loadMax: name === PERF ? perfLoadLine(settings) : loadGated(name, settings) ? loadLine(settings) : null,
    holders: records.filter((held) => !held.reason && base(held) === name).map((held) => ({ slot: held.resource, as: held.as, at: held.at, until: held.until, ...(held.worker ? { worker: held.worker.pid } : {}), ...(held.waived ? { waived: held.waived.reason } : {}) })),
    waiting: line.filter((ticket) => ticket.resource === name).map((ticket) => ({ as: ticket.as, at: ticket.at, ...(ticket.yield ? { yield: true } : {}) })),
    waivers: records.filter((held) => held.reason && held.resource === name).map((held) => ({ as: held.as, reason: held.reason, until: held.until })),
  }));
  return { load, lockDir: dir, resources };
};

// A free says so by creating and removing `<resource>.wake` (the folder is left as it was). macOS does not report the removal of a lock file made with a hard link (the
// way `create` makes one), so without this a watcher would hear nothing when a slot frees. A plain create is reported
// on macOS and Linux alike. Only the waiters for this resource look at it; a failed write costs them one poll.
const wake = (dir, resource) => {
  try {
    const path = join(dir, `${safeName(resource)}.wake`);
    writeFileSync(path, `${Date.now()}\n`);
    rmSync(path, { force: true });
  } catch {}
};

// Blocks the thread for `ms` (the queue's wait has nothing else to do).
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Wakes a waiting take the moment the lock folder or `tickets/` changes, so a freed slot is looked at
// at once, not at the next poll. `take` is sync and its wait blocks the thread, which would deafen
// fs.watch here, so a worker thread watches and bumps a shared counter the blocked thread waits on:
// { seen(), wait(ms, seen), close() }, or null when it could not start (the poll serves alone).
// The counter is read before each look and the wait names that reading, so a change that lands
// between the look and the wait ends the wait at once: no wake is lost in that gap.
// Only names for `resource` count (its slot files, waivers, tickets), so other resources' traffic
// wakes nobody; no marker file is needed. A change the watcher never reports costs one poll.
const WATCHER = `
const { workerData: { sab, dir, tickets, prefix, ticketPrefix } } = require("node:worker_threads");
const fs = require("node:fs");
const flags = new Int32Array(sab);
const bump = () => { Atomics.add(flags, 0, 1); Atomics.notify(flags, 0); };
// A look writes and removes its own aside files (.tmp) and a takeover guard; hearing those would wake the waiter at itself.
const mine = (text) => text.endsWith(".tmp") || text.endsWith(".takeover");
let sub = null;
const watchTickets = () => {
  try { sub?.close(); } catch {}
  sub = null;
  try {
    sub = fs.watch(tickets, (_, name) => { const text = name ? String(name) : ""; if (!text || (text.startsWith(ticketPrefix) && !mine(text))) bump(); });
    sub.on("error", () => { sub = null; });
  } catch {}
};
try {
  const root = fs.watch(dir, (_, name) => {
    const text = name === null || name === undefined ? "" : String(name);
    if (text === "tickets") { watchTickets(); bump(); } else if (!text || (text.startsWith(prefix) && !mine(text))) bump();
  });
  root.on("error", () => {});
  watchTickets();
  Atomics.store(flags, 1, 1); Atomics.notify(flags, 1);
} catch {
  Atomics.store(flags, 1, 2); Atomics.notify(flags, 1);
}
`;
// execArgv is empty so the worker is plain CommonJS even when the process runs with --input-type=module.
const WATCH_READY_MS = 1000;
const watchFor = (dir, resource) => {
  try {
    const sab = new SharedArrayBuffer(8);
    const flags = new Int32Array(sab);
    const prefix = safeName(resource);
    const thread = new Worker(WATCHER, { eval: true, execArgv: [], workerData: { sab, dir, tickets: join(dir, TICKETS), prefix, ticketPrefix: `${prefix}~` } });
    thread.on("error", () => Atomics.store(flags, 1, 2));
    thread.unref();
    // Ready once the folder is watched; a watch that never starts leaves the poll to do the work.
    if (Atomics.load(flags, 1) === 0) Atomics.wait(flags, 1, 0, WATCH_READY_MS);
    if (Atomics.load(flags, 1) !== 1) {
      void thread.terminate();
      return null;
    }
    return {
      seen: () => Atomics.load(flags, 0),
      wait: (ms, seen) => Atomics.wait(flags, 0, seen, ms),
      close: () => void thread.terminate(),
    };
  } catch {
    return null;
  }
};

// Takes a slot, or says who has them: { ok: true } | { ok: false, reason }. `wait` minutes of queueing
// (0 to MAX_WAIT_MINUTES): look again every `pollSeconds` until a slot is free and the load is under the
// line, or the minutes run out (then the last refusal comes back). `slots` is how many holders the
// resource admits. Time is read from `clock` when one is given (the real clock for the CLI), else counted
// from `now` plus the sleeps. With a `worker` the wait looks at it every WORKER_CHECK_SECONDS at most and
// gives up with { ok: false, gone: true } once it is gone. Without a `sleep`, a watcher (`waker`) wakes the wait
// when the lock folder changes, with the poll as the fallback. `onStale`, `sleep`, `waker`, `reload` (a fresh load
// reading for each look after the first), `clock` and `alive` (the worker check) and `probe` (a look at a worker's process) are test seams.
export const take = ({ wait = 0, uncapped = false, onWait, pollSeconds = POLL_SECONDS, sleep, waker = watchFor, reload = () => loadavg()[0], clock, now = new Date(), load = loadavg()[0], alive: workerUp, probe, ...rest }) => {
  if (!uncapped && (!Number.isFinite(wait) || wait < 0 || wait > MAX_WAIT_MINUTES)) return { ok: false, reason: `a wait is 0 to ${MAX_WAIT_MINUTES} minutes, not ${wait}` };
  const limit = uncapped ? Number.POSITIVE_INFINITY : wait * 60_000;
  // The worker is gone only when it is known to be; a look that failed says nothing, and the wait goes on.
  const gone = workerUp ? (worker) => !workerUp(worker) : (worker) => workerState(worker, probe) === "dead";
  const start = (clock ? clock() : now).getTime();
  const look = (rest.worker ? Math.min(pollSeconds, WORKER_CHECK_SECONDS) : pollSeconds) * 1000;
  const { dir, resource, as } = rest;
  const slots = rest.slots ?? 1;
  // This take's place in line, written at its first refusal and removed when it ends, however it ends.
  const ticket = { id: randomUUID(), at: "", yield: false };
  const lease = Math.max(TICKET_LEASE_SECONDS * 1000, look * 3);
  const punch = (at) => {
    mkdirSync(join(dir, TICKETS), { recursive: true });
    replace(ticketFile(dir, resource, ticket.id), JSON.stringify({ resource, as, id: ticket.id, at: ticket.at, until: new Date(at.getTime() + lease).toISOString(), pid: process.pid, ...(ticket.yield ? { yield: true } : {}) }));
  };
  // With no `sleep` given, the wait is the real one: a watcher wakes it early when the lock folder changes.
  const nap = sleep ?? pause;
  const realStart = Date.now();
  let watcher = null;
  let lastPunch = 0;
  let waited = 0;
  try {
    for (;;) {
      // Read before the look, so a change that lands during it ends the wait below at once.
      const seen = watcher ? watcher.seen() : 0;
      if (rest.worker && gone(rest.worker)) return { ok: false, gone: true, reason: `worker ${rest.worker.pid} is gone${waited > 0 ? ` (waited ${Math.round(waited / 60_000)} min)` : ""}; no slot is taken for it` };
      const at = clock ? clock() : new Date(start + waited);
      // First come, first served: with others in line, this take goes only when the open slots reach its place.
      // A waiter that had a slot open to it and still could not take (the load, a `--slots` that cannot share)
      // steps aside (`yield`) so the ones behind are not held up by it. A take that already holds a slot is a refresh, not in line.
      const line = tickets(dir, at, true).filter((other) => other.resource === resource && other.id !== ticket.id);
      const ahead = line.filter((other) => !other.yield && (ticket.at === "" || other.at < ticket.at || (other.at === ticket.at && other.id < ticket.id))).length;
      const open = () => slots - liveHolders(dir, resource, at, probe).length;
      const turn = ahead === 0 || ahead < open() || slotNames(resource, MAX_SLOTS).some((name) => ownedBy(holder(dir, name), as, rest.id, rest.worker));
      const result = turn
        ? takeSlots({ ...rest, probe, now: at, load: waited === 0 ? load : reload() })
        : { ok: false, reason: `${ahead} earlier take${ahead === 1 ? " is" : "s are"} waiting for ${resource}. Try again later, or use --wait <minutes> to queue.` };
      if (result.ok || waited >= limit) return waited === 0 ? result : { ...result, reason: `${result.reason} (waited ${Math.round(waited / 60_000)} min)` };
      if (ticket.at === "") ticket.at = at.toISOString();
      const yielded = turn && open() > 0;
      onWait?.({ ahead, reason: result.reason });
      // The place is renewed once a poll interval, not at every wake: a renewal is a change in `tickets/`, and
      // every waiter's wake would set off the next one's.
      if (lastPunch === 0 || yielded !== ticket.yield || at.getTime() - lastPunch >= look) {
        ticket.yield = yielded;
        punch(at);
        lastPunch = at.getTime();
      }
      const step = Math.min(look, limit - waited);
      if (sleep) {
        sleep(step);
        waited = clock ? Math.max(clock().getTime() - start, waited + 1) : waited + step;
      } else {
        if (watcher === null) {
          // The watcher starts after the first look, so look again at once: a change in between was not heard.
          // BEEFY_SLOT_WATCH=off keeps the wait at poll speed (a folder whose changes are never reported).
          try {
            watcher = waker === watchFor && process.env.BEEFY_SLOT_WATCH === "off" ? false : waker(dir, resource) ?? false;
          } catch {
            watcher = false;
          }
          if (watcher) continue;
        }
        if (watcher) watcher.wait(step, seen);
        else nap(step);
        waited = Math.max(Date.now() - realStart, waited + 1);
      }
    }
  } finally {
    if (watcher) watcher.close();
    if (ticket.at !== "") {
      rmSync(ticketFile(dir, resource, ticket.id), { force: true });
      // The folder goes with its last ticket; a failure means someone else is still in line.
      try {
        rmdirSync(join(dir, TICKETS));
      } catch {}
    }
  }
};

// Frees the slots that are yours (and of this take, when `id` is named), and any record that can't be
// read: { ok, reason? }. Someone else's record is never touched, stale or not: the next taker clears it
// under the takeover guard, where a fresh lock can't be mistaken for it.
export const free = ({ dir, resource, as, id, now = new Date(), probe }) => {
  let other = null;
  let mine = false;
  for (const name of slotNames(resource, MAX_SLOTS)) {
    const path = fileOf(dir, name);
    const held = holder(dir, name);
    if (!held) {
      if (existsSync(path)) rmSync(path, { force: true });
    } else if (isMine(held, as, id)) {
      rmSync(path, { force: true });
      mine = true;
    } else if (!stale(held, now, probe)) other ??= held;
  }
  if (!mine && other) return { ok: false, reason: `${resource} is held by ${other.as}, not ${as}; only its holder frees it` };
  if (mine) wake(dir, resource);
  return { ok: true };
};

// Renews the lock of the take `id`: its record is good for `ttl` minutes from `now`. False when it is gone
// (freed, or taken over after it went stale), so a renewal can't bring back a lock someone else now owns.
// `extra` is merged into the record (a keeper writes its own pid there).
export const refreshHolder = ({ dir, resource, id, now = new Date(), ttl = HEARTBEAT_TTL_MINUTES, extra = {} }) => {
  for (const name of slotNames(resource, MAX_SLOTS)) {
    const held = holder(dir, name);
    if (held?.id !== id) continue;
    replace(fileOf(dir, name), JSON.stringify({ ...held, ...extra, until: new Date(now.getTime() + ttl * 60_000).toISOString() }));
    return true;
  }
  return false;
};

// True when an enclosing run names a live lock on this resource.
export const heldBy = ({ dir, resource, settings, now = new Date(), probe }) => {
  const ids = settings.held.split(",").filter((item) => item.startsWith(`${resource}=`)).map((entry) => entry.slice(resource.length + 1));
  if (!ids.length) return false;
  return slotNames(resource, MAX_SLOTS).some((name) => {
    const held = holder(dir, name);
    return ids.includes(held?.id) && !stale(held, now, probe);
  });
};

export const USAGE = "usage: beefy-slot <command> …\n  beefy [-d] [--on <resource>] [--wait <minutes>] [--as <who>] [--] <command…>   queue, then run it; -d runs it in the background and prints a job id\n  beefy   (alone, on a terminal) opens the queue screen\n  jobs [--json]\n  log <id> [-f]\n  cancel <id>\n  take <resource> --as <who> [--ttl <minutes>] [--slots <n>] [--wait <minutes>] [--worker <pid>] [--ignore-load --reason <why>]\n  free <resource> --as <who>\n  status [<resource>] [--json]\n  waive <resource> --as <who> --reason <why> [--ttl <minutes>]\n  run <resource> [--as <who>] [--ttl <minutes>] [--slots <n>] [--wait <minutes>] [--ignore-load --reason <why>] -- <command…>\n  perf take --as <who> [--wait <minutes>] [--ttl <minutes>] | free --as <who> | status | waive --as <who> --reason <why>\n  config [check [--strict] | show | preset <name> [--write]]\n  -- <command…>   run a command even when its name is a verb\n  --version";

// Flags before `--`, and the command after it. `error` is a flag that is recognised but out of range.
const parse = (args) => {
  const split = args.indexOf("--");
  const own = split === -1 ? args : args.slice(0, split);
  const command = split === -1 ? [] : args.slice(split + 1);
  const opts = { ttl: DEFAULT_TTL_MINUTES, ttlGiven: false, ignoreLoad: false, wait: 0, slots: /** @type {number | undefined} */ (undefined), reason: /** @type {string | undefined} */ (undefined), id: /** @type {string | undefined} */ (undefined), pid: /** @type {number | undefined} */ (undefined), worker: /** @type {number | undefined} */ (undefined), start: /** @type {string | undefined} */ (undefined), boot: /** @type {string | undefined} */ (undefined), until: /** @type {string | undefined} */ (undefined), error: "", as: /** @type {string | undefined} */ (undefined), rest: /** @type {string[]} */ ([]), command };
  for (let i = 0; i < own.length; i++) {
    if (own[i] === "--as" && own[i + 1]) opts.as = own[++i];
    else if (own[i] === "--ttl" && /^[1-9]\d*$/.test(own[i + 1] ?? "")) {
      opts.ttl = Number(own[++i]);
      opts.ttlGiven = true;
    } else if (own[i] === "--wait" && /^\d+$/.test(own[i + 1] ?? "")) {
      opts.wait = Number(own[++i]);
      if (!(opts.wait <= MAX_WAIT_MINUTES)) opts.error = `--wait is 0 to ${MAX_WAIT_MINUTES} minutes, not ${own[i]}`;
    } else if (own[i] === "--slots" && slotCount(own[i + 1])) opts.slots = Number(own[++i]);
    else if (own[i] === "--reason" && own[i + 1]) opts.reason = own[++i];
    else if (own[i] === "--id" && own[i + 1]) opts.id = own[++i];
    else if (own[i] === "--pid" && /^[1-9]\d*$/.test(own[i + 1] ?? "")) opts.pid = Number(own[++i]);
    else if (own[i] === "--worker" && /^[1-9]\d*$/.test(own[i + 1] ?? "")) opts.worker = Number(own[++i]);
    else if (own[i] === "--start" && own[i + 1]) opts.start = own[++i];
    else if (own[i] === "--boot" && own[i + 1]) opts.boot = own[++i];
    else if (own[i] === "--until" && own[i + 1]) opts.until = own[++i];
    else if (own[i] === "--dir" && own[i + 1]) opts.dir = own[++i];
    else if (own[i] === "--every" && positive(own[i + 1])) opts.every = positive(own[++i]);
    else if (own[i] === "--ignore-load") opts.ignoreLoad = true;
    else if (own[i] === "--guard") opts.guard = true;
    else if (own[i] === "--json") opts.json = true;
    else if (own[i].startsWith("--")) return null;
    else opts.rest.push(own[i]);
  }
  return opts;
};

// Starts the process that renews a lock while its run (this process) or its `worker` lives; null when it can't start.
// With `guard` it also looks every second, and when the run is gone it stops the run's command (see `stopGroup`) and then frees the slot.
const startKeeper = ({ resource, id, until, dir, every, worker, guard }, env) => {
  try {
    const watched = worker ? ["--pid", String(worker.pid), "--start", worker.start, "--boot", worker.boot] : ["--pid", String(process.pid)];
    const child = spawnAsync(process.execPath, [fileURLToPath(import.meta.url), "keep", resource, "--id", id, ...watched, "--dir", dir, "--every", String(every), ...(until ? ["--until", until] : []), ...(guard ? ["--guard"] : [])], { detached: true, stdio: "ignore", env });
    child.on("error", () => {});
    child.unref();
    return child.pid === undefined ? null : child;
  } catch {
    return null;
  }
};

// How long a guard waits for a command to leave after SIGTERM before it sends SIGKILL; how often it looks at the run.
export const GROUP_GRACE_SECONDS = 10;
const GUARD_TICK_MS = 1000;

// The pids below `pid` in the process tree (children, their children…), from one `ps` look; [] when ps fails.
const descendants = (pid) => {
  const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 2000 });
  if (ps.status !== 0 || typeof ps.stdout !== "string") return [];
  const kids = new Map();
  for (const line of ps.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) kids.set(Number(match[2]), [...(kids.get(Number(match[2])) ?? []), Number(match[1])]);
  }
  const found = [];
  const queue = [pid];
  while (queue.length > 0) {
    for (const kid of kids.get(queue.shift()) ?? []) {
      found.push(kid);
      queue.push(kid);
    }
  }
  return found;
};

// A command's group: { pid, tree: false } is a process group of its own (pgid = pid: signal -pid); { pid, tree: true } is a command that
// shares its parent's group (on a terminal, so it stays in the foreground), reached through the process tree below it, never the whole group.
const signalGroup = (group, signal) => {
  const targets = group.tree ? [group.pid, ...descendants(group.pid)] : [-group.pid];
  for (const target of targets) {
    try {
      process.kill(target, signal);
    } catch {}
  }
  return targets;
};

// Whether the command a record names is still the process it was: its pid and start time still match (the pid alone when the record
// has no start time). A pid is reused, and a stale record must never send a signal to an unrelated process or group.
const groupIsOurs = (group, probe) => (typeof group.start === "string" && group.start !== "" && typeof group.boot === "string" ? workerState({ pid: group.pid, start: group.start, boot: group.boot }, probe) !== "dead" : alive(group.pid));

// TERM, then KILL after the grace, until nothing of the group is left (or the KILL has had 5 s): { gone }. Nothing is signalled
// when the command's identity no longer matches (it exited and its pid went to something else): { gone: true, skipped: true }.
// The KILL goes only to a group still there at the last look, so it follows this stop's own TERM.
export const stopGroup = (group, sleep, graceMs = GROUP_GRACE_SECONDS * 1000, probe) => {
  if (!groupIsOurs(group, probe)) return { gone: true, skipped: true };
  const members = new Set(signalGroup(group, "SIGTERM"));
  const up = () => (group.tree ? [...members].some((pid) => alive(pid)) : alive(-group.pid));
  for (let waited = 0; up() && waited < graceMs; waited += 100) sleep(100);
  if (up()) {
    if (group.tree) for (const pid of signalGroup(group, "SIGKILL")) members.add(pid);
    else signalGroup(group, "SIGKILL");
    for (let waited = 0; up() && waited < 5000; waited += 100) sleep(100);
  }
  return { gone: !up() };
};

// Whether text is being fed to this process (a pipe, a heredoc, `<` a file, /dev/stdin): the command gets none of it.
const stdinFed = () => {
  try {
    const stat = fstatSync(0);
    return stat.isFIFO() || stat.isFile();
  } catch {
    return false;
  }
};

// Signals a wrapper passes on to its command instead of dying of them (a SIGKILL cannot be caught).
const FORWARDED = ["SIGTERM", "SIGINT", "SIGHUP"];

// Runs the command with stdin closed, not inherited, whether it is a terminal, pipe, or file, and a guard keeper renewing `keep`'s lock meanwhile
// (stopped before this settles). Resolves to the exit code. This process is the lease, so it lives until the command is gone: SIGTERM, SIGINT and
// SIGHUP sent to it go on to the command and its children (a kill of the wrapper must not free the slot and leave the command running).
// Off a terminal the command gets a process group of its own and the signals go to that group. On a terminal it stays in this process's group,
// so it is in the foreground (a tty prompt works, Ctrl-C and Ctrl-Z reach it as they would the plain command); there SIGTERM and SIGHUP go to the
// command and the processes below it, and SIGINT is left to the terminal, which has already sent it. The record names the command's group, so
// if this process is killed outright (SIGKILL) its guard stops the command before the slot frees. `onChild({ pid })` is told once the command exists.
const defaultSpawn = (command, { env, keep, onChild }) => new Promise((resolve) => {
  const posix = process.platform !== "win32";
  const shared = posix && Boolean(process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY);
  const handlers = [];
  let child;
  let keeper = null;
  // The handlers go in before anything is spawned: a signal in the middle of the spawn must not meet the default action and leave a command behind.
  // One that arrives before the command exists is kept and applied as soon as it does.
  const pending = [];
  const forward = (signal) => {
    if (shared && signal === "SIGINT") return;
    try {
      if (posix) signalGroup({ pid: child.pid, tree: shared }, signal);
      else child.kill(signal);
    } catch {}
  };
  for (const signal of FORWARDED) {
    const handler = () => (child?.pid === undefined ? pending.push(signal) : forward(signal));
    process.on(signal, handler);
    handlers.push([signal, handler]);
  }
  const settle = (code) => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    keeper?.kill();
    resolve(code);
  };
  const fail = (error) => {
    console.error(`beefy-slot: could not start ${command[0]}: ${error.message}`);
    settle(1);
  };
  keeper = keep ? startKeeper({ ...keep, guard: true }, env) : null;
  try {
    child = spawnAsync(command[0], command.slice(1), { stdio: ["ignore", "inherit", "inherit"], env, shell: !posix, detached: posix && !shared });
  } catch (error) {
    fail(error);
    return;
  }
  child.once("error", fail);
  child.once("exit", (code, signal) => settle(signal ? 128 + (osConstants.signals[signal] ?? 0) : code ?? 1));
  if (child.pid === undefined) return;
  // The record names the command's group and its guard, so a wrapper killed from now on leaves a guard that stops the command with the slot
  // still held. The pid is only known once the command exists, so this cannot come before the spawn; the window is the few instructions between.
  const record = (extra) => keep && refreshHolder({ dir: keep.dir, resource: keep.resource, id: keep.id, extra: { ...extra, ...(keeper ? { guard: keeper.pid } : {}) } });
  record({ group: { pid: child.pid, tree: shared } });
  for (const signal of pending.splice(0)) forward(signal);
  // Then its identity (one `ps` look), which the guard checks before it signals anything: a pid can be reused.
  const identity = workerIdentity(child.pid);
  if (identity) record({ group: { pid: child.pid, tree: shared, start: identity.start, boot: identity.boot } });
  onChild?.({ pid: child.pid, identity });
});

// Words that are verbs, not commands; `keep` and `job` are internal (a lock's renewer, a detached job's wrapper).
const VERBS = ["take", "free", "run", "status", "waive", "perf", "config", "log", "jobs", "cancel", "help", "keep", "job"];

// `beefy [--on <resource>] [--wait <min>] [--as <who>] [--] <cmd…>`: a first word that is not a verb (or a `--` first) is a command.
export const isCommand = (argv) => argv.length > 0 && !VERBS.includes(argv[0]) && !["--version", "--help", "-h"].includes(argv[0]);

// The `run` argv for a command, whether it queues with no cap (no --wait given; pass it to `main` as `uncapped`), and whether `-d`
// asked for a detached job; null when a flag is not one of the four.
export const commandArgv = (argv) => {
  let on = HEAVY;
  let detach = false;
  const flags = [];
  let i = 0;
  while (i < argv.length && argv[i] !== "--" && (argv[i].startsWith("--") || argv[i] === "-d")) {
    if (argv[i] === "-d") {
      detach = true;
      i += 1;
      continue;
    }
    if (!["--on", "--wait", "--as"].includes(argv[i]) || argv[i + 1] === undefined || argv[i + 1].startsWith("--")) return null;
    if (argv[i] === "--on") on = argv[i + 1];
    else flags.push(argv[i], argv[i + 1]);
    i += 2;
  }
  const command = argv.slice(argv[i] === "--" ? i + 1 : i);
  return command.length === 0 ? null : { argv: ["run", on, ...flags, "--", ...command], uncapped: !flags.includes("--wait"), detach };
};

/** @returns {string | null} */
const defaultRefusal = () => "no judge was loaded";

// Returns the exit code: 0 done, 75 busy, 1 refused (also a command the judge stops), 2 usage; `run` returns its command's code, as a promise
// when `spawn` gives one (the real one does, so signals reach it). `job` is a detached job's wrapper hooks: `proceed()` (false skips the command),
// `started({ pid })`, `exited(code)` (before the slot is freed).
export const main = (argv, { settings, now: nowGiven, load = loadavg()[0], busiest = busiestProcess, spawn = defaultSpawn, refusal = defaultRefusal, out = console.log, err = console.error, probe, sleep = pause, uncapped = false, command: isCmd = false, job } = {}) => {
  const [verb, ...args] = argv;
  const now = nowGiven ?? new Date();
  const clock = nowGiven === undefined ? () => new Date() : undefined;
  const opts = parse(args);
  const dir = verb === "keep" ? opts?.dir : lockDir(settings);
  const resource = opts?.rest[0];
  if (!opts || (verb !== "keep" && (opts.dir !== undefined || opts.every !== undefined || opts.start !== undefined || opts.boot !== undefined || opts.guard)) || (verb !== "take" && opts.worker !== undefined) || (verb !== "status" && opts.json) || (verb !== "status" && !RESOURCE.test(resource ?? ""))) {
    err(USAGE);
    return 2;
  }
  if (opts.error) {
    err(`beefy-slot: ${opts.error}`);
    return 2;
  }
  // A resource whose config entry turns the load limit off never waits on the load: the line is out of reach.
  const loadMax = verb === "keep" ? 0 : resource === PERF ? perfLoadLine(settings) : loadGated(resource, settings) ? loadLine(settings) : Number.POSITIVE_INFINITY;
  if (verb === "status") {
    const safe = resource === undefined ? undefined : safeName(resource);
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
    const names = safe === undefined ? files : files.filter((name) => name === safe || name.startsWith(`${safe}~`));
    const lines = names.map((name) => [name, holder(dir, name)]).filter(([, held]) => held && !stale(held, now, probe));
    if (opts.json) {
      out(JSON.stringify(snapshot({ dir, settings, now, probe, load, only: resource })));
      return 0;
    }
    const line = tickets(dir, now).filter((ticket) => resource === undefined || ticket.resource === resource);
    const queued = [...new Set(line.map((ticket) => ticket.resource))].map((name) => `${name}: waiting, first come first: ${line.filter((ticket) => ticket.resource === name).map((ticket) => `${ticket.as} since ${ticket.at}`).join(", ")}`);
    out([lines.length === 0 ? "no locks held" : lines.map(([name, held]) => `${name}: ${describeHolder(held)} until ${held.until}`).join("\n"), ...queued].join("\n"));
    return 0;
  }
  if (verb === "waive") {
    if (!opts.as || !opts.reason) {
      err(`${USAGE}\nbeefy-slot: say who the waiver is for (--as) and why (--reason)`);
      return 2;
    }
    const waived = waive({ dir, resource, as: opts.as, reason: opts.reason, ttl: opts.ttlGiven ? opts.ttl : WAIVER_TTL_MINUTES, now });
    if (!waived.ok) {
      err(`beefy-slot: ${waived.reason}`);
      return 2;
    }
    out(`waived the load limit on ${resource} for ${opts.as} until ${waived.until}`);
    return 0;
  }
  if (verb === "keep") {
    if (!opts.id || !opts.pid || !opts.dir || !opts.every || (opts.start === undefined) !== (opts.boot === undefined)) {
      err(USAGE);
      return 2;
    }
    const every = opts.every * 1000;
    const cap = opts.until === undefined ? Number.POSITIVE_INFINITY : Date.parse(opts.until);
    // With --start and --boot the process watched is a worker, told from a later one by its start time.
    // It stops only when the process is known to be gone: a look that fails (ps slow on a loaded machine) keeps renewing.
    const gone = opts.start === undefined ? () => !alive(opts.pid) : () => workerState({ pid: opts.pid, start: opts.start, boot: opts.boot }, probe) === "dead";
    // The end a --ttl set goes in the record too, so it holds even if this keeper is killed.
    const capped = opts.until === undefined ? {} : { cap: opts.until };
    // A guard's run is gone: stop its command (the run's record names it), and only then free the slot. The record's `guard` is this keeper
    // until then, so the slot stays held while the command leaves.
    const release = () => {
      if (!opts.guard) return;
      const held = slotNames(opts.rest[0], MAX_SLOTS).map((name) => holder(dir, name)).find((record) => record?.id === opts.id);
      if (!held) return;
      if (held.group && typeof held.group.pid === "number") stopGroup(held.group, sleep, undefined, probe);
      free({ dir, resource, as: held.as, id: opts.id });
    };
    // Name this keeper in the record, so a repeated take for the same worker does not start a second one.
    if (gone()) {
      release();
      return 0;
    }
    if (!refreshHolder({ dir, resource, id: opts.id, extra: { keeper: process.pid, ...(opts.guard ? { guard: process.pid } : {}), ...capped } })) return 0;
    // A guard looks every second whether its run is there; the renewal stays on its own `every`.
    const tick = opts.guard ? Math.min(every, GUARD_TICK_MS) : every;
    let renewed = Date.now();
    for (;;) {
      sleep(tick);
      if (gone()) {
        release();
        return 0;
      }
      if (opts.guard && Date.now() - renewed < every) continue;
      renewed = Date.now();
      if (Date.now() >= cap || !refreshHolder({ dir, resource, id: opts.id, extra: capped })) return 0;
    }
  }
  if (verb === "take" || verb === "run") {
    if (resource === HEAVY && opts.slots !== undefined) {
      err(`beefy-slot: ${HEAVY}'s slots are the machine's (BEEFY_SLOT_HEAVY_SLOTS, else heavySlots), not a flag`);
      return 2;
    }
    if (slotsFixed(resource, settings) && opts.slots !== undefined) {
      err(`beefy-slot: ${resource}'s slots are the machine's (resources.${resource}.slots in the config file), not a flag`);
      return 2;
    }
    if (resource === PERF && opts.worker !== undefined) {
      err(`beefy-slot: ${PERF} is one holder on its own load limit; --worker is not accepted`);
      return 2;
    }
    if (resource === PERF && (opts.slots !== undefined || opts.ignoreLoad)) {
      err(`beefy-slot: ${PERF} is one holder with its own load limit; --slots and --ignore-load are not accepted. Use \`waive\` to excuse the limit.`);
      return 2;
    }
    if (opts.ignoreLoad && !opts.reason) {
      err("beefy-slot: --ignore-load needs --reason <why>; it is recorded in the lock and in waivers.log");
      return 2;
    }
  }
  if (verb === "take" || verb === "free") {
    if (!opts.as) {
      err(`${USAGE}\nbeefy-slot: --as <who> is required: a name for this job, such as my-build`);
      return 2;
    }
    // The slot lives while the worker does: its identity goes in the record, and a keeper (below) renews it.
    const worker = verb === "take" && opts.worker !== undefined ? workerIdentity(opts.worker) : undefined;
    if (verb === "take" && opts.worker !== undefined && !worker) {
      err(`beefy-slot: worker ${opts.worker} is not running, or its start time can't be read; no slot is taken for it`);
      return 1;
    }
    const result = verb === "take" ? take({ dir, resource, as: opts.as, ttl: worker ? HEARTBEAT_TTL_MINUTES : opts.ttl, worker, now, clock, load, loadMax, busiest, ignoreLoad: opts.ignoreLoad, reason: opts.reason, probe, ...queue(opts, settings) }) : free({ dir, resource, as: opts.as, now, probe });
    if (!result.ok) {
      err(`beefy-slot: ${result.reason}`);
      return verb === "take" ? (result.gone ? 1 : BUSY) : 1;
    }
    if (worker) {
      // A retry that finds its keeper alive starts no second one.
      const kept = result.refreshed ? slotNames(resource, MAX_SLOTS).map((name) => holder(dir, name)).find((held) => held?.id === result.id)?.keeper : undefined;
      const until = opts.ttlGiven ? new Date(Date.now() + opts.ttl * 60_000).toISOString() : undefined;
      if (!(kept !== undefined && alive(kept)) && !startKeeper({ resource, id: result.id, until, dir, every: settings.heartbeatSeconds, worker }, settings.childEnv)) {
        free({ dir, resource, as: opts.as, id: result.id });
        err(`beefy-slot: could not start the process that keeps ${resource} for worker ${worker.pid}; the slot is freed`);
        return 1;
      }
    }
    out(`${verb === "take" ? "took" : "freed"} ${resource}`);
    return 0;
  }
  if (verb === "run") {
    if (opts.command.length === 0) {
      err(`${USAGE}\nbeefy-slot: give the command after --`);
      return 2;
    }
    // Before the lock is taken or anything spawned: the argv judged is the argv spawned.
    const refused = refusal(opts.command);
    if (refused !== null) {
      err(`beefy-slot: refused: ${refused}`);
      return 1;
    }
    const start = (options) => {
      if (stdinFed()) err("beefy-slot: run gives its command no stdin, so what was piped in is dropped; pass it as a file argument");
      return spawn(opts.command, options);
    };
    // Inside a run that already holds this resource: the command runs, and nothing waits on its own parent.
    if (heldBy({ dir, resource, settings, now })) return start({ env: { ...settings.childEnv, ...Object.fromEntries(settings.heldNames.map((name) => [name, settings.held])) } });
    const as = opts.as ?? `run:${process.pid}`;
    const id = randomUUID();
    // A command run says where it stands in line: one line, rewritten in place on a terminal.
    const tty = isCmd && process.stderr.isTTY;
    let shown = "";
    const onWait = isCmd ? ({ ahead, reason }) => {
      // The hold is the load line when nobody is ahead and the refusal says so.
      const load = ahead === 0 && /^the machine is busy: 1-minute load is ([\d.]+), above the limit of ([\d.]+)(?:; busiest process: (.*))?\. Try again later\.$/.exec(reason ?? "");
      const line = load ? `waiting: load ${load[1]} over ${load[2]}${load[3] ? ` (busiest: ${load[3]})` : ""}` : `waiting: ${ahead} ahead on ${resource}`;
      if (line === shown) return;
      shown = line;
      process.stderr.write(tty ? `\r\x1b[2K${line}` : `${line}\n`);
    } : undefined;
    const taken = take({ dir, resource, as, id, watch: process.pid, ttl: HEARTBEAT_TTL_MINUTES, now, clock, load, loadMax, onWait, uncapped, busiest, ignoreLoad: opts.ignoreLoad, reason: opts.reason, ...queue(opts, settings) });
    if (tty && shown) process.stderr.write("\r\x1b[2K");
    if (!taken.ok) {
      err(`beefy-slot: ${taken.reason}`);
      return BUSY;
    }
    // Freed even when the command fails. A kill of this process leaves its pid dead, which frees the lock for the next taker.
    const finish = (code) => {
      try {
        job?.exited?.(code);
      } finally {
        free({ dir, resource, as, id });
      }
      return code;
    };
    let ran;
    try {
      const held = [settings.held, `${resource}=${id}`].filter(Boolean).join(",");
      const until = opts.ttlGiven ? new Date(Date.now() + opts.ttl * 60_000).toISOString() : undefined;
      ran = job?.proceed && !job.proceed() ? 143 : start({ env: { ...settings.childEnv, ...Object.fromEntries(settings.heldNames.map((name) => [name, held])) }, keep: { resource, id, until, dir, every: settings.heartbeatSeconds }, onChild: job?.started });
    } catch (error) {
      free({ dir, resource, as, id });
      throw error;
    }
    if (typeof ran?.then === "function") {
      return ran.then(finish, (error) => {
        free({ dir, resource, as, id });
        throw error;
      });
    }
    return finish(ran);
  }
  err(USAGE);
  return 2;
};

// True when Node was started on this file. Compare real paths because Node resolves
// symlinks for import.meta.url but not for argv[1], so a symlinked path would run nothing and exit 0.
const isScript = () => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isScript()) {
  if (process.argv[2] === "keep") process.exitCode = main(process.argv.slice(2));
  else {
    console.error("beefy-slot: use the bin entry point");
    process.exitCode = 2;
  }
}
