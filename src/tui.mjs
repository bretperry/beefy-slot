// The terminal screens: the queue (running, waiting and recent jobs, a job's log) and settings (five sections over the machine's config file).
// Used by: bare `beefy` on a terminal (the queue) and `beefy config` (settings). The queue's own code is in tui-queue.mjs.
// Exports: frame (the box and what runs round it), jobsOf, createState, update (a key → the next state and an effect), render (state → lines of text),
//   screen, hitAt (what a click does), parseInput, the cow, admission, diff, runTui (the terminal loop). update and render touch nothing outside their arguments.
// Writes: runTui saves ~/.beefy-slot/config.json when asked (S), cancels a job when asked (x, then y), and may call ssh (the probe) and, on a keypress, the judge.
// Draws only text it has made safe: whatever came from a file or a lock record has its escape sequences and control characters removed (clean, in tui-text.mjs).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { availableParallelism, constants, homedir, loadavg } from "node:os";
import { dirname, resolve } from "node:path";

import { HEAVY, MAX_SLOTS, PERF, resolveSettings, snapshot } from "./beefy-slot.mjs";
import { checkConfig } from "./check.mjs";
import { MACHINE_KEYS, MAX_HEARTBEAT_SECONDS, MAX_POLL_SECONDS, hashOf, inspectMachineFile, loadConfig, machineConfigPath, machineConfigText, validate, writeMachineConfig } from "./config.mjs";
import { cancelJob } from "./jobs.mjs";
import { loadJudge, quoteCommand } from "./judge.mjs";
import { HOST } from "./perf.mjs";
import { PRESETS, preset } from "./presets.mjs";
import { busiestDetail, collectQueue, isPid, logLines, processFacts, queueBody, queueHint, queueStatus, queueUpdate, readLog, selected, showsLoad, SHOWN } from "./tui-queue.mjs";
import { clean, clip, cols } from "./tui-text.mjs";
import { coreLoads, coreTimes, readMemory } from "./vitals.mjs";

export const TABS = ["Slots", "Load", "Perf host", "Command rules", "Sources"];
const ABOUT = ["how many jobs run at once, for each resource", "a job waits while the machine is busier than the limit", "where timing runs happen", "the judge that vets commands", "which file each value comes from"];
const RESOURCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
const clone = (value) => JSON.parse(JSON.stringify(value));
const tidy = (n) => Math.round(n * 10) / 10;

// The config in effect while editing: the project file's keys under the draft's.
const merged = (state, ctx) => ({ ...ctx.project?.config, ...state.draft });
export const effective = (state, ctx) => resolveSettings({ env: ctx.env, config: merged(state, ctx), cores: ctx.cores, home: ctx.home, err: () => {} });

// The rows a section lets the cursor rest on.
export const rowsOf = (state, ctx) => {
  if (state.tab === 0) return [HEAVY, ...Object.keys(merged(state, ctx).resources ?? {})];
  if (state.tab === 1) return ["loadMax", "pollSeconds", "heartbeatSeconds"];
  if (state.tab === 2) return ["perfHost", "perfLoadMax"];
  if (state.tab === 3) return ["judge", "try"];
  return ["lockDir", ...unknownKeys(state.draft)];
};

// Keys in a config this version does not know (a newer version wrote them): kept as they are until the ledger's x removes one.
const KNOWN = [...MACHINE_KEYS, "judge"];
export const unknownKeys = (config) => Object.keys(config).filter((key) => !KNOWN.includes(key));

// `blocked` is why a save is refused (a file the screen could not read: it will not write over it); `fault` is a
// line kept on screen under the sections until it no longer applies. `screen` is the one it opens on ("settings" or "queue").
export const createState = (machineConfig = {}, { screen = "settings", blocked = "", fault = "" } = {}) => ({ screen, pick: null, confirm: null, log: null, tab: 0, sel: 0, draft: clone(machineConfig), saved: clone(machineConfig), input: null, message: "", help: false, leaving: false, presetAt: -1, command: "", verdict: null, blocked, fault });

// Lines of "key: was → now" between the saved file and the draft, resources one per name.
export const diff = (saved, draft) => {
  const flat = (config) => {
    const out = {};
    for (const [key, value] of Object.entries(config)) {
      if (key === "resources") for (const [name, entry] of Object.entries(value)) out[`resources.${name}`] = JSON.stringify(entry);
      else out[key] = JSON.stringify(value);
    }
    return out;
  };
  const a = flat(saved);
  const b = flat(draft);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => a[key] !== b[key]).map((key) => ({ key, was: a[key], now: b[key] }));
};

// Whether a take of this resource would get a slot now, from one entry of a snapshot: { ok, why }.
export const admission = (entry, load) => {
  const open = entry.slots - entry.holders.length;
  if (open <= 0) return { ok: false, why: `pool full (${entry.holders.length} of ${entry.slots})${entry.waiting.length ? ` · ${entry.waiting.length} waiting` : ""}` };
  if (entry.loadMax !== null && load > entry.loadMax) return { ok: false, why: `load ${load.toFixed(1)} over ${entry.loadMax.toFixed(1)}` };
  const ahead = entry.waiting.filter((ticket) => !ticket.yield).length;
  if (ahead >= open) return { ok: false, why: `${ahead} waiting ahead` };
  return { ok: true, why: `${entry.holders.length} of ${entry.slots} slot${entry.slots === 1 ? "" : "s"} used · ${entry.loadMax === null ? "no load limit" : `load ${load.toFixed(1)} under ${entry.loadMax.toFixed(1)}`}` };
};

// The draft's resources, copied from the config in effect the first time one is edited.
const ownResources = (state, ctx) => clone(merged(state, ctx).resources ?? {});

// A typed value as the key takes it: { value } or { error }.
const typed = (target, text, state, ctx) => {
  const value = text.trim();
  if (target === "new") {
    if (!RESOURCE.test(value)) return { error: "a name is up to 64 letters, digits, . _ : -" };
    if (value === HEAVY || value === PERF) return { error: `${value} is reserved` };
    if (Object.hasOwn(merged(state, ctx).resources ?? {}, value)) return { error: `${value} is already there` };
    return { value };
  }
  if (["loadMax", "pollSeconds", "heartbeatSeconds", "perfLoadMax"].includes(target)) {
    const n = Number(value);
    return value !== "" && Number.isFinite(n) && n > 0 ? { value: n } : { error: "a positive number" };
  }
  return { value };
};

