// The queue screen: running, waiting and recent jobs, one job's log, and the cancel confirm.
// Used by: src/tui.mjs (the screen's second face next to settings).
// Exports: collectQueue (the lock folder and the job records → rows), queueUpdate (a key → the next state), queueBody (state → lines of segments),
//   queueHint, queueStatus, selected, busiestDetail, processFacts, readLog, logLines, SHOWN. Everything but the collectors and readers is pure.
// Reads: `<lockDir>` holders and tickets, `<lockDir>/jobs/*` records and logs, `ps` and (for a foreground job's folder) `/proc` or `lsof`.

import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, readlinkSync, statSync } from "node:fs";
import { basename } from "node:path";

import { HEAVY, busiestProcess, liveHolders, waiting } from "./beefy-slot.mjs";
import { listJobs, logPath } from "./jobs.mjs";
import { clean, clip, cols } from "./tui-text.mjs";

const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
// By columns, not characters: a wide character takes two.
const pad = (text, width) => text + " ".repeat(Math.max(0, width - cols(text)));
const left = (text, width) => " ".repeat(Math.max(0, width - cols(text))) + text;
const short = (text, width) => (cols(text) > width ? `${clip(text, Math.max(0, width - 1))}…` : text);
// What a record may say about itself: a string, a time, a process id a signal could safely go to (above 1, never a group).
const words = (value) => (typeof value === "string" ? clean(value) : "");
const stamp = (value) => {
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : undefined;
};
export const isPid = (pid) => Number.isInteger(pid) && pid > 1;

// The width, in columns, from which a row also shows its folder and who started it (120 columns less the box).
export const WIDE = 118;
// The log's lines kept in memory, and the bytes read from its end.
const LOG_BYTES = 256 * 1024;
// A confirm box's width, and the room left for a log's view when the terminal has no row count.
const CONFIRM_WIDTH = 64;
const DEFAULT_VIEW = 14;
export const SHOWN = 4;