// One key → { state, effect }. Effects (done by the loop): "save", "probe", "judge", "quit", "import".
export const update = (state, key, ctx) => {
  const next = { ...state, message: "", leaving: false };
  const set = (changes) => ({ state: { ...next, ...changes } });
  const draft = (changes, extra = {}) => {
    const config = { ...next.draft, ...changes };
    for (const name of Object.keys(config)) if (config[name] === undefined) delete config[name];
    const problem = validate(config, { machine: true, keepUnknown: true });
    return problem ? set({ message: problem }) : set({ draft: config, ...extra });
  };
  // The draft as a whole (a preset), not laid over the old one: a key the new config lacks is gone.
  const replace = (config, extra) => {
    const problem = validate(config, { machine: true, keepUnknown: true });
    return problem ? set({ message: problem }) : set({ draft: config, ...extra });
  };
  if (key === "ctrl-c") return { state: next, effect: "quit" };
  if (state.input) {
    const input = state.input;
    if (key === "escape") return set({ input: null });
    if (key === "backspace") return set({ input: { ...input, text: input.text.slice(0, -1) } });
    if (key === "return") {
      if (input.target === "try") return { state: { ...next, input: null, command: input.text.trim(), verdict: null }, effect: input.text.trim() ? "judge" : undefined };
      const got = typed(input.target, input.text, state, ctx);
      if (got.error) return set({ message: got.error });
      if (input.target === "new") return draft({ resources: { ...ownResources(state, ctx), [got.value]: { slots: 1 } } }, { input: null, sel: Object.keys(merged(state, ctx).resources ?? {}).length + 1 });
      return draft({ [input.target]: got.value === "" ? undefined : got.value }, { input: null });
    }
    if (key.length === 1 || key === "space") return set({ input: { ...input, text: input.text + (key === "space" ? " " : key) } });
    return set({});
  }
  if (state.help) return set({ help: false });
  if (state.screen !== "settings") {
    const got = queueUpdate(state, key, ctx);
    if (got) return got;
  }
  const rows = rowsOf(state, ctx);
  const row = rows[clamp(state.sel, 0, rows.length - 1)];
  const eff = effective(state, ctx);
  if (/^[1-5]$/.test(key)) return set({ tab: Number(key) - 1, sel: 0 });
  if (key === "tab") return set({ screen: "queue" });
  if (key === "]") return set({ tab: (state.tab + 1) % TABS.length, sel: 0 });
  if (key === "[") return set({ tab: (state.tab + TABS.length - 1) % TABS.length, sel: 0 });
  // Two hands' worth of arrows: w a s d, and h j k l (vim's).
  if (key === "up" || key === "w" || key === "k") return set({ sel: clamp(state.sel - 1, 0, rows.length - 1) });
  if (key === "down" || key === "s" || key === "j") return set({ sel: clamp(state.sel + 1, 0, rows.length - 1) });
  if (key === "?") return set({ help: true });
  if (key === "c") return { state: next, effect: "cow" };
  if ((key === "S" || key === "ctrl-s") && state.blocked) return set({ message: state.blocked });
  if (key === "S" || key === "ctrl-s") return diff(state.saved, state.draft).length ? { state: next, effect: "save" } : set({ message: "nothing to save" });
  if (key === "u") return set({ draft: clone(state.saved), presetAt: -1, message: "changes undone" });
  if (key === "q" || key === "ctrl-c") {
    if (key === "q" && diff(state.saved, state.draft).length && !state.leaving) return set({ leaving: true, message: "unsaved changes: S saves, q again leaves without saving" });
    return { state: next, effect: "quit" };
  }
  const step = key === "right" || key === "d" || key === "l" || key === "+" || key === "=" ? 1 : key === "left" || key === "a" || key === "h" || key === "-" ? -1 : 0;
  if (state.tab === 0) {
    if (step && row === HEAVY) return draft({ heavySlots: clamp(eff.heavySlots + step, 1, MAX_SLOTS) });
    if (step || key === "space") {
      if (row === HEAVY) return set({ message: "heavy always has the load limit" });
      const resources = ownResources(state, ctx);
      const entry = { ...resources[row] };
      if (step) entry.slots = clamp((entry.slots ?? 1) + step, 1, MAX_SLOTS);
      else entry.loadGate = entry.loadGate === false;
      return draft({ resources: { ...resources, [row]: entry } });
    }
    if (key === "n") return set({ input: { target: "new", label: "new resource name", text: "" } });
    if (key === "x") {
      if (row === HEAVY) return set({ message: "heavy cannot be removed" });
      const resources = ownResources(state, ctx);
      delete resources[row];
      return draft({ resources }, { sel: Math.max(0, state.sel - 1) });
    }
    if (key === "p") {
      const names = Object.keys(PRESETS);
      const at = (state.presetAt + 1) % names.length;
      // As `config preset <name>` does it, over the draft; the project file's resources stay in play when the preset sets its own.
      const next2 = preset(names[at], state.draft, ctx.cores);
      if (next2.resources && !state.draft.resources && ctx.project?.config.resources) next2.resources = { ...ctx.project.config.resources, ...next2.resources };
      return replace(next2, { presetAt: at, message: `preset ${names[at]}: ${PRESETS[names[at]]}` });
    }
  }
  if (state.tab === 1 || (state.tab === 2 && row === "perfLoadMax")) {
    const by = { loadMax: 1, pollSeconds: 5, heartbeatSeconds: 5, perfLoadMax: 0.1 }[row];
    const top = { loadMax: 1024, pollSeconds: MAX_POLL_SECONDS, heartbeatSeconds: MAX_HEARTBEAT_SECONDS, perfLoadMax: 1024 }[row];
    if (step) return draft({ [row]: clamp(tidy(eff[row] + step * by), by, top) });
  }
  if (key === "x" && state.tab === 4 && unknownKeys(state.draft).includes(row)) return draft({ [row]: undefined }, { message: `${row} removed`, sel: Math.max(0, state.sel - 1) });
  if (key === "x" && state.tab !== 0 && row !== "try") return draft({ [row]: undefined }, { message: `${row} back to its default` });
  if (key === "return" && state.tab === 4 && row !== "lockDir") return set({ message: `${row} is not a key this version knows; x removes it` });
  if (key === "return" && state.tab !== 0) {
    if (row === "try") return set({ input: { target: "try", label: "command to try", text: state.command } });
    return set({ input: { target: row, label: row, text: String(merged(state, ctx)[row] ?? "") } });
  }
  if (key === "/" && state.tab === 3) return set({ input: { target: "try", label: "command to try", text: state.command } });
  if (key === "p" && state.tab === 2) return { state: next, effect: "probe" };
  if (key === "m" && state.tab === 4) return { state: next, effect: "import" };
  return set({});
};

// The project file's machine keys (and judge) the draft does not set yet, ready to lay into it.
export const importable = (state, ctx) => {
  const out = {};
  if (!ctx.project) return out;
  for (const key of [...MACHINE_KEYS, "judge"]) {
    if (!Object.hasOwn(ctx.project.config, key) || Object.hasOwn(state.draft, key)) continue;
    const value = ctx.project.config[key];
    // A project's judge is a path inside the project; the machine file names it by its full path.
    const local = key === "judge" ? resolve(dirname(ctx.project.path), value) : "";
    out[key] = key === "judge" && existsSync(local) ? local : value;
  }
  return out;
};

const age = (at, now) => {
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  return seconds < 90 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
};
const pad = (text, width) => text + " ".repeat(Math.max(0, width - text.length));
const short = (text, width) => {
  const whole = String(text);
  return whole.length > width ? `${whole.slice(0, width - 1)}…` : whole;
};
const BARS = "▁▂▃▄▅▆▇█";
const bar = (share) => BARS[clamp(Math.round(share * 7), 0, 7)];
const percent = (share) => `${Math.round(share * 100)}%`;
// A held slot breathes, a running job spins, a waiter shifts its weight: all from ctx.tick, about nine a second.
const PULSE = ["██", "██", "▓█", "▒▓", "▓▒", "█▓"];
const PRESSURE = { normal: "ok", warn: "warn", critical: "err" };

// How many slots are held right now, over every resource.
export const jobsOf = (ctx) => ctx.snap.resources.reduce((sum, entry) => sum + entry.holders.length, 0);

// The screen as lines of [style, text] segments. Styles: "", dim, beef, ok, warn, err, bold, on.
export const view = (state, ctx, { width = 80, rows: height = Infinity } = {}) => {
  const lines = [];
  // A segment may carry a third item, and a line an `action`: what a click there does ({ tab }, { sel }, { keys }).
  const line = (...segments) => {
    lines.push(segments);
    return segments;
  };
  const pick = (index, ...segments) => {
    line(mark(index), ...segments).action = { sel: index };
  };
  const hint = (...items) => line(["", "   "], ...items.flatMap(([label, key, gap = 3]) => [["dim", label, { keys: [key] }], ["", " ".repeat(gap)]]));
  const eff = effective(state, ctx);
  const changes = diff(state.saved, state.draft);
  const rows = rowsOf(state, ctx);
  const sel = clamp(state.sel, 0, rows.length - 1);
  const mark = (index) => (index === sel ? ["beef", " ▸ "] : ["", "   "]);
  const source = (key) => {
    const row = ctx.rows?.find((candidate) => candidate.key === key);
    if (row?.source.startsWith("env ")) return ["warn", `${row.source} wins`];
    if (Object.hasOwn(state.draft, key)) return ["dim", "machine file"];
    return ["dim", ctx.project && Object.hasOwn(ctx.project.config, key) ? "project file" : "default"];
  };
  const entryOf = (name) => ctx.snap.resources.find((entry) => entry.name === name) ?? { name, slots: 1, loadMax: eff.loadMax, holders: [], waiting: [], waivers: [] };
  const tick = ctx.tick ?? 0;
  const pulse = PULSE[Math.floor(tick / 2) % PULSE.length];
  const vitals = ctx.vitals ?? { cores: [], cpu: [], mem: null, memory: [] };
  const where = short(ctx.machinePath.replace(ctx.home, "~"), 40);
  const onQueue = state.screen !== "settings";
  const status = onQueue ? queueStatus(state, ctx, width) : [["dim", `${where}  `], changes.length ? ["warn", `● ${changes.length} unsaved`] : ["ok", "● saved"]];
  const title = state.screen === "log" ? " queue › log" : onQueue ? " queue" : " settings";
  const gap = Math.max(2, width - 16 - title.length - status.reduce((sum, [, text]) => sum + cols(text), 0) - 1);
  line(["beef", " ▟██▙ beefy-slot"], ["dim", title], ["", " ".repeat(gap)], ...status, ["", " "]);
  // The vitals strip: a bar per core (cores share a bar when there are more than fit), memory, and the load against its limit.
  const group = Math.max(1, Math.ceil(vitals.cores.length / Math.max(2, width - 55)));
  const bars = [];
  for (let i = 0; i < vitals.cores.length; i += group) {
    const part = vitals.cores.slice(i, i + group);
    const busy = part.reduce((sum, share) => sum + share, 0) / part.length;
    bars.push([busy > 0.9 ? "err" : "beef", bar(busy)]);
  }
  const mem = vitals.mem;
  const full = mem ? clamp(Math.round(mem.used * 8), 0, 8) : 0;
  const over = ctx.snap.load > eff.loadMax;
  line(["dim", " cores "], ...bars, ["dim", vitals.cpu.length ? `  ${percent(vitals.cpu.at(-1))}` : "…"], ["dim", "   mem "], ...(mem ? [[PRESSURE[mem.pressure], "▰".repeat(full)], ["dim", "▱".repeat(8 - full)], ["dim", ` ${percent(mem.used)} `], [PRESSURE[mem.pressure], mem.pressure]] : [["dim", "…"]]), ["", "   "], ...(!onQueue || showsLoad(state, ctx) ? [["dim", "load "], [over ? "err" : "", `${ctx.snap.load.toFixed(1)} of ${eff.loadMax.toFixed(1)}`]] : []));
  line(["", " "], [onQueue ? "on" : "dim", " queue ", { screen: "queue" }], ["", "  "], [onQueue ? "dim" : "on", " settings ", { screen: "settings" }], ["dim", "      tab switches"]);
  if (!onQueue) line(["", "  "], ...TABS.flatMap((name, index) => [[index === state.tab ? "on" : "dim", ` ${index + 1} ${name} `, { tab: index }], ["", "  "]]));
  line(["dim", ` ${"─".repeat(width - 2)}`]);
  if (state.fault && !onQueue) line(["warn", ` ⚠ ${short(state.fault, width - 6)}`]);
  else if (state.screen !== "log") line();

  if (onQueue) {
    // The body gets what the box leaves: the rows, less the box and the room above it (3), the header so far, and the foot (3).
    const fit = Number.isFinite(height) ? Math.max(1, height - 3 - lines.length - 3) : Infinity;
    for (const queued of queueBody(state, ctx, { width, fit })) lines.push(queued);
  } else if (state.help) {
    for (const text of ["1-5  [ ]  section    pick a section          tab  back to the queue", "w s  k j  ↑ ↓     move", "a d  h l  ← →     change the number on this row    - + too", "space             turn a resource's load limit on or off", "enter             type a value          x  back to the default", "n  x  p           Slots: new resource, remove, next preset", "p                 Perf host: probe the perf host", "/                 Command rules: try a command against the judge", "m                 Sources: copy the project file's settings in", "S  u  q           save, undo all, quit", "click             a section, a row, a preset, or any key named on screen", "c                 call the cow", "", "Nothing is written until you save. The file is ~/.beefy-slot/config.json."]) line(["", `   ${text}`]);
  } else if (state.tab === 0) {
    line(["bold", `  ${TABS[0]}`], ["dim", `   ${ABOUT[0]}`]);
    line();
    const at = state.presetAt;
    line(["dim", "   presets   "], ...Object.keys(PRESETS).flatMap((name, index) => [[index === at ? "on" : "", ` ${name} `, { presetAt: index - 1, keys: ["p"] }], ["", "  "]]), ["dim", `p next · sized for ${ctx.cores} cores`]);
    line();
    rows.forEach((name, index) => {
      const entry = entryOf(name);
      const own = merged(state, ctx).resources?.[name] ?? {};
      const slots = name === HEAVY ? eff.heavySlots : own.slots ?? 1;
      const gated = name === HEAVY || own.loadGate !== false;
      pick(index, ["bold", pad(short(name, 12), 13)], ["dim", pad(`${slots} slot${slots === 1 ? "" : "s"}`, 10)], ["dim", "load limit "], gated ? ["dim", "on"] : ["warn", "off"]);
      const blocks = [];
      const queued = ctx.queue?.items ?? [];
      const named = (held) => queued.find((item) => item.slot !== undefined && item.slot === held.slot)?.command ?? held.as;
      for (let slot = 0; slot < Math.max(slots, entry.holders.length); slot++) blocks.push(entry.holders[slot] ? [["beef", `${pulse} `], [slot < slots ? "" : "warn", `${short(named(entry.holders[slot]), 14)}  `]] : [["dim", "░░  "]]);
      let rowOf = [["", " ".repeat(16)]];
      let used = 16;
      for (const block of blocks) {
        const size = block.reduce((sum, [, text]) => sum + text.length, 0);
        if (used + size > width - 1) {
          line(...rowOf);
          rowOf = [["", " ".repeat(16)]];
          used = 16;
        }
        rowOf.push(...block);
        used += size;
      }
      line(...rowOf);
      if (entry.waiting.length) line(["", " ".repeat(16)], ["dim", "waiting  "], ...entry.waiting.slice(0, 4).flatMap((ticket, place) => [["warn", `${(tick % 10 < 5) === (place % 2 === 0) ? "▚" : "▞"}${place + 1} `], ["", `${short(queued.find((item) => item.resource === name && item.section === "waiting" && item.place === place + 1)?.command ?? ticket.as, 14)} `], ["dim", `${age(ticket.at, ctx.now)}   `]]), ["dim", entry.waiting.length > 4 ? `+${entry.waiting.length - 4} more` : ""]);
      if (index === sel) {
        if (entry.holders.length > slots) line(["", " ".repeat(16)], ["warn", `${entry.holders.length - slots} over the new count keep${entry.holders.length - slots === 1 ? "s its" : " their"} slot until freed`]);
        if (!gated) line(["", " ".repeat(16)], ["dim", "admits at any load · meant for CI pools"]);
      }
      line();
    });
    const perf = entryOf(PERF);
    line(["", "   "], ["bold", pad(PERF, 13)], ["dim", `1 slot    reserved · set up under ${TABS[2]}`]);
    if (perf.holders[0]) line(["", " ".repeat(16)], ["beef", `${pulse} `], ["", short(perf.holders[0].as, 20)]);
    line();
    hint(["←", "left", 2], ["→ slots", "right"], ["space load limit", "space"], ["n new", "n"], ["x remove", "x"], ["p preset", "p"]);
  } else if (state.tab === 1) {
    line(["bold", `  ${TABS[1]}`], ["dim", `   ${ABOUT[1]}`]);
    line();
    const load = ctx.snap.load;
    const limit = eff.loadMax;
    const top = Math.max(limit, load, ...ctx.history);
    line(["bold", "   load, 1 minute   "], ["beef", ctx.history.map((sample) => BARS[clamp(Math.round((sample / top) * 7), 0, 7)]).join("")], ["", `  ${load.toFixed(1)}`]);
    const size = Math.min(40, width - 16);
    const filled = clamp(Math.round((load / limit) * size), 0, size);
    const perfAt = clamp(Math.round((eff.perfLoadMax / limit) * size), 0, size - 1);
    const gauge = [];
    for (let i = 0; i < size; i++) gauge.push(i === perfAt ? ["err", "┃"] : i < filled ? [load > limit ? "err" : "beef", "█"] : ["dim", "░"]);
    line(["", "   0 "], ...gauge, ["", ` ${limit.toFixed(1)}`]);
    line(["", " ".repeat(5 + perfAt)], ["err", `┃ perf ${eff.perfLoadMax.toFixed(1)}`]);
    line();
    line(["", "   busiest          "], ["dim", ctx.busiest ? `${ctx.busiest.name} (pid ${ctx.busiest.pid}) ${ctx.busiest.cores.toFixed(1)} of ${ctx.cores} cores` : "…"]);
    line();
    line(["bold", "   would a new job start right now"]);
    for (const entry of ctx.snap.resources.filter((candidate) => candidate.name === HEAVY || candidate.name === PERF)) {
      const verdict = admission(entry, load);
      line(["", `   ${pad(short(entry.name, 12), 13)}`], verdict.ok ? ["ok", "yes   "] : ["err", "no    "], ["dim", verdict.why + (entry.name === PERF && eff.perfHost ? ` · runs on ${eff.perfHost}` : "")]);
    }
    line();
    line(["bold", "   knobs"]);
    rows.forEach((key, index) => {
      const [style, from] = source(key);
      pick(index, ["", pad(key, 18)], ["", pad(key === "loadMax" ? eff[key].toFixed(1) : `${eff[key]} s`, 9)], [style, short(key === "pollSeconds" && from === "default" ? "default · only a backup now; jobs start the moment a slot frees" : from, Math.max(10, width - 31))]);
    });
    line();
  } else if (state.tab === 2) {
    line(["bold", `  ${TABS[2]}`], ["dim", `   ${ABOUT[2]}`]);
    line();
    line(["bold", "   perf"], ["dim", "  one holder · its own, lower load limit · for timing runs"]);
    line();
    pick(0, ["", pad("perfHost", 18)], ["", pad(eff.perfHost || "(this machine)", 26)], source("perfHost"));
    pick(1, ["", pad("perfLoadMax", 18)], ["", pad(String(eff.perfLoadMax), 26)], source("perfLoadMax"));
    line();
    line(["bold", "   probe"], ["dim", "   p  run it"]);
    if (!ctx.probe) line(["dim", eff.perfHost ? "   not run yet" : "   no perfHost: perf runs on this machine"]);
    else for (const step of ctx.probe) line(["", "   "], step.ok === null ? ["dim", "… "] : step.ok ? ["ok", "✓ "] : ["err", "✗ "], ["", pad(step.label, 24)], ["dim", step.detail]);
    line();
    const perf = entryOf(PERF);
    line(["bold", "   the room"], ["dim", eff.perfHost ? "  (as this machine sees it)" : ""]);
    line(["", " ".repeat(12)], ...(perf.holders[0] ? [["beef", `${pulse} `], ["", short(perf.holders[0].as, 20)]] : [["dim", "░░  open"]]));
    line();
    hint(["←", "left"], ["→ change the limit", "right"], ["enter type a host", "return"], ["x default", "x"], ["p probe", "p"]);
  } else if (state.tab === 3) {
    line(["bold", `  ${TABS[3]}`], ["dim", `   ${ABOUT[3]}`]);
    line();
    const spec = merged(state, ctx).judge;
    line(["bold", "   judge"], ["dim", "  asked about a command before `run` takes a slot"]);
    line();
    pick(0, ["", pad("judge", 10)], ["", pad(short(spec ?? "none · every run is allowed", width - 30), width - 30)], spec ? source("judge") : ["", ""]);
    pick(1, ["", pad("try", 10)], ["dim", state.command ? `beefy-slot run heavy -- ${short(state.command, width - 42)}` : "enter or / to type a command · only a saved machine-file judge runs"]);
    line();
    if (state.verdict) {
      const style = { allow: "ok", deny: "err", ask: "warn", failed: "err", skipped: "dim" }[state.verdict.decision];
      line(["dim", `   ┌${"─".repeat(width - 8)}┐`]);
      line(["dim", "   │ "], [style, pad(state.verdict.decision.toUpperCase(), 8)], ["", pad(short(state.verdict.reason ?? "", width - 18), width - 17)], ["dim", "│"]);
      line(["dim", "   │ "], ["dim", pad(state.verdict.decision === "allow" ? "run would take a slot and start" : state.verdict.decision === "skipped" ? "only a judge saved in the machine file runs here; `run` loads a project's" : "run would exit 1 before taking a slot", width - 9)], ["dim", "│"]);
      line(["dim", `   └${"─".repeat(width - 8)}┘`]);
    }
    line();
    hint(["enter type a path, or a command to try", "return"], ["x no judge", "x"]);
  } else {
    line(["bold", `  ${TABS[4]}`], ["dim", `   ${ABOUT[4]}`]);
    line();
    pick(0, ["", pad("lockDir", 18)], ["", pad(short(eff.lockDir.replace(ctx.home, "~"), 34), 35)], source("lockDir"));
    rows.slice(1).forEach((key, index) => pick(index + 1, ["", pad(short(key, 17), 18)], ["", pad(short(JSON.stringify(state.draft[key]) ?? "", 22), 23)], ["warn", "unknown key · x removes it"]));
    line();
    line(["bold", "   where each value comes from"], ["dim", "   env, then machine file, then project file"]);
    for (const key of ["heavySlots", "loadMax", "perfHost", "perfLoadMax", "pollSeconds", "heartbeatSeconds", "judge"]) line(["", `   ${pad(key, 18)}`], ["", pad(short(String(key === "judge" ? merged(state, ctx).judge ?? "none" : eff[key] === "" ? "(this machine)" : eff[key]), 34), 35)], source(key));
    line();
    line(["bold", "   config check"], ["dim", changes.length ? "   of the saved file · save to check the changes" : ""]);
    for (const finding of ctx.findings ?? []) line(["", "   "], [finding.level === "ok" ? "ok" : finding.level === "warn" ? "warn" : "err", pad(finding.level, 6)], ["", short(finding.text.replaceAll(ctx.home, "~"), width - 11)]);
    const more = Object.keys(importable(state, ctx));
    if (more.length) line(["", "   "], ["warn", "m     "], ["", `copy ${more.join(", ")} in from the project file`]).action = { keys: ["m"] };
    line();
    line(["bold", `   changes to ${ctx.machinePath.replace(ctx.home, "~")}`]);
    if (!changes.length) line(["dim", "   none"]);
    for (const change of changes) {
      if (change.was !== undefined) line(["err", `   - ${change.key}: ${short(change.was, width - 12)}`]);
      if (change.now !== undefined) line(["ok", `   + ${change.key}: ${short(change.now, width - 12)}`]);
    }
    line();
    hint(["enter type a folder", "return"], ["x default", "x"], ["S save", "S"], ["u undo all", "u"]);
  }
  line();
  line(["dim", ` ${"─".repeat(width - 2)}`]);
  if (state.input) line(["beef", ` ${state.input.label} › `], ["", state.input.text], ["on", " "], ["dim", "   enter keeps it · esc cancels"]);
  else if (state.message) line(["warn", ` ${short(state.message, width - 2)}`]);
  else if (onQueue) line(...queueHint(state, ctx));
  else line(["", "  "], ["dim", "[", { keys: ["["] }], ["dim", " "], ["dim", "] section", { keys: ["]"] }], ["dim", "   hjkl · click   "], ["dim", "S save", { keys: ["S"] }], ["", "   "], ["dim", "u undo", { keys: ["u"] }], ["", "   "], ["dim", "tab queue", { keys: ["tab"] }], ["", "   "], ...(state.tab === 1 ? [] : [["dim", "? help", { keys: ["?"] }], ["", "   "]]), ["dim", "q quit", { keys: ["q"] }], ["", "   "]);
  return lines;
};