// 40s, 4m 12s, 1h 05m.
export const span = (seconds) => (seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s` : `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`);
// 40s ago, 2m ago, 3h ago, 2d ago.
export const ago = (seconds) => (seconds < 90 ? `${seconds}s ago` : seconds < 5400 ? `${Math.round(seconds / 60)}m ago` : seconds < 172_800 ? `${Math.round(seconds / 3600)}h ago` : `${Math.round(seconds / 86_400)}d ago`);
const secondsSince = (at, now) => Math.max(0, Math.round((now - at) / 1000));

// What a foreground run's process says about its job, from the process table: the command it runs and its folder.
// Cached by pid for FACT_MS (a miss too, so a dead pid does not run ps and lsof every tick), and at most FACT_LIMIT of them.
const facts = new Map();
const FACT_MS = 5000;
const FACT_LIMIT = 200;
const ARGS = /^(?:\S*\/)?(?:node\S*\s+)?\S*?(?:beefy-slot\.mjs|beefy-slot|beefy)\s+(.*)$/s;
const FLAG = /^(?:-d\b|--(?:on|wait|as|ttl|slots|reason)\s+\S+|--ignore-load\b)\s*/;
export const commandOf = (args) => {
  let rest = ARGS.exec(args.trim())?.[1];
  if (rest === undefined) return "";
  if (/^run\s+\S+/.test(rest)) rest = rest.replace(/^run\s+\S+\s*/, "");
  while (FLAG.test(rest)) rest = rest.replace(FLAG, "");
  return clean(rest.replace(/^--\s*/, "").trim());
};
// `fresh` skips the cache (the check just before a signal). `run` is a test seam for spawnSync.
export const processFacts = (pid, { fresh = false, now = Date.now(), run = spawnSync } = {}) => {
  if (!isPid(pid)) return { command: "", cwd: "" };
  const cached = facts.get(pid);
  if (!fresh && cached && now - cached.at < FACT_MS) return cached.found;
  const ps = run("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
  let cwd = "";
  try {
    cwd = readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    const lsof = run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 2000 });
    cwd = /^n(.*)$/m.exec(lsof.stdout ?? "")?.[1] ?? "";
  }
  const found = { command: ps.status === 0 ? commandOf(ps.stdout ?? "") : "", cwd: clean(cwd) };
  facts.delete(pid);
  facts.set(pid, { at: now, found });
  if (facts.size > FACT_LIMIT) facts.delete(facts.keys().next().value);
  return found;
};

// The process using the most CPU, with how many cores that is and how long it has run: { pid, name, cores, started } or null.
// busiestProcess names it (`pid command (cpu%)`); the start comes from `ps etime`.
export const busiestDetail = (run = busiestProcess) => {
  const match = /^(\d+) (.+) \(([\d.]+)%\)$/.exec(run());
  if (!match) return null;
  const etime = spawnSync("ps", ["-o", "etime=", "-p", match[1]], { encoding: "utf8", timeout: 2000 }).stdout?.trim() ?? "";
  const parts = etime.split(/[-:]/).map(Number);
  const [days, hours, minutes, seconds] = etime.includes("-") ? parts : [0, ...(parts.length === 3 ? parts : [0, ...parts])];
  return { pid: Number(match[1]), name: clean(basename(match[2])), cores: Number(match[3]) / 100, started: etime && parts.every(Number.isFinite) ? days * 86_400 + hours * 3600 + minutes * 60 + seconds : null };
};

const WHO = /^run:\d+$/;
const whoOf = (as) => (as === "" || WHO.test(as) ? "you" : as);

// Every job as a row: running, then waiting (place in line), then recent. Sources: the job records (detached jobs) and the lock folder's
// holders and tickets (a foreground run has no record, so its command and folder come from its process). `holdersOf`, `lineOf`, `info` are test seams.
// Everything read from a file or a process is made a string, a time or a safe pid here, so what is drawn never throws or sends a control code.
// A foreground run can be cancelled only when its process still looks like a beefy run: a stale record's pid may be somebody else's now.
export const collectQueue = ({ dir, snap, now = Date.now(), jobs = listJobs(dir), holdersOf = liveHolders, lineOf = waiting, info = processFacts }) => {
  const when = new Date(now);
  const wrapperOf = (job) => (job.wrapper && typeof job.wrapper === "object" ? job.wrapper.pid : undefined);
  const wrappers = new Set(jobs.filter((job) => job.state === "running" || job.state === "waiting").map(wrapperOf));
  const running = [];
  const waits = [];
  const recent = [];
  const line = new Map();
  const slotOf = new Map();
  const foreground = (record, entry, key) => {
    const pid = isPid(record.pid) ? record.pid : undefined;
    const known = pid ? info(pid) : { command: "", cwd: "" };
    const as = words(record.as);
    return { key: pid ? `fg:${pid}` : key, id: pid ? `p${pid}` : "p?", resource: entry.name, mode: "foreground", command: words(known.command) || as, cwd: words(known.cwd), who: whoOf(as), since: stamp(record.at) ?? now, pid, cancellable: Boolean(pid) && known.command !== "" };
  };
  for (const entry of snap.resources) {
    const tickets = lineOf(dir, entry.name, when);
    line.set(entry.name, tickets);
    for (const held of holdersOf(dir, entry.name, when)) {
      if (wrappers.has(held.pid)) {
        slotOf.set(held.pid, held.slot);
        continue;
      }
      if (held.watch !== undefined) running.push({ ...foreground(held, entry, `fg:${entry.name}:${held.slot}`), section: "running", slot: held.slot });
      else running.push({ key: `lock:${held.slot}`, id: "lock", section: "running", resource: entry.name, mode: "lock", command: words(held.as), cwd: "", who: whoOf(words(held.as)), since: stamp(held.at) ?? now, slot: held.slot, pid: undefined, cancellable: false });
    }
    tickets.forEach((ticket, index) => {
      if (wrappers.has(ticket.pid)) return;
      waits.push({ ...foreground(ticket, entry, `ticket:${entry.name}:${index}`), section: "waiting", place: index + 1, yield: Boolean(ticket.yield) });
    });
  }
  for (const job of jobs) {
    const state = typeof job.state === "string" ? job.state : "lost";
    const resource = words(job.resource) || HEAVY;
    const wrapper = isPid(wrapperOf(job)) ? wrapperOf(job) : undefined;
    const item = { key: `job:${job.id}`, id: words(job.id), resource, mode: "detached", command: job.command.map((part) => words(typeof part === "string" ? part : String(part))).join(" "), cwd: words(job.cwd), who: whoOf(words(job.as)), since: (state === "running" ? stamp(job.started) : undefined) ?? stamp(job.created) ?? now, ended: stamp(job.finished), state, exit: Number.isInteger(job.exit) ? job.exit : undefined, pid: wrapper, log: logPath(dir, job.id), slot: slotOf.get(wrapper), job: true, cancellable: state === "running" || state === "waiting" || state === "lost" };
    if (state === "running") running.push({ ...item, section: "running" });
    else if (state === "waiting") {
      const at = (line.get(resource) ?? []).findIndex((ticket) => ticket.pid === wrapper);
      waits.push({ ...item, section: "waiting", place: at >= 0 ? at + 1 : (line.get(resource)?.length ?? 0) + 1, yield: false });
    } else recent.push({ ...item, section: "recent" });
  }
  running.sort((a, b) => a.since - b.since);
  waits.sort((a, b) => (a.resource === b.resource ? a.place - b.place : snap.resources.findIndex((entry) => entry.name === a.resource) - snap.resources.findIndex((entry) => entry.name === b.resource)));
  // The first in line is held by the load when a slot is open and the load is over the limit.
  for (const entry of snap.resources) {
    if (entry.loadMax === null || snap.load <= entry.loadMax || entry.slots - entry.holders.length <= 0) continue;
    const first = waits.find((item) => item.resource === entry.name && !item.yield);
    if (first) first.loadHold = true;
  }
  return { items: [...running, ...waits, ...recent] };
};

// The row the cursor is on: the one picked, else the first running, waiting, failed or finished.
export const selected = (state, ctx) => {
  const items = ctx.queue?.items ?? [];
  return items.find((item) => item.key === state.pick) ?? items.find((item) => item.section === "running") ?? items.find((item) => item.section === "waiting") ?? items.find((item) => item.state === "failed" || item.state === "lost") ?? items[0];
};

// A job's log as lines: the command and folder first, then what the file holds. `text` is null for a job with no file (a foreground run).
export const logLines = (item, text) => {
  const folder = item.cwd ? item.cwd.split("/").slice(-2).join("/") : "";
  // A carriage return inside a line is a progress bar redrawing itself: what a terminal would show is what follows the last one.
  const body = text === null || text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/).map((one) => clean(one.split("\r").findLast((part) => part !== "") ?? ""));
  return [`$ ${item.command}${folder ? `  (${folder})` : ""}`, "", ...body];
};

// The tail of a file, as text: null when it is not there.
export const readLog = (path) => {
  try {
    const size = statSync(path).size;
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(size, LOG_BYTES));
      readSync(fd, buffer, 0, buffer.length, size - buffer.length);
      return buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
};

const viewOf = (ctx) => Math.max(3, ctx.logRows ?? DEFAULT_VIEW);
const listOf = (state, ctx) => (ctx.logView?.key === state.log?.key ? ctx.logView.lines : []);

// One key on the queue or the log: { state, effect?, target? }, or null to let the shared keys (q, c, ?) have it.
// Effects: "cancel" (target: the row), done by the loop.
export const queueUpdate = (state, key, ctx) => {
  const next = { ...state, message: "", leaving: false };
  const set = (changes) => ({ state: { ...next, ...changes } });
  if (key === "q" || key === "c" || key === "?") return null;
  const items = ctx.queue?.items ?? [];
  const here = selected(state, ctx);
  if (state.screen === "log") {
    const total = listOf(state, ctx).length;
    const view = viewOf(ctx);
    const top = state.log.top ?? Math.max(0, total - view);
    const scroll = (to) => set({ log: { ...state.log, top: clamp(to, 0, Math.max(0, total - view)) } });
    if (key === "escape" || key === "backspace" || key === "h") return set({ screen: "queue", log: null });
    if (key === "tab") return set({ screen: "settings", log: null });
    if (key === "up" || key === "k" || key === "w") return scroll(top - 1);
    if (key === "down" || key === "j" || key === "s") return scroll(top + 1);
    if (key === "pgup") return scroll(top - view);
    if (key === "pgdn") return scroll(top + view);
    if (key === "f") return set({ log: { ...state.log, top: state.log.top === null ? Math.max(0, total - view) : null } });
    if (key === "x") return here?.cancellable ? set({ screen: "queue", log: null, confirm: here.key, pick: here.key }) : set({ message: "this one is not running" });
    return set({});
  }
  if (state.confirm) {
    const target = items.find((item) => item.key === state.confirm);
    if (key === "y" && target?.cancellable) return { state: { ...next, confirm: null }, effect: "cancel", target };
    if (key === "y" && target) return set({ confirm: null, message: `${target.id} already ended` });
    if (key === "y" || key === "n" || key === "escape") return set({ confirm: null });
    return set({});
  }
  const at = items.findIndex((item) => item.key === here?.key);
  const move = (by) => (items.length ? set({ pick: items[clamp(at + by, 0, items.length - 1)].key }) : set({}));
  if (key === "up" || key === "k" || key === "w") return move(-1);
  if (key === "down" || key === "j" || key === "s") return move(1);
  if (key === "tab") return set({ screen: "settings" });
  if ((key === "l" || key === "return") && here) return set({ screen: "log", log: { key: here.key, top: null }, pick: here.key });
  if (key === "x" && here) {
    if (here.cancellable) return set({ confirm: here.key, pick: here.key });
    return set({ message: here.section === "recent" ? `${here.id} already ended` : here.mode === "foreground" ? "no beefy run found behind this one: `beefy-slot free` if it is stale" : "a held lock, not a command: free it with `beefy-slot free`" });
  }
  return set({});
};

// The right end of the first line: what the screen is about, and how it stands.
export const queueStatus = (state, ctx, width = 78) => {
  const items = ctx.queue?.items ?? [];
  const run = items.filter((item) => item.section === "running").length;
  const wait = items.filter((item) => item.section === "waiting").length;
  const held = items.some((item) => item.loadHold);
  const heavy = ctx.snap.resources.find((entry) => entry.name === HEAVY);
  const parts = [];
  if (run) parts.push(`${run} running`);
  if (wait) parts.push(held ? `${wait} waiting for load` : `${wait} waiting`);
  if (state.screen === "log") {
    const item = items.find((candidate) => candidate.key === state.log?.key);
    if (!item) return [["dim", "gone"]];
    const verdict = { running: ["beef", `● running ${span(secondsSince(item.since, ctx.now))}`], waiting: ["warn", `● waiting ${span(secondsSince(item.since, ctx.now))}`], done: ["ok", "● done · exit 0"], failed: ["err", `● failed · exit ${item.exit ?? "?"}`], cancelled: ["warn", "● cancelled"], lost: ["err", "● lost"] }[item.state ?? (item.section === "running" ? "running" : "waiting")];
    const room = Math.max(8, width - 16 - 12 - 4 - cols(verdict[1]) - 1 - cols(item.id) - 3);
    return [["dim", `${item.id} · ${short(item.command, room)}`], ["", "  "], verdict];
  }
  const recent = items.filter((item) => item.section === "recent").length;
  return [["dim", `${HEAVY} · ${heavy?.slots ?? 1} slot${(heavy?.slots ?? 1) === 1 ? "" : "s"}`], ["", "  "], parts.length ? [held ? "warn" : "beef", `● ${parts.join(" · ")}`] : ["dim", recent ? `● idle · ${recent} finished` : "● idle"]];
};

// Whether the screen shows the load beside the memory: not while nothing runs or waits.
export const showsLoad = (state, ctx) => state.screen === "log" || (ctx.queue?.items ?? []).some((item) => item.section !== "recent");

// The keys named at the foot, as [label, key] (a label may be a list for keys that are one word of several).
export const queueHint = (state, ctx) => {
  const here = selected(state, ctx);
  const items = ctx.queue?.items ?? [];
  const hint = (...parts) => [["", "  "], ...parts.flatMap((part, index) => [...(index ? [["", "   "]] : []), ...part])];
  const key = (label, name) => [["dim", label, { keys: [name] }]];
  if (state.screen === "log") return hint([["dim", "↑", { keys: ["up"] }], ["dim", "↓", { keys: ["down"] }], ["dim", " "], ["dim", "pgup", { keys: ["pgup"] }], ["dim", " "], ["dim", "pgdn", { keys: ["pgdn"] }], ["dim", " scroll"]], key("f follow", "f"), ...(here?.cancellable ? [key("x cancel job", "x")] : []), key("esc back", "escape"));
  if (state.confirm) return hint(key("y cancel it", "y"), key("n keep it", "n"), key("esc back", "escape"));
  return hint(...(items.length ? [[["dim", "↑", { keys: ["up"] }], ["dim", "↓", { keys: ["down"] }], ["dim", " select"]]] : []), ...(here?.cancellable ? [key("x cancel", "x")] : []), ...(here ? [key("l log", "l")] : []), key("tab settings", "tab"), key("? help", "?"), key("q quit", "q"));
};

const HELP = ["↑ ↓  w s  k j     select a job", "x                 cancel the selected job, after a confirm", "l  enter          the job's log", "f                 in a log: follow the end, or stop following", "esc               back from a log or a confirm", "tab               settings: slots, load, perf host, command rules, sources", "click             a row, or any key named on screen", "c                 call the cow", "", "Run a command and it joins the line: `beefy <cmd>`, or `beefy -d <cmd>` in the background."];

// The words that wrap at `size` columns, split at spaces.
const wrap = (text, size) => {
  const out = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current && cols(current) + 1 + cols(word) > size) {
      out.push(current);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  return current ? [...out, current] : out;
};

// The screen's body as lines of [style, text, action?] segments; a line may carry `.action`, what a click on it does.
// `fit` is how many lines the body may take; a longer list scrolls to keep the cursor in sight, and the confirm box stays whole.
export const queueBody = (state, ctx, { width = 78, fit = Infinity } = {}) => {
  const lines = [];
  const line = (...segments) => {
    lines.push(segments);
    return segments;
  };
  const items = ctx.queue?.items ?? [];
  const here = selected(state, ctx);
  const tick = ctx.tick ?? 0;
  const now = ctx.now ?? Date.now();
  const home = ctx.home ?? "";
  const heavy = ctx.snap.resources.find((entry) => entry.name === HEAVY);
  const shown = (path) => (path.startsWith(`${ctx.cwd ?? "\0"}/`) ? `./${path.slice(ctx.cwd.length + 1)}` : home && path.startsWith(home) ? `~${path.slice(home.length)}` : path);

  if (state.help) {
    for (const text of HELP) line(["", `  ${text}`]);
    return lines;
  }

  if (state.screen === "log") {
    const item = items.find((candidate) => candidate.key === state.log?.key);
    const all = listOf(state, ctx);
    const view = Number.isFinite(fit) ? Math.max(3, fit - 1) : viewOf(ctx);
    const top = state.log.top === null ? Math.max(0, all.length - view) : clamp(state.log.top, 0, Math.max(0, all.length - view));
    const saved = item?.log ? shown(item.log) : "";
    if (!item) line(["dim", "  that job is gone"]);
    else if (!item.log) line(["dim", "  no saved output · a foreground job prints to the terminal that started it"]);
    else line(["dim", `  ${state.log.top === null ? "following" : `paused · showing ${all.length ? top + 1 : 0}-${Math.min(all.length, top + view)}`} · ${all.length} lines · output is saved to ${saved}`]);
    const digits = Math.max(4, String(all.length).length);
    all.slice(top, top + view).forEach((text, index) => {
      const style = top + index === 0 ? "dim" : /^\s*✓/.test(text) ? "ok" : /^\s*✗/.test(text) ? "err" : /^\s*…/.test(text) ? "warn" : "";
      line(["dim", `${left(String(top + index + 1), digits)}  `], ...(text ? [[style, short(clean(text), width - digits - 4)]] : []));
    });
    return lines;
  }

  const wide = width >= WIDE;
  const idw = Math.max(4, ...items.map((item) => cols(item.id) + 2));
  const head = (label, right) => line(["bold", `  ${label}`], ["", " ".repeat(Math.max(1, width - 2 - label.length - cols(right) - 1))], ["dim", right], ["", " "]);
  const row = (item) => {
    const chosen = item.key === here?.key;
    const mark = chosen ? ["beef", " ▸ "] : ["", "   "];
    const glyph = tick % 10 < 5 ? "▚" : "▞";
    const badge = item.section === "running" ? ["beef", `${["██", "██", "▓█", "▒▓", "▓▒", "█▓"][Math.floor(tick / 2) % 6]} `] : item.section === "waiting" ? ["warn", pad(item.place > 9 ? `${glyph}+` : `${glyph}${item.place}`, 3)] : item.state === "done" ? ["ok", "✓  "] : item.state === "failed" ? ["err", "✗  "] : ["warn", item.state === "cancelled" ? "–  " : "?  "];
    const style = chosen ? "bold" : "";
    const clock = item.section === "recent" ? null : span(secondsSince(item.since, now));
    const end = item.section === "recent" ? [[item.state === "done" ? "ok" : item.state === "failed" ? "err" : "warn", pad(item.state === "done" || item.state === "failed" ? `exit ${item.exit ?? "?"}` : item.state === "cancelled" ? "cancel" : item.state, 6)], ["dim", left(ago(secondsSince(item.ended ?? item.since, now)), 8)]] : [["dim", left(clock, 6)]];
    const command = item.resource === HEAVY ? item.command : `[${item.resource}] ${item.command}`;
    const bits = [mark, badge, [style, pad(item.id, idw)]];
    if (wide) bits.push([style, pad(short(command, 33), 34)], ["dim", pad(item.mode, 11)], ["dim", pad(short(item.cwd.split("/").slice(-2).join("/") || "", 23), 24)], ["dim", pad(short(item.who, 11), 12)], ["", " ".repeat(Math.max(1, width - (10 + idw - 4 + 34 + 11 + 24 + 12) - (item.section === "recent" ? 14 : 6) - 1))], ...end, ["", " "]);
    else if (item.section === "recent") bits.push([style, pad(short(command, width - 23 - idw), width - 22 - idw)], ["", " "], ...end, ["", " "]);
    else bits.push([style, pad(short(command, width - 29 - (idw - 4)), width - 28 - (idw - 4))], ["dim", pad(item.mode, 11)], ...end, ["", " "]);
    const out = line(...bits);
    out.action = { pick: item.key };
    return out;
  };

  const running = items.filter((item) => item.section === "running");
  const waits = items.filter((item) => item.section === "waiting");
  const recent = items.filter((item) => item.section === "recent");
  const slots = heavy?.slots ?? 1;
  const taken = running.filter((item) => item.resource === HEAVY).length;
  const quiet = (text) => line(["dim", `     ${text}`]);
  head("running", `${HEAVY} · ${running.length ? `${taken} of ${slots}` : slots} slot${slots === 1 ? "" : "s"}`);
  // The lines the cursor's row and its details take, so a long list can scroll to them.
  let cursor = null;
  const mine = (item, draw) => {
    const from = lines.length;
    draw();
    if (item.key === here?.key) cursor = { from, to: lines.length - 1 };
  };
  for (const item of running) mine(item, () => row(item));
  for (let free = taken; free < slots; free++) line(["", "     "], ["dim", "░░ free   "]);
  line();
  head("waiting", waits.length && !waits.some((item) => item.loadHold) ? "first in line starts the moment the slot frees" : "");
  if (!waits.length) quiet("nobody in line");
  for (const item of waits) mine(item, () => {
    row(item);
    if (item.loadHold && item.key === here?.key) {
      const load = ctx.snap.load;
      const limit = ctx.snap.resources.find((entry) => entry.name === item.resource)?.loadMax ?? 0;
      const filled = clamp(Math.round((load / limit) * 40), 0, 40);
      const busiest = ctx.busiest;
      const lead = wrap("Waiting for the load to drop. A slot is free, but the machine is too busy to add a job.", width - 5);
      for (const text of lead) line(["", "     "], ["warn", text]);
      line();
      line(["", "     "], ["dim", "load 1 min  "], [load > limit ? "err" : "beef", "█".repeat(filled)], ...(load > limit ? [["err", "▏"]] : [["dim", "░".repeat(40 - filled)]]), [load > limit ? "err" : "", ` ${load.toFixed(1)}`], ["dim", `  limit ${limit.toFixed(1)}`]);
      if (busiest) line(["", "     "], ["dim", "busiest     "], ["bold", busiest.name], ["dim", `  pid ${busiest.pid} · ${Math.round(busiest.cores * 10) / 10} of ${ctx.cores} cores${busiest.started === null ? "" : ` · started ${ago(busiest.started).replace(" ago", "")} ago`}`]);
      line(["", "     "], ["dim", `starts when load is under ${limit.toFixed(1)} · change the limit in settings › Load`]);
    }
  });
  line();
  head("recent", !recent.length ? "" : here?.section === "recent" ? "detached jobs stay until 50 newer ones push them off" : waits.some((item) => item.loadHold && item.key === here?.key) ? "" : "last 50 stay");
  if (!recent.length) quiet("no jobs yet");
  for (const item of recent) mine(item, () => {
    row(item);
    const tail = ctx.tail?.key === item.key && item.key === here?.key && (item.state === "failed" || item.state === "lost") ? ctx.tail.lines.slice(-SHOWN) : [];
    if (tail.length) {
      const box = width - 10;
      line(["", "     "], ["dim", `┌${"─".repeat(box - 2)}┐`]);
      for (const text of tail) line(["", "     "], ["dim", "│ "], ["", pad(short(clean(text), box - 4), box - 4)], ["dim", " │"]);
      line(["", "     "], ["dim", `└${"─".repeat(box - 2)}┘`]);
      line(["", "     "], ["dim", `last ${tail.length} lines · `], ["beef", "l  full log", { keys: ["l"] }], ["dim", ` · or  beefy log ${item.id}`]);
    }
  });
  const boxFrom = lines.length;
  if (state.confirm) {
    const target = items.find((item) => item.key === state.confirm);
    if (target) {
      const size = Math.min(CONFIRM_WIDTH, width - 6);
      const inside = size - 4;
      const next = waits.find((item) => item.resource === target.resource && item.key !== target.key && !item.yield);
      const text = !target.cancellable ? "It has already ended; there is nothing to cancel." : target.state === "lost" ? "Its wrapper is gone, so the command may still be running. Beefy stops what is left of it." : target.section === "running" ? `It is running, ${span(secondsSince(target.since, now))} in. Beefy stops the command and everything it started, ${next ? `then ${next.id} takes the slot at once.` : "and the slot frees at once."}` : `It is waiting, number ${target.place} in line. Beefy takes it out of the line; nothing has run yet.`;
      const box = (...parts) => line(["", "   "], ["dim", "│ "], ...parts, ["dim", " │"]);
      line(["", "   "], ["dim", `┌${"─".repeat(size - 2)}┐`]);
      const title = short(`Cancel ${target.id}  ${target.command}?`, inside);
      box(["bold", title], ["", " ".repeat(inside - cols(title))]);
      box(["", pad("", inside)]);
      for (const part of wrap(text, inside)) box(["", pad(part, inside)]);
      box(["", pad("", inside)]);
      box(["err", "y  cancel it", { keys: ["y"] }], ["", "      "], ["dim", "n  keep it", { keys: ["n"] }], ["", " ".repeat(inside - 28)]);
      line(["", "   "], ["dim", `└${"─".repeat(size - 2)}┘`]);
    }
  }
  const boxTo = lines.length;
  if (!items.length) {
    line();
    line(["dim", "   Run a command and it joins the line:"]);
    line();
    line(["", "     "], ["beef", "beefy pnpm check"]);
    line(["", "     "], ["beef", "beefy -d npm test"], ["dim", "    -d runs it in the background and returns a job id"]);
  }
  if (lines.length <= fit) return lines;
  // Too long for the room: the confirm box stays whole, the rest scrolls so the cursor's row (and what hangs under it) shows.
  const box = lines.splice(boxFrom, boxTo - boxFrom);
  const room = Math.max(1, fit - box.length);
  if (lines.length > room) {
    const start = cursor && cursor.to >= room ? Math.min(cursor.from, cursor.to - room + 1) : 0;
    lines.splice(0, start);
    lines.length = Math.min(lines.length, room);
  }
  return [...lines, ...box];
};