// The screen always has a white ground: dark text, and colours picked to read on white.
const BASE = "\x1b[0;48;5;231;38;5;235m";
const CODES = { faint: "38;5;250", hot: "38;5;166", warm: "38;5;215", cool: "38;5;223", dim: "38;5;245", beef: "38;5;166", ok: "38;5;28", warn: "38;5;130", err: "38;5;160", bold: "1", on: "48;5;235;38;5;231" };

// The box round the screen, and the room above it. While slots are held a comet per job (four at most) runs
// round the box clockwise: heavy line for the head, a tail that fades into the ground. `room` leaves a blank row on top.
const TAIL = ["hot", "hot", "hot", "hot", "warm", "warm", "warm", "warm", "cool", "cool", "cool", "cool"];
export const frame = (lines, { width = 80, jobs = 0, tick = 0, room = true } = {}) => {
  const height = lines.length + 2;
  const right = width - 1;
  // The way round, from the top left. A cell is twice as tall as it is wide, so the sides take two steps a cell.
  const path = [];
  for (let x = 0; x <= right; x++) path.push(`${x},0`);
  for (let y = 1; y < height - 1; y++) path.push(`${right},${y}`, `${right},${y}`);
  for (let x = right; x >= 0; x--) path.push(`${x},${height - 1}`);
  for (let y = height - 2; y >= 1; y--) path.push(`0,${y}`, `0,${y}`);
  const lit = new Map();
  const comets = Math.min(jobs, 4);
  for (let comet = 0; comet < comets; comet++) {
    const head = tick * 2 + Math.floor((comet * path.length) / comets);
    for (let back = TAIL.length - 1; back >= 0; back--) lit.set(path[(((head - back) % path.length) + path.length) % path.length], TAIL[back]);
  }
  const cell = (x, y) => {
    const style = lit.get(`${x},${y}`);
    const glyphs = y === 0 ? (x === 0 ? "╭┏" : x === right ? "╮┓" : "─━") : y === height - 1 ? (x === 0 ? "╰┗" : x === right ? "╯┛" : "─━") : "│┃";
    return [style ?? "faint", glyphs[style ? 1 : 0]];
  };
  const edge = (y) => {
    const out = [];
    for (let x = 0; x <= right; x++) {
      const [style, glyph] = cell(x, y);
      if (out.at(-1)?.[0] === style) out.at(-1)[1] += glyph;
      else out.push([style, glyph]);
    }
    return out;
  };
  const boxed = lines.map((segments, index) => {
    let left = width - 2;
    const inside = [];
    for (const [style, text, action] of segments) {
      const part = clip(clean(text), left);
      left -= cols(part);
      if (part) inside.push(action ? [style, part, action] : [style, part]);
    }
    const row = [cell(0, index + 1), ...inside, ["", " ".repeat(left)], cell(right, index + 1)];
    if (segments.action) row.action = segments.action;
    return row;
  });
  return [...(room ? [[]] : []), edge(0), ...boxed, edge(height - 1)];
};

// The view in its box, cut to the rows there are: the body gives way, the last three lines (rule, status, keys) stay,
// and when rows are short the room above the box goes first.
export const screen = (state, ctx, { width = 80, rows = Infinity } = {}) => {
  const lines = view(state, ctx, { width: width - 2, rows });
  const room = lines.length + 3 <= rows;
  const most = Math.max(3, rows - (room ? 3 : 2));
  const body = lines.length > most ? [...lines.slice(0, most - 3), ...lines.slice(-3)] : lines;
  return frame(body, { width, jobs: ctx.still ? 0 : jobsOf(ctx), tick: ctx.tick ?? 0, room });
};

// The screen as text, one string per line, cut to the width. Without `color`, plain text.
export const render = (state, ctx, { width = 80, rows = Infinity, color = false } = {}) => screen(state, ctx, { width, rows }).map((segments) => {
  let room = width;
  let out = "";
  for (const [style, text] of segments) {
    const part = clip(clean(text), room);
    room -= cols(part);
    out += color && style && part ? `\x1b[${CODES[style]}m${part}${BASE}` : part;
  }
  return out;
});

// What a click at column x, line y does: the action of the segment there, else of its line, else null.
export const hitAt = (state, ctx, { x, y, width = 80, rows = Infinity }) => {
  const segments = screen(state, ctx, { width, rows })[y];
  if (!segments) return null;
  let at = 0;
  for (const [, text, action] of segments) {
    const size = cols(text);
    if (action && x >= at && x < at + size) return action;
    at += size;
  }
  return segments.action ?? null;
};

// The cow: now and then she walks in along the empty rows at the bottom, stops, looks at you, and walks on.
const COW_WALK = [String.raw`  ^__^  _____________`, String.raw`  (oo)\/             \ `, String.raw`  (__)\               )\ `, String.raw`       \_____________/  *`];
const COW_LEGS = [String.raw`        ||  \\   ||  \\ `, String.raw`        \\  ||   \\  ||`];
const COW_LOOK = [String.raw`  ^__^  _____________`, String.raw` (^‿^)\/             \    moo ♥`, String.raw`  (__)\               )\ `, String.raw`       \_____________/  *`, String.raw`        ||  ||   ||  ||`];
export const COW_HEIGHT = 5;
export const cowLines = (cow) => (cow.phase === "look" ? COW_LOOK : [...COW_WALK, COW_LEGS[cow.frame % 2]]);

// The lines with the cow drawn on the last rows, when there are blank rows enough below the screen; else as they were.
export const withCow = (lines, cow, width, rows) => {
  if (!cow || !Number.isFinite(rows) || rows - lines.length < COW_HEIGHT) return lines;
  const out = [...lines];
  while (out.length < rows - COW_HEIGHT) out.push("");
  for (const art of cowLines(cow)) out.push([...(cow.x < 0 ? [...art].slice(-cow.x).join("") : " ".repeat(cow.x) + art)].slice(0, width).join(""));
  return out;
};

// One step of her walk: in from the right two columns at a time, a look of `left` steps, then out to the left. Null when she is gone.
export const cowStep = (cow) => {
  if (cow.phase === "look") return cow.left > 1 ? { ...cow, left: cow.left - 1 } : { ...cow, phase: "out" };
  const x = cow.x - 2;
  if (cow.phase === "in" && x <= cow.stop) return { ...cow, x, phase: "look", left: 28 };
  return cow.phase === "out" && x < -30 ? null : { ...cow, x, frame: cow.frame + 1 };
};

// What came from the terminal, as key names and clicks ({ x, y }, from 0). The wheel is up and down.
export const parseInput = (data) => {
  const events = [];
  for (const match of data.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b(?:\[|O)([ABCD])|\x1b\[Z|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1bO.|[\s\S]/gu)) {
    const [all, button, column, row, press, arrow] = match;
    if (button !== undefined) {
      if (button === "64") events.push("up");
      else if (button === "65") events.push("down");
      else if (button === "0" && press === "M") events.push({ x: Number(column) - 1, y: Number(row) - 1 });
    } else if (arrow) events.push({ A: "up", B: "down", C: "right", D: "left" }[arrow]);
    else if (all === "\x1b[Z") events.push("[");
    else if (all === "\x1b[5~" || all === "\x1b[6~") events.push(all === "\x1b[5~" ? "pgup" : "pgdn");
    else if (all.length > 1 && all !== "\x1b") continue;
    else {
      const named = { "\r": "return", "\n": "return", "\t": "tab", "\x7f": "backspace", "\b": "backspace", "\x1b": "escape", " ": "space", "\x03": "ctrl-c", "\x13": "ctrl-s" }[all];
      if (named) events.push(named);
      else if (all >= " ") events.push(all);
    }
  }
  return events;
};

// A command line as words: spaces split, single and double quotes group.
export const words = (text) => [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);

// The judge's answer for one command, as { decision: "allow" | "deny" | "ask" | "failed", reason }.
export const tryJudge = async (judge, command, cwd, load = loadJudge) => {
  const argv = words(command);
  if (!judge) return { decision: "allow", reason: "no judge is set" };
  if (judge.skip) return { decision: "skipped", reason: judge.skip };
  try {
    const verdict = (await load(judge.spec, judge.baseDir))(quoteCommand(argv), { argv, cwd });
    if (verdict === null) return { decision: "allow", reason: "" };
    if (verdict?.decision === "deny" || verdict?.decision === "ask") return { decision: verdict.decision, reason: String(verdict.reason ?? "") };
    return { decision: "failed", reason: "the judge returned an answer beefy-slot cannot read" };
  } catch (error) {
    return { decision: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
};

// Looks at the perf host over ssh: is it reachable, is node there, what is its load. Calls `onStep` as each answer comes.
const probeHost = (host, limit, onStep) => {
  const steps = [{ label: `ssh ${host}`, ok: null, detail: "" }, { label: "node there", ok: null, detail: "" }, { label: "load there", ok: null, detail: "" }];
  onStep(steps);
  if (!HOST.test(host)) {
    steps[0] = { ...steps[0], ok: false, detail: "not a host name ssh would take" };
    onStep(steps);
    return undefined;
  }
  const started = Date.now();
  const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, "node --version; uptime"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let errors = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (errors += chunk));
  child.on("error", (error) => onStep([{ ...steps[0], ok: false, detail: error.message }, steps[1], steps[2]]));
  child.on("close", (code) => {
    const node = /^v\d+\.\d+\.\d+/m.exec(out)?.[0];
    const load = /load averages?:\s*([\d.]+)/.exec(out)?.[1];
    const reached = code !== 255 && (out !== "" || code === 0);
    onStep([
      { ...steps[0], ok: reached, detail: reached ? `${((Date.now() - started) / 1000).toFixed(1)} s` : errors.trim().split("\n").pop() ?? `exit ${code}` },
      { ...steps[1], ok: reached ? Boolean(node) : null, detail: node ? `${node}${Number(node.slice(1).split(".")[0]) >= 22 ? "" : " · needs 22 or newer"}` : reached ? "not on its PATH" : "" },
      { ...steps[2], ok: load === undefined ? null : Number(load) <= limit, detail: load === undefined ? "" : `${Number(load).toFixed(1)} ${Number(load) <= limit ? "under" : "over"} ${limit}` },
    ]);
  });
  return child;
};

// The terminal loop. Resolves with the exit code when the person quits.
export const runTui = ({ stdin = process.stdin, stdout = process.stdout, env = process.env, home = homedir(), cwd = process.cwd(), cores = availableParallelism(), screen: first = "settings", proc = process, stderr = process.stderr, cancel = cancelJob } = {}) => new Promise((done) => {
  const loaded = loadConfig({ cwd, home });
  // The screen starts from the machine file as it reads it, never from a file it could not read: that one is left alone.
  const file = inspectMachineFile(home);
  let expect = file.hash;
  const tilde = (text) => String(text).replaceAll(home, "~");
  const reason = file.error?.replace(`${file.path}: `, "");
  const fault = file.state === "bad" ? `save is off · config.json: ${reason}` : file.state === "unknown" ? `${reason} (kept as it is; the ledger's x removes a key)` : "";
  let state = createState(file.config ?? {}, { screen: first, blocked: file.state === "bad" ? `not saved: the screen does not write over a file it cannot read (config.json: ${reason}); fix or move it by hand` : "", fault });
  // A project file that is not valid is reported (the ledger, the status line), never drawn from.
  const ctx = { queue: { items: [] }, busiest: null, tail: null, logView: null, logRows: 14, env, home, cwd, cores, project: loaded.projectError ? null : loaded.project, machinePath: machineConfigPath(home), snap: { load: 0, resources: [] }, history: [], findings: [], rows: [], probe: null, now: Date.now(), cow: null, tick: 0, still: Boolean(env.BEEFY_SLOT_STILL), vitals: { cores: [], cpu: [], mem: null, memory: [] } };
  if (loaded.projectError) state.message = tilde(loaded.projectError);
  const color = !env.NO_COLOR;
  const size = () => ({ width: clamp(stdout.columns ?? 80, 60, 120), rows: stdout.rows ?? 24 });
  // Once the terminal is handed back nothing may draw on it: a late message from a cancel, a probe or the cow would land on the shell.
  let closed = false;
  const probes = new Set();
  const paint = () => {
    if (closed) return;
    const { width, rows } = size();
    ctx.logRows = Math.max(3, rows - 11);
    const lines = withCow(render(state, ctx, { width, rows, color }), ctx.cow, width, rows);
    while (lines.length < rows) lines.push("");
    // Every line is padded with spaces to the terminal's full width: not every terminal paints the
    // ground colour when a line is cleared to its end, and a patchy white is worse than none.
    const columns = stdout.columns ?? width;
    const visible = (text) => cols(text.replace(/\x1b\[[0-9;]*m/g, ""));
    stdout.write(`\x1b[H${lines.slice(0, rows).map((text) => (color ? `${BASE}${text}${" ".repeat(Math.max(0, columns - visible(text)))}` : `${text}\x1b[K`)).join(color ? "\r\n" : "\n")}`);
  };
  const check = async () => {
    try {
      const result = await checkConfig({ cwd, home, env, cores });
      if (closed) return;
      ctx.findings = result.findings;
      ctx.rows = result.rows;
    } catch (error) {
      state = { ...state, message: clean(`config check failed: ${error.message}`) };
    }
    paint();
  };
  let ticks = 0;
  const refresh = () => {
    const settings = effective(state, ctx);
    ctx.now = Date.now();
    try {
      ctx.snap = snapshot({ dir: settings.lockDir, settings, load: loadavg()[0] });
    } catch {}
    try {
      ctx.queue = collectQueue({ dir: settings.lockDir, snap: ctx.snap, now: ctx.now });
    } catch {}
    const here = selected(state, ctx);
    ctx.tail = here?.section === "recent" && here.log && (here.state === "failed" || here.state === "lost") ? { key: here.key, lines: (readLog(here.log) ?? "").split(/\r?\n/).filter((text) => text.trim() !== "").slice(-SHOWN) } : null;
    const watched = ctx.queue.items.find((item) => item.key === state.log?.key);
    ctx.logView = state.screen === "log" && watched ? { key: watched.key, lines: watched.log ? logLines(watched, readLog(watched.log)) : [] } : null;
    if (((state.screen === "settings" && state.tab === 1) || ctx.queue.items.some((item) => item.loadHold)) && ticks % 5 === 0) ctx.busiest = busiestDetail();
  };
  let times = coreTimes();
  const vitals = () => {
    const next = coreTimes();
    const cores = coreLoads(times, next);
    times = next;
    ctx.vitals = { ...ctx.vitals, cores, cpu: [...ctx.vitals.cpu, cores.reduce((sum, share) => sum + share, 0) / Math.max(1, cores.length)].slice(-16) };
    if (ticks % 2 === 0) readMemory().then((mem) => (ctx.vitals = { ...ctx.vitals, mem, memory: [...ctx.vitals.memory, mem.used].slice(-16) }));
  };
  const timer = setInterval(() => {
    refresh();
    vitals();
    ticks++;
    ctx.history = [...ctx.history, ctx.snap.load].slice(-16);
    paint();
  }, 1000);
  // The beat everything that moves keeps. It only redraws while a slot is held; an idle screen sits still.
  // BEEFY_SLOT_STILL=1 stops it.
  const beat = ctx.still ? undefined : setInterval(() => {
    ctx.tick++;
    if (!ctx.cow && jobsOf(ctx) > 0) paint();
  }, 110);
  // She comes by every half minute to minute and a half, and at once when called (c).
  let walking;
  let waiting;
  const stroll = () => {
    waiting = setTimeout(summon, (25 + Math.random() * 65) * 1000);
  };
  const summon = () => {
    if (ctx.cow) return;
    const { width } = size();
    ctx.cow = { x: width, stop: Math.max(2, Math.floor(width / 2 - 20 + Math.random() * 16)), phase: "in", frame: 0 };
    walking = setInterval(() => {
      ctx.cow = cowStep(ctx.cow);
      if (!ctx.cow) {
        clearInterval(walking);
        clearTimeout(waiting);
        if (!env.BEEFY_SLOT_NO_COW) stroll();
      }
      paint();
    }, 130);
  };
  if (!env.BEEFY_SLOT_NO_COW) stroll();
  // Everything the screen turned on goes off again, whatever ended it: a key, a signal, a crash. Nothing paints after.
  const leave = (code) => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearInterval(beat);
    clearInterval(walking);
    clearTimeout(waiting);
    for (const child of probes) child.kill();
    probes.clear();
    for (const [name, handler] of Object.entries(handlers)) proc.off(name, handler);
    stdin.off("data", onData);
    try {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdout.write("\x1b[?1006l\x1b[?1000l\x1b[0m\x1b[?25h\x1b[?1049l");
    } catch {}
    done(code);
  };
  // A signal or an error nobody caught still hands the terminal back first (the alt screen, mouse reporting, the cursor), then ends with its own code:
  // 128 plus the signal's number, as a shell reports a process a signal ended.
  const handlers = {};
  for (const name of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"]) handlers[name] = () => leave(128 + constants.signals[name]);
  const crash = (error) => {
    leave(1);
    for (const text of String(error?.stack ?? error).split("\n")) stderr.write(`beefy: ${clean(text)}\n`);
  };
  handlers.uncaughtException = crash;
  handlers.unhandledRejection = crash;
  for (const [name, handler] of Object.entries(handlers)) proc.on(name, handler);
  // A terminal that went away makes writes fail; that is the end, not a second crash.
  stdout.on?.("error", () => {});
  // A cancel, from the queue: a detached job through `cancelJob`; a foreground run by its own SIGTERM (it stops its command and frees the slot,
  // when it gets to it), sent only to a pid that is above 1 and still has the command it was listed with: a stale record's pid may be anyone's now.
  const stop = async (item) => {
    const say = (message) => {
      state = { ...state, message: clean(message) };
      paint();
    };
    if (!item.job) {
      const now = isPid(item.pid) ? processFacts(item.pid, { fresh: true }) : { command: "" };
      if (now.command === "" || now.command !== item.command) return say(`${item.id} is not that run any more: nothing was signalled`);
      try {
        process.kill(item.pid, "SIGTERM");
        return say(`asked ${item.id} to stop (SIGTERM); it stays listed until it exits`);
      } catch (error) {
        return say(`could not signal ${item.id}: ${error.message}`);
      }
    }
    say(`cancelling ${item.id}…`);
    let failed = "";
    try {
      const code = await cancel({ id: item.id, dir: effective(state, ctx).lockDir, out: () => {}, err: (text) => (failed = text.replace(/^beefy-slot: /, "")) });
      say(code === 0 ? `cancelled ${item.id}` : failed || `could not cancel ${item.id}`);
    } catch (error) {
      say(`could not cancel ${item.id}: ${error.message}`);
    }
  };
  // One key: the next state, then whatever it asked of the outside. True when it was the key to leave.
  const press = (name) => {
    const result = update(state, name, ctx);
    state = result.state;
    if (result.effect === "quit") return true;
    if (result.effect === "cow") summon();
    if (result.effect === "cancel") stop(result.target);
    if (result.effect === "save") {
      try {
        writeMachineConfig(state.draft, home, { expect, keepUnknown: true });
        expect = hashOf(machineConfigText(state.draft));
        state = { ...state, saved: clone(state.draft), fault: unknownKeys(state.draft).length ? state.fault : "", message: `saved ${ctx.machinePath.replace(home, "~")}` };
        check();
      } catch (error) {
        state = { ...state, message: tilde(error.message) };
      }
    }
    if (result.effect === "import") {
      const more = importable(state, ctx);
      const config = { ...state.draft, ...more };
      const problem = validate(config, { machine: true, keepUnknown: true });
      state = { ...state, ...(problem ? {} : { draft: config }), message: problem ?? (Object.keys(more).length ? `copied ${Object.keys(more).join(", ")}; after saving, delete them from ${ctx.project.path}` : "the project file has nothing to copy") };
    }
    if (result.effect === "probe") {
      const settings = effective(state, ctx);
      if (settings.perfHost) {
        const child = probeHost(settings.perfHost, settings.perfLoadMax, (steps) => {
          ctx.probe = steps;
          paint();
        });
        if (child) {
          probes.add(child);
          child.on("close", () => probes.delete(child));
        }
      } else state = { ...state, message: "no perfHost: perf runs on this machine" };
    }
    if (result.effect === "judge") {
      const spec = state.draft.judge;
      // Only a judge saved in the machine file runs here. A draft one (typed, prefilled from the project, copied by `m`, preset) may be the repo's code, so it never loads.
      const judge = spec && spec === state.saved.judge ? { spec: spec.startsWith("~/") ? resolve(home, spec.slice(2)) : spec, baseDir: dirname(ctx.machinePath) } : spec ? { skip: "unsaved judge not run: save it to the machine file to try it" } : ctx.project?.config.judge ? { skip: "project judge not run: loading it runs that repo's code, so only `run` does" } : null;
      tryJudge(judge, state.command, cwd).then((verdict) => {
        state = { ...state, verdict };
        paint();
      });
    }
    return false;
  };
  const onData = (data) => {
    for (const event of parseInput(String(data))) {
      let keys = [event];
      if (typeof event !== "string") {
        // A click does what the thing under it says; while a value is being typed, clicks wait.
        const action = state.input || state.help ? null : hitAt(state, ctx, { ...event, ...size() });
        if (state.help) state = { ...state, help: false };
        if (action?.tab !== undefined) state = { ...state, tab: action.tab, sel: 0, message: "" };
        if (action?.screen !== undefined) state = { ...state, screen: action.screen, log: null, confirm: null, message: "" };
        if (action?.pick !== undefined && !state.confirm) state = { ...state, pick: action.pick, message: "" };
        if (action?.sel !== undefined) state = { ...state, sel: action.sel, message: "" };
        if (action?.presetAt !== undefined) state = { ...state, presetAt: action.presetAt };
        keys = action?.keys ?? [];
      }
      for (const key of keys) if (press(key)) return leave(0);
    }
    refresh();
    paint();
  };
  stdin.setEncoding("utf8");
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.on("data", onData);
  // The other screen, no cursor, and clicks reported with their column and row.
  stdout.write(`\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h${color ? BASE : ""}\x1b[2J`);
  refresh();
  readMemory().then((mem) => (ctx.vitals = { ...ctx.vitals, mem }));
  paint();
  check();
});
