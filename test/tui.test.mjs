// The queue and settings screens: keys and drawing without a terminal (update is a key → state, render is state → text), and the loop on fake streams.
import "./tmpdir.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { configMain } from "../src/config-cli.mjs";
import { COW_HEIGHT, TABS, admission, cowLines, cowStep, createState, diff, frame, hitAt, importable, parseInput, render, rowsOf, runTui, tryJudge, update, withCow, words } from "../src/tui.mjs";
import { collectQueue, commandOf, logLines, processFacts } from "../src/tui-queue.mjs";
import { clean, cols } from "../src/tui-text.mjs";
import { preset } from "../src/presets.mjs";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const context = (extra = {}) => ({
  env: {}, home: "/h/u", cwd: "/h/u/app", cores: 8, project: null, machinePath: "/h/u/.beefy-slot/config.json", history: [2, 5.2], busiest: { name: "xcodebuild", pid: 48113, cores: 3.1, started: 360 }, findings: [], rows: [], probe: null, now: NOW,
  snap: { load: 5.2, resources: [
    { name: "heavy", slots: 1, loadMax: 8, holders: [{ as: "pnpm-check" }], waiting: [{ as: "lint-all", at: new Date(NOW - 120_000).toISOString() }], waivers: [] },
    { name: "perf", slots: 1, loadMax: 1.5, holders: [], waiting: [], waivers: [] },
    { name: "ci", slots: 4, loadMax: null, holders: [{ as: "runner-1" }], waiting: [], waivers: [] },
  ] },
  ...extra,
});
const press = (state, ctx, ...keys) => keys.reduce((current, key) => update(current, key, ctx).state, state);
const text = (state, ctx, width = 80) => render(state, ctx, { width }).join("\n");
const start = () => createState({ heavySlots: 1, resources: { ci: { slots: 4, loadGate: false } } });

describe("config screen keys", () => {
  it("changes slots within 1 to 16 and toggles a resource's load limit", () => {
    const ctx = context();
    assert.equal(press(start(), ctx, "right", "right").draft.heavySlots, 3);
    assert.equal(press(start(), ctx, "left").draft.heavySlots, 1);
    assert.equal(press(start(), ctx, ...Array(20).fill("right")).draft.heavySlots, 16);
    assert.deepEqual(press(start(), ctx, "down", "left", "space").draft.resources.ci, { slots: 3, loadGate: true });
    assert.match(press(start(), ctx, "space").message, /heavy always has the load limit/);
  });

  it("adds a resource by typed name, refuses a bad one, and removes one", () => {
    const ctx = context();
    const typing = press(start(), ctx, "n", "g", "p", "u");
    assert.equal(typing.input.text, "gpu");
    assert.deepEqual(typing.draft, start().draft, "typing changes nothing until enter");
    const added = press(typing, ctx, "return");
    assert.deepEqual(added.draft.resources.gpu, { slots: 1 });
    assert.equal(rowsOf(added, ctx)[added.sel], "gpu");
    assert.match(press(start(), ctx, "n", "h", "e", "a", "v", "y", "return").message, /reserved/);
    assert.match(press(start(), ctx, "n", "c", "i", "return").message, /already there/);
    assert.equal(press(start(), ctx, "n", "x", "escape").input, null);
    assert.deepEqual(press(start(), ctx, "down", "x").draft.resources, {});
    assert.match(press(start(), ctx, "x").message, /cannot be removed/);
  });

  it("steps the knobs, types a value, and goes back to the default", () => {
    const ctx = context();
    assert.equal(press(start(), ctx, "2", "right").draft.loadMax, 9);
    assert.equal(press(start(), ctx, "2", "down", "left", "left", "left", "left").draft.pollSeconds, 5);
    assert.equal(press(start(), ctx, "2", "down", "down", ...Array(9).fill("right")).draft.heartbeatSeconds, 60);
    assert.equal(press(start(), ctx, "2", "return", "1", "2", "return").draft.loadMax, 12);
    assert.match(press(start(), ctx, "2", "return", "x", "return").message, /positive number/);
    assert.equal(Object.hasOwn(press(start(), ctx, "2", "right", "x").draft, "loadMax"), false);
    assert.equal(press(start(), ctx, "3", "down", "right").draft.perfLoadMax, 1.6);
    assert.equal(press(start(), ctx, "3", "return", "m", "i", "n", "i", "return").draft.perfHost, "mini");
    assert.equal(press(start(), ctx, "5", "return", "~", "/", "l", "return").draft.lockDir, "~/l");
  });

  it("refuses a change the file would not read back", () => {
    const state = press(start(), context(), "4", "return", "a", ":", "b", "return");
    assert.match(state.message, /judge: expected a path on this machine/);
    assert.equal(state.draft.judge, undefined);
  });

  it("cycles presets, undoes, and asks before quitting with changes", () => {
    const ctx = context();
    const laptop = press(start(), ctx, "p");
    assert.match(laptop.message, /preset laptop/);
    const box = press(laptop, ctx, "p");
    assert.deepEqual([box.draft.heavySlots, box.draft.resources.ci], [2, { slots: 4, loadGate: false }]);
    assert.deepEqual(press(box, ctx, "u").draft, start().draft);
    assert.equal(update(start(), "q", ctx).effect, "quit");
    const changed = press(start(), ctx, "right");
    const asked = update(changed, "q", ctx);
    assert.equal(asked.effect, undefined);
    assert.match(asked.state.message, /unsaved changes/);
    assert.equal(update(asked.state, "q", ctx).effect, "quit");
    assert.equal(update(press(changed, ctx, "n"), "ctrl-c", ctx).effect, "quit", "ctrl-c leaves even while typing");
  });

  it("makes p the same as `config preset <name>`: keys the preset drops are gone", () => {
    const ctx = context();
    const old = () => createState({ heavySlots: 3, loadMax: 9 });
    assert.deepEqual(press(old(), ctx, "p").draft, { heavySlots: 1 });
    assert.deepEqual(press(old(), ctx, "p").draft, preset("laptop", { heavySlots: 3, loadMax: 9 }, ctx.cores));
    assert.deepEqual(press(old(), ctx, "p", "p").draft, preset("ci-box", { heavySlots: 1 }, ctx.cores));
    assert.deepEqual(press(old(), ctx, "p", "p", "p").draft, preset("perf-rig", press(old(), ctx, "p", "p").draft, ctx.cores));
    assert.equal(Object.hasOwn(press(createState({ loadMax: 9 }), ctx, "p").draft, "resources"), false, "no empty resources added");
    const project = context({ project: { path: "/h/u/app/beefy-slot.json", config: { resources: { sim: { slots: 2 } } } } });
    assert.deepEqual(Object.keys(press(createState({}), project, "p", "p").draft.resources), ["sim", "ci"], "the project's resources stay in play");
  });

  it("refuses a save while the file could not be read, and edits past a key it does not know", () => {
    const ctx = context();
    const blocked = createState({}, { blocked: "not saved: the file is not JSON", fault: "save is off" });
    assert.equal(update(press(blocked, ctx, "right"), "S", ctx).effect, undefined);
    assert.equal(update(press(blocked, ctx, "right"), "S", ctx).state.message, "not saved: the file is not JSON");
    assert.equal(update(press(blocked, ctx, "right"), "ctrl-s", ctx).effect, undefined);
    const future = createState({ future: { a: 1 }, heavySlots: 2 });
    const edited = press(future, ctx, "right");
    assert.deepEqual(edited.draft, { future: { a: 1 }, heavySlots: 3 });
    assert.equal(update(edited, "S", ctx).effect, "save");
    const gone = press(future, ctx, "5", "down", "x");
    assert.deepEqual(gone.draft, { heavySlots: 2 });
    assert.match(gone.message, /future removed/);
    assert.match(press(future, ctx, "5", "down", "return").message, /not a key this version knows/);
    assert.match(text(press(future, ctx, "5"), ctx), /future\s+\{"a":1\}\s+unknown key · x removes it/);
  });

  it("asks the loop to save, probe, try the judge and import", () => {
    const ctx = context();
    assert.match(update(start(), "S", ctx).state.message, /nothing to save/);
    assert.equal(update(press(start(), ctx, "right"), "S", ctx).effect, "save");
    assert.equal(update(press(start(), ctx, "3"), "p", ctx).effect, "probe");
    assert.equal(update(press(start(), ctx, "5"), "m", ctx).effect, "import");
    const tried = update(press(start(), ctx, "4", "/", "n", "p", "m", "space", "t"), "return", ctx);
    assert.deepEqual([tried.effect, tried.state.command], ["judge", "npm t"]);
    assert.equal(press(start(), ctx, "]", "]").tab, 2);
    assert.equal(press(start(), ctx, "?").help, true);
  });
});

describe("config screen drawing", () => {
  it("draws every section inside the width", () => {
    const ctx = context({ findings: [{ level: "warn", text: `BEEFY_SLOT_HEAVY_SLOTS=0 is ignored: ${"x".repeat(200)}` }] });
    for (const width of [60, 80, 100, 120]) {
      for (let tab = 1; tab <= TABS.length; tab++) {
        const lines = render(press(start(), ctx, String(tab), "right"), ctx, { width });
        for (const line of lines) assert.ok([...line].length <= width, `tab ${tab} at ${width}: ${line}`);
      }
    }
  });

  it("shows holders, waiters, the pending count and the unsaved mark in the case", () => {
    const ctx = context();
    const screen = text(press(start(), ctx, "right"), ctx);
    assert.match(screen, /● 1 unsaved/);
    assert.match(screen, /▸ heavy\s+2 slots\s+load limit on/);
    assert.match(screen, /██ pnpm-check\s+░░/);
    assert.match(screen, /waiting\s+▚1 lint-all 2m/);
    assert.match(screen, /ci\s+4 slots\s+load limit off/);
    assert.match(text(start(), ctx), /● saved/);
  });

  it("marks a holder past a lowered count", () => {
    const ctx = context();
    assert.match(text(press(start(), ctx, "down", "left", "left", "left", "left"), { ...ctx, snap: { load: 1, resources: [{ name: "ci", slots: 4, loadMax: null, holders: [{ as: "r1" }, { as: "r2" }], waiting: [], waivers: [] }] } }), /1 over the new count keeps its slot until freed/);
  });

  it("answers whether a take would get in", () => {
    const [heavy, perf, ci] = context().snap.resources;
    assert.deepEqual(admission(heavy, 5.2), { ok: false, why: "pool full (1 of 1) · 1 waiting" });
    assert.deepEqual(admission(perf, 5.2), { ok: false, why: "load 5.2 over 1.5" });
    assert.deepEqual(admission(ci, 99), { ok: true, why: "1 of 4 slots used · no load limit" });
    assert.deepEqual(admission({ ...ci, holders: [], loadMax: 8 }, 3.1), { ok: true, why: "0 of 4 slots used · load 3.1 under 8.0" });
    assert.deepEqual(admission({ ...ci, waiting: [{ as: "a" }, { as: "b" }, { as: "c" }] }, 1), { ok: false, why: "3 waiting ahead" });
    const scale = text(press(start(), context(), "2"), context());
    assert.match(scale, /heavy\s+no\s+pool full/);
    assert.match(scale, /busiest\s+xcodebuild \(pid 48113\) 3\.1 of 8 cores/);
    assert.match(scale, /would a new job start right now/);
    assert.match(scale, /▸ loadMax\s+8\.0\s+default/);
    assert.doesNotMatch(scale, /\bci\s+(yes|no)/, "heavy and perf only, as drawn");
  });

  it("names an environment variable that wins, and lists the diff and the findings in the ledger", () => {
    const ctx = context({ env: { BEEFY_SLOT_PERF_HOST: "mini" }, rows: [{ key: "perfHost", source: "env BEEFY_SLOT_PERF_HOST", ignored: [] }], findings: [{ level: "warn", text: "/h/u/.chute-boss/locks holds 1 live record" }] });
    assert.match(text(press(start(), ctx, "3"), ctx), /perfHost\s+mini\s+env BEEFY_SLOT_PERF_HOST wins/);
    const ledger = text(press(start(), ctx, "right", "5"), ctx);
    assert.match(ledger, /warn\s+~\/\.chute-boss\/locks holds 1 live record/);
    assert.match(ledger, /- heavySlots: 1\s+[│┃]\n[│┃]\s+\+ heavySlots: 2/);
    assert.deepEqual(diff({ a: 1, resources: { x: { slots: 1 } } }, { a: 1, resources: { y: { slots: 2 } } }), [{ key: "resources.x", was: '{"slots":1}', now: undefined }, { key: "resources.y", was: undefined, now: '{"slots":2}' }]);
  });

  it("draws the judge's answer and the typing line", () => {
    const ctx = context();
    const state = { ...press(start(), ctx, "4"), command: "rm -rf x", verdict: { decision: "deny", reason: "deletes things" } };
    assert.match(text(state, ctx), /│ DENY\s+deletes things\s+│\s+[│┃]\n.*run would exit 1 before taking a slot/);
    assert.match(text(press(start(), ctx, "n", "a"), ctx), /new resource name › a/);
    assert.match(text(press(start(), ctx, "?"), ctx), /Nothing is written until you save/);
  });
});

describe("text from outside the screen", () => {
  it("never reaches the terminal as a control character", () => {
    const evil = "\u001b]0;pwned\u0007\u001b[2J\u001b[?1049l\r\u009b";
    const ctx = context({
      project: { path: "/h/u/app/beefy-slot.json", config: { perfHost: evil, judge: evil } },
      snap: { load: 1, resources: [
        { name: "heavy", slots: 1, loadMax: 8, holders: [{ as: evil }], waiting: [{ as: evil, at: new Date(NOW).toISOString() }], waivers: [] },
        { name: "perf", slots: 1, loadMax: 1.5, holders: [{ as: evil }], waiting: [], waivers: [] },
      ] },
      findings: [{ level: "error", text: `unknown key ${evil}` }],
    });
    const state = { ...start(), message: `${evil}: unknown key`, fault: evil, input: null };
    for (let tab = 1; tab <= TABS.length; tab++) {
      for (const shown of [state, { ...press(state, ctx, String(tab), "return", "a", "\u009b", "\u001b"), message: "" }]) {
        const output = render({ ...shown, tab: tab - 1 }, ctx, { width: 100 }).join("\n");
        assert.doesNotMatch(output, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/, `tab ${tab}`);
        assert.doesNotMatch(output, /\u001b/);
      }
    }
    // The sequences go whole (the title text inside an OSC with them); the plain text round them stays.
    assert.match(render({ ...start(), tab: 4 }, ctx, { width: 100 }).join("\n"), /unknown key/, "the text itself still shows");
  });

  it("draws a lock record with the wrong shape without throwing", () => {
    const ctx = context({ snap: { load: 0, resources: [{ name: "heavy", slots: 1, loadMax: 8, holders: [{}], waiting: [{ at: new Date(NOW).toISOString() }], waivers: [] }] } });
    assert.doesNotThrow(() => render(start(), ctx));
  });
});

describe("config screen helpers", () => {
  it("splits a command into words", () => {
    assert.deepEqual(words(`git commit -m "two words" 'and more'`), ["git", "commit", "-m", "two words", "and more"]);
  });

  it("reads the judge's answer for a command", async () => {
    const judge = { spec: "j.mjs", baseDir: "/x" };
    const answer = (verdict) => tryJudge(judge, "npm test", "/x", async () => (command, { argv }) => (typeof verdict === "function" ? verdict(command, argv) : verdict));
    assert.deepEqual(await answer(null), { decision: "allow", reason: "" });
    assert.deepEqual(await answer({ decision: "deny", reason: "no" }), { decision: "deny", reason: "no" });
    assert.deepEqual(await answer({ decision: "ask", reason: "sure?" }), { decision: "ask", reason: "sure?" });
    assert.equal((await answer("yes")).decision, "failed");
    assert.deepEqual(await answer(() => { throw new Error("boom"); }), { decision: "failed", reason: "boom" });
    assert.deepEqual(await answer((command, argv) => ({ decision: "deny", reason: `${command}|${argv.length}` })), { decision: "deny", reason: "npm test|2" });
    assert.equal((await tryJudge(null, "npm test", "/x")).decision, "allow");
  });

  it("offers a project file's settings, naming its judge by full path", () => {
    const dir = mkdtempSync(join(tmpdir(), "import-"));
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "judge.mjs"), "");
    const ctx = context({ project: { path: join(dir, "beefy-slot.json"), config: { heavySlots: 4, perfHost: "mini", judge: "scripts/judge.mjs" } } });
    assert.deepEqual(importable(start(), ctx), { perfHost: "mini", judge: join(dir, "scripts", "judge.mjs") }, "heavySlots is already the draft's");
    assert.deepEqual(importable(start(), context()), {});
    assert.match(text(press(start(), ctx, "5"), ctx), /m\s+copy perfHost, judge in from the project file/);
  });
});

describe("config screen hands and mouse", () => {
  it("moves with w a s d and h j k l, and changes section with brackets", () => {
    const ctx = context();
    for (const [down, up, left, right] of [["s", "w", "a", "d"], ["j", "k", "h", "l"]]) {
      assert.equal(press(start(), ctx, down).sel, 1, down);
      assert.equal(press(start(), ctx, down, up).sel, 0, up);
      assert.equal(press(start(), ctx, right, right, left).draft.heavySlots, 2, `${left} ${right}`);
    }
    assert.equal(press(start(), ctx, "]", "]").tab, 2);
    assert.equal(press(start(), ctx, "[").tab, TABS.length - 1);
    assert.equal(update(press(start(), ctx, "right"), "ctrl-s", ctx).effect, "save");
    assert.equal(update(start(), "c", ctx).effect, "cow");
  });

  it("reads keys, arrows, clicks and the wheel from the terminal", () => {
    assert.deepEqual(parseInput("a\x1b[A\x1b[D\r \x7f\t\x03"), ["a", "up", "left", "return", "space", "backspace", "tab", "ctrl-c"]);
    assert.deepEqual(parseInput("\x1b[<0;12;3M\x1b[<0;12;3m"), [{ x: 11, y: 2 }], "a press is a click; its release is nothing");
    assert.deepEqual(parseInput("\x1b[<64;1;1M\x1b[<65;1;1M\x1b[<2;5;5M"), ["up", "down"], "the wheel moves; the right button does nothing");
    assert.deepEqual(parseInput("\x1b[3~\x1b[Z\x1b"), ["[", "escape"], "an unknown sequence is dropped, shift-tab goes back");
  });

  it("finds what a click does: a section, a row, a preset, a key named on screen", () => {
    const ctx = context();
    const lines = render(start(), ctx);
    const find = (state, word) => {
      const drawn = render(state, ctx);
      const y = drawn.findIndex((line) => line.includes(word));
      return hitAt(state, ctx, { x: [...drawn[y].slice(0, drawn[y].indexOf(word))].length, y });
    };
    assert.deepEqual(find(start(), "3 Perf host"), { tab: 2 });
    assert.deepEqual(find(start(), "settings       tab"), { screen: "settings" });
    assert.deepEqual(find(start(), " queue "), { screen: "queue" });
    assert.deepEqual(find(start(), "tab queue"), { keys: ["tab"] });
    assert.deepEqual(find(start(), "ci  "), { sel: 1 });
    assert.deepEqual(find(start(), "ci-box"), { presetAt: 0, keys: ["p"] });
    assert.deepEqual(find(start(), "n new"), { keys: ["n"] });
    assert.deepEqual(find(start(), "q quit"), { keys: ["q"] });
    assert.deepEqual(find(press(start(), ctx, "5"), "S save"), { keys: ["S"] });
    assert.equal(hitAt(start(), ctx, { x: 70, y: 1 }), null, "blank space does nothing");
    assert.equal(hitAt(start(), ctx, { x: 0, y: lines.length + 5 }), null);
  });

  it("keeps the last three lines when the terminal is short", () => {
    const ctx = context();
    const full = render(press(start(), ctx, "5"), ctx);
    const cut = render(press(start(), ctx, "5"), ctx, { rows: 12 });
    assert.equal(cut.length, 12);
    assert.deepEqual(cut.slice(-3), full.slice(-3));
  });
});

describe("the cow", () => {
  it("walks in, looks at you, and walks out", () => {
    let cow = { x: 80, stop: 30, phase: "in", frame: 0 };
    const seen = [];
    for (let steps = 0; cow && steps < 500; steps++) {
      if (seen.at(-1) !== cow.phase) seen.push(cow.phase);
      assert.equal(cowLines(cow).length, COW_HEIGHT);
      cow = cowStep(cow);
    }
    assert.deepEqual(seen, ["in", "look", "out"]);
    assert.equal(cow, null, "she leaves");
    assert.match(cowLines({ phase: "look" }).join("\n"), /\(\^‿\^\).*moo/);
    assert.notEqual(cowLines({ phase: "in", frame: 0 })[4], cowLines({ phase: "in", frame: 1 })[4], "her legs move");
  });

  it("is drawn only in blank rows, inside the width", () => {
    const lines = ["top", "bottom"];
    assert.equal(withCow(lines, { x: 10, phase: "look" }, 80, 6), lines, "no room: nothing changes");
    assert.equal(withCow(lines, null, 80, 30), lines);
    for (const x of [-12, 0, 40, 75]) {
      const drawn = withCow(lines, { x, phase: "in", frame: 0 }, 80, 20);
      assert.equal(drawn.length, 20);
      assert.deepEqual(drawn.slice(0, 2), lines);
      for (const line of drawn) assert.ok([...line].length <= 80, line);
    }
    assert.match(withCow(lines, { x: 4, phase: "look" }, 80, 20).at(-4), /^ {5}\(\^‿\^\)/);
  });
});

describe("the box and what moves", () => {
  const lit = (lines) => lines.join("\n").replace(/[^━┃┏┓┗┛]/g, "").length;

  it("boxes every line to the width, under a blank row", () => {
    const ctx = context();
    for (const width of [60, 80, 100, 120]) {
      const lines = render(start(), ctx, { width });
      assert.equal(lines[0], "");
      assert.match(lines[1], /^[╭┏][─━]+[╮┓]$/);
      assert.match(lines.at(-1), /^[╰┗][─━]+[╯┛]$/);
      for (const line of lines.slice(1)) assert.equal([...line].length, width, line);
    }
    assert.notEqual(render(start(), ctx, { rows: 12 })[0], "", "short of rows, the room above goes first");
  });

  it("runs one comet per held slot round the box, four at most, and none when idle", () => {
    const body = Array.from({ length: 6 }, () => [["", "x"]]);
    const draw = (jobs, tick) => frame(body, { width: 40, jobs, tick }).map((segments) => segments.map(([, part]) => part).join(""));
    assert.equal(lit(draw(0, 3)), 0);
    assert.equal(lit(draw(1, 10)), 12, "a comet is twelve cells along the top");
    assert.match(draw(1, 10)[1], /^╭─{8}━{12}─+╮$/);
    assert.match(draw(1, 11)[1], /^╭─{10}━{12}─+╮$/, "two cells a beat");
    assert.equal(draw(1, 22)[2].at(-1), "┃", "and on down the right side");
    assert.ok(lit(draw(9, 10)) <= 4 * 12 && lit(draw(9, 10)) > 2 * 6);
    const idle = context({ snap: { load: 0, resources: [] } });
    assert.equal(lit(render(start(), idle)), 0);
    assert.ok(lit(render(start(), context())) > 0);
    assert.equal(lit(render(start(), context({ still: true }))), 0, "BEEFY_SLOT_STILL");
  });

  it("shows the cores, memory and load on every section", () => {
    const vitals = { cores: [0, 0.5, 1, 0.95, 0, 0, 0, 0], cpu: [0.1, 0.3], mem: { used: 0.62, pressure: "warn" }, memory: [0.6, 0.62] };
    const ctx = context({ vitals, tick: 0 });
    for (const tab of [1, 2, 3, 4, 5]) assert.match(text(press(start(), ctx, String(tab)), ctx), /cores ▁▅██▁▁▁▁  30% {3}mem ▰▰▰▰▰▱▱▱ 62% warn {3}load 5\.2 of 8\.0/);
    const scale = text(press(start(), ctx, "2"), ctx);
    assert.match(text(start(), context({ snap: { load: 0, resources: [] } })), /cores … {3}mem … {3}load 0\.0 of 8\.0/);
  });

  it("moves the held slots and the line with the beat", () => {
    const at = (tick) => text(start(), context({ tick }));
    assert.match(at(0), /██ pnpm-check/);
    assert.match(at(6), /▒▓ pnpm-check/);
    assert.match(at(0), /▚1 lint-all/);
    assert.match(at(5), /▞1 lint-all/);
    assert.match(at(0), /▚1 lint-all/);
  });
});

describe("the beefy command", () => {
  it("is a second name for the same file, and bare without a terminal prints usage", () => {
    const bins = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).bin;
    assert.equal(bins.beefy, bins["beefy-slot"]);
    const bare = spawnSync(process.execPath, [new URL("../bin/beefy-slot.mjs", import.meta.url).pathname], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /^usage: beefy-slot <command>/);
  });
});

// The queue screen: the rows, the keys, and what each key named on screen does when clicked.
const item = (key, section, extra = {}) => ({ key, id: key, section, resource: "heavy", mode: "detached", command: `cmd ${key}`, cwd: "/h/repos/app", who: "you", since: NOW - 252_000, cancellable: section !== "recent", log: `/h/u/app/.beefy-slot/jobs/${key}.log`, ...extra });
const J7 = item("j7", "running", { mode: "foreground", command: "pnpm check", who: "claude", slot: "heavy" });
const J8 = item("j8", "waiting", { mode: "foreground", command: "lint-all --fix", since: NOW - 125_000, place: 1 });
const J9 = item("j9", "waiting", { command: "npm test", since: NOW - 40_000, place: 2 });
const J6 = item("j6", "recent", { command: "xcodebuild -scheme App build", state: "done", exit: 0, ended: NOW - 120_000 });
const J5 = item("j5", "recent", { command: "npm test", state: "failed", exit: 1, ended: NOW - 300_000 });
const inner = (state, ctx, width = 80) => render(state, ctx, { width }).slice(2, -1).map((line) => [...line].slice(1, -1).join("").trimEnd()).join("\n");
const busy = (items, extra = {}) => context({ queue: { items }, ...extra });
const queue = (extra = {}) => ({ ...createState({}, { screen: "queue" }), ...extra });
const where = (state, ctx, word, width = 80) => {
  const drawn = render(state, ctx, { width });
  const y = drawn.findIndex((line) => line.includes(word));
  assert.ok(y >= 0, `"${word}" is on screen`);
  return hitAt(state, ctx, { x: [...drawn[y].slice(0, drawn[y].indexOf(word))].length, y, width });
};

describe("the queue screen drawing", () => {
  it("lists running, waiting and recent jobs with their places and times", () => {
    const ctx = busy([J7, J8, J9, J6]);
    const screen = inner(queue(), ctx);
    assert.match(screen, /queue\s+heavy · 1 slot  ● 1 running · 2 waiting/);
    assert.match(screen, /load 5\.2 of 8\.0/);
    assert.match(screen, /running\s+heavy · 1 of 1 slot\n.*▸ ██ j7\s+pnpm check\s+foreground\s+4m 12s/);
    assert.match(screen, /▚1 j8\s+lint-all --fix\s+foreground\s+2m 05s/);
    assert.match(screen, /▚2 j9\s+npm test\s+detached\s+40s/);
    assert.match(screen, /✓  j6\s+xcodebuild -scheme App build\s+exit 0  2m ago/);
    assert.match(screen, /↑↓ select {3}x cancel {3}l log {3}tab settings {3}\? help {3}q quit/);
    assert.match(inner(queue(), ctx, 120), /pnpm check\s+foreground repos\/app\s+claude\s+4m 12s/, "the folder and who show from 120 columns");
    for (const width of [60, 80, 100, 120]) for (const line of render(queue(), ctx, { width })) assert.ok([...line].length <= width, `${width}: ${line}`);
  });

  it("draws an empty queue with how to start a job", () => {
    const screen = inner(queue(), busy([]));
    assert.match(screen, /● idle/);
    assert.match(screen, /░░ free/);
    assert.match(screen, /nobody in line/);
    assert.match(screen, /no jobs yet/);
    assert.match(screen, /beefy pnpm check\n.*beefy -d npm test\s+-d runs it in the background and returns a job id/);
    assert.doesNotMatch(screen, /↑↓ select/);
    assert.match(screen, / {2}tab settings {3}\? help {3}q quit/);
    assert.doesNotMatch(screen, /load 5\.2/, "no load beside the memory while nothing runs");
  });

  it("says a waiter is held by the load and names the busiest process", () => {
    const ctx = busy([{ ...J8, loadHold: true }, J6], { snap: { load: 9.4, resources: [{ name: "heavy", slots: 1, loadMax: 8, holders: [], waiting: [{ as: "a", at: "x" }], waivers: [] }] }, busiest: { name: "xcodebuild", pid: 4121, cores: 5.8, started: 360 } });
    const screen = inner(queue(), ctx, 120);
    assert.match(screen, /● 1 waiting for load/);
    assert.match(screen, /▸ ▚1 j8/);
    assert.match(screen, /Waiting for the load to drop\. A slot is free, but the machine is too busy to add a job\./);
    assert.match(screen, /load 1 min {2}█{40}▏ 9\.4 {2}limit 8\.0/);
    assert.match(screen, /busiest {5}xcodebuild {2}pid 4121 · 5\.8 of 8 cores · started 6m ago/);
    assert.match(screen, /starts when load is under 8\.0 · change the limit in settings › Load/);
  });

  it("shows a failed job's last lines under it, and says so for a finished one", () => {
    const ctx = busy([J6, J5], { tail: { key: "j5", lines: ["FAIL test/jobs.test.mjs", "  ✗ cancel mid-run  (1.2s)", "    AssertionError: slot still held", "  1 failed · 11 passed"] } });
    const screen = inner(queue(), ctx);
    assert.match(screen, /● idle · 2 finished/);
    assert.match(screen, /▸ ✗  j5\s+npm test\s+exit 1  5m ago\n.*┌─+┐\n.*│ FAIL test\/jobs\.test\.mjs\s+│\n/);
    assert.match(screen, /last 4 lines · l {2}full log · or {2}beefy log j5/);
    assert.match(screen, /detached jobs stay until 50 newer ones push them off/);
    assert.doesNotMatch(screen, /x cancel/, "a finished job cannot be cancelled");
    assert.match(inner(queue({ pick: "j6" }), ctx), /▸ ✓  j6/);
  });

  it("asks before cancelling and names who takes the slot", () => {
    const screen = inner(queue({ confirm: "j7" }), busy([J7, J8, J9, J6]));
    assert.match(screen, /Cancel j7 {2}pnpm check\?/);
    assert.match(screen, /It is running, 4m 12s in\. Beefy stops the command and\s+│\n.*everything it started, then j8 takes the slot at once\./);
    assert.match(screen, /y {2}cancel it {6}n {2}keep it/);
    assert.match(screen, / {2}y cancel it {3}n keep it {3}esc back/);
    assert.match(inner(queue({ confirm: "j9" }), busy([J7, J8, J9, J6])), /It is waiting, number 2 in line\./);
  });

  it("draws a log, following the end or paused", () => {
    const lines = logLines(J7, Array.from({ length: 30 }, (_, i) => (i === 4 ? "  ✓ ok line" : `line ${i + 1}`)).join("\n"));
    const ctx = busy([J7], { logView: { key: "j7", lines }, logRows: 10 });
    const following = inner(queue({ screen: "log", log: { key: "j7", top: null } }), ctx);
    assert.match(following, /queue › log\s+j7 · pnpm check {2}● running 4m 12s/);
    assert.match(following, /following · 32 lines · output is saved to \.\/\.beefy-slot\/jobs\/j7\.log|following · 32 lines · output is saved to \/h\/u\/app\/\.beefy-slot\/jobs\/j7\.log/);
    assert.match(following, /32 {2}line 30/);
    assert.doesNotMatch(following, / 1 {2}\$ cmd/);
    const paused = inner(queue({ screen: "log", log: { key: "j7", top: 0 } }), ctx);
    assert.match(paused, /paused · showing 1-10 · 32 lines/);
    assert.match(paused, / 1 {2}\$ pnpm check {2}\(repos\/app\)\n.*2\n.*3 {2}line 1/);
    assert.match(paused, /↑↓ pgup pgdn scroll {3}f follow {3}x cancel job {3}esc back/);
    assert.match(inner(queue({ screen: "log", log: { key: "j6", top: null } }), busy([J6], { logView: { key: "j6", lines: ["$ x", ""] } })), /● done · exit 0/);
    assert.doesNotMatch(inner(queue({ screen: "log", log: { key: "j6", top: null } }), busy([J6], { logView: { key: "j6", lines: [] } })), /x cancel job/);
    assert.match(inner(queue({ screen: "log", log: { key: "j8", top: null } }), busy([{ ...J8, log: undefined }], { logView: null })), /no saved output · a foreground job prints to the terminal that started it/);
  });

  it("opens on settings with the section names, and the queue is the other tab", () => {
    assert.deepEqual(TABS, ["Slots", "Load", "Perf host", "Command rules", "Sources"]);
    const screen = inner(start(), context());
    assert.match(screen, / queue {4}settings {7}tab switches/);
    assert.match(screen, /1 Slots {4}2 Load {4}3 Perf host {4}4 Command rules {4}5 Sources/);
    assert.match(screen, /\[ \] section {3}hjkl · click {3}S save {3}u undo {3}tab queue {3}\? help {3}q quit/);
    assert.doesNotMatch(inner(press(start(), context(), "2"), context()), /\? help/, "the Load screen is drawn without it");
    assert.match(inner(press(start(), context(), "2"), context()), /would a new job start right now\n.*heavy\s+no\s+pool full/);
  });
});

describe("the queue screen keys", () => {
  const ctx = busy([J7, J8, J9, J6]);
  it("moves the cursor over the rows and stops at the ends", () => {
    assert.equal(press(queue(), ctx, "down").pick, "j8");
    assert.equal(press(queue(), ctx, "j", "j", "j").pick, "j6");
    assert.equal(press(queue(), ctx, ...Array(9).fill("down")).pick, "j6");
    assert.equal(press(queue(), ctx, "down", "up").pick, "j7");
    assert.equal(press(queue(), ctx, "s", "w").pick, "j7");
    assert.equal(press(queue(), ctx, "k").pick, "j7");
  });

  it("asks to confirm a cancel, and only y cancels", () => {
    const asked = update(queue(), "x", ctx);
    assert.equal(asked.effect, undefined, "x alone cancels nothing");
    assert.equal(asked.state.confirm, "j7");
    const yes = update(asked.state, "y", ctx);
    assert.deepEqual([yes.effect, yes.target.key, yes.state.confirm], ["cancel", "j7", null]);
    for (const no of ["n", "escape"]) {
      const kept = update(asked.state, no, ctx);
      assert.equal(kept.effect, undefined, no);
      assert.equal(kept.state.confirm, null, no);
    }
    assert.match(update(queue({ pick: "j6" }), "x", ctx).state.message, /already ended/);
    assert.equal(update(queue({ pick: "j6" }), "x", ctx).state.confirm, null);
    assert.match(update(queue(), "x", busy([{ ...J7, mode: "lock", cancellable: false }])).state.message, /held lock/);
    assert.match(update(queue(), "x", busy([{ ...J7, cancellable: false }])).state.message, /no beefy run found/);
  });

  it("opens a log with l, scrolls it, follows with f, and goes back with esc", () => {
    const logged = busy([J7], { logView: { key: "j7", lines: Array.from({ length: 40 }, (_, i) => `l${i}`) }, logRows: 10 });
    const open = update(queue(), "l", logged).state;
    assert.deepEqual([open.screen, open.log], ["log", { key: "j7", top: null }]);
    assert.equal(press(open, logged, "up").log.top, 29, "up leaves the end");
    assert.equal(press(open, logged, "up", "up", "down").log.top, 29);
    assert.equal(press(open, logged, "pgup").log.top, 20);
    assert.equal(press(open, logged, "pgup", "pgup", "pgup", "pgup", "pgup").log.top, 0);
    assert.equal(press(open, logged, "pgup", "pgdn", "pgdn").log.top, 30, "stops at the last full view");
    assert.equal(press(open, logged, "up", "f").log.top, null, "f follows again");
    assert.equal(press(open, logged, "f").log.top, 30, "f stops following where it is");
    assert.equal(press(open, logged, "escape").screen, "queue");
    assert.equal(press(open, logged, "tab").screen, "settings");
    const cancel = press(open, logged, "x");
    assert.deepEqual([cancel.screen, cancel.confirm], ["queue", "j7"], "x on a log asks the same confirm");
    assert.equal(update(open, "q", logged).effect, "quit");
    assert.equal(press(queue(), logged, "return").screen, "log", "enter opens it too");
  });

  it("switches between the queue and settings with tab, and swallows settings keys", () => {
    assert.equal(press(queue(), ctx, "tab").screen, "settings");
    assert.equal(press(start(), ctx, "tab").screen, "queue");
    assert.equal(press(press(start(), ctx, "tab"), ctx, "tab").screen, "settings");
    const changed = press(start(), ctx, "right");
    assert.equal(press(changed, ctx, "tab").draft.heavySlots, 2, "the draft is kept across the tab");
    assert.equal(update(press(changed, ctx, "tab"), "S", ctx).effect, undefined, "S saves from settings only");
    assert.equal(press(queue(), ctx, "1").tab, 0);
    assert.equal(update(queue(), "q", ctx).effect, "quit");
    assert.equal(update(queue(), "c", ctx).effect, "cow");
    assert.equal(press(queue(), ctx, "?").help, true);
    assert.match(inner(press(queue(), ctx, "?"), ctx), /cancel the selected job, after a confirm/);
  });
});

describe("the queue screen clicks", () => {
  const ctx = busy([J7, J8, J9, J6]);
  it("makes every key named on screen clickable", () => {
    const click = (state, c, word, width) => where(state, c, word, width);
    assert.deepEqual(click(queue(), ctx, "x cancel"), { keys: ["x"] });
    assert.deepEqual(click(queue(), ctx, "l log"), { keys: ["l"] });
    assert.deepEqual(click(queue(), ctx, "tab settings"), { keys: ["tab"] });
    assert.deepEqual(click(queue(), ctx, "? help"), { keys: ["?"] });
    assert.deepEqual(click(queue(), ctx, "q quit"), { keys: ["q"] });
    assert.deepEqual(click(queue(), ctx, "↑↓ select"), { keys: ["up"] });
    assert.deepEqual(click(queue(), ctx, "↓ select"), { keys: ["down"] });
    assert.deepEqual(click(queue(), ctx, "settings       tab"), { screen: "settings" });
    assert.deepEqual(click(queue(), ctx, "queue    settings"), { screen: "queue" });
    assert.deepEqual(click(queue(), ctx, "j8  lint"), { pick: "j8" }, "a row picks it");
    assert.deepEqual(click(queue(), ctx, "j6  xcode", 120), { pick: "j6" });
    const confirm = queue({ confirm: "j7" });
    assert.deepEqual(click(confirm, ctx, "y  cancel it"), { keys: ["y"] }, "in the box");
    assert.deepEqual(click(confirm, ctx, "n  keep it"), { keys: ["n"] });
    assert.deepEqual(click(confirm, ctx, "y cancel it"), { keys: ["y"] }, "at the foot");
    assert.deepEqual(click(confirm, ctx, "n keep it"), { keys: ["n"] });
    assert.deepEqual(click(confirm, ctx, "esc back"), { keys: ["escape"] });
    const log = queue({ screen: "log", log: { key: "j7", top: null } });
    const logged = busy([J7], { logView: { key: "j7", lines: ["$ x", ""] } });
    assert.deepEqual(click(log, logged, "pgup"), { keys: ["pgup"] });
    assert.deepEqual(click(log, logged, "pgdn"), { keys: ["pgdn"] });
    assert.deepEqual(click(log, logged, "f follow"), { keys: ["f"] });
    assert.deepEqual(click(log, logged, "x cancel job"), { keys: ["x"] });
    assert.deepEqual(click(log, logged, "esc back"), { keys: ["escape"] });
    const failed = busy([J6, J5], { tail: { key: "j5", lines: ["FAIL"] } });
    assert.deepEqual(click(queue(), failed, "l  full log"), { keys: ["l"] });
    assert.deepEqual(click(queue(), busy([]), "tab settings"), { keys: ["tab"] });
    assert.deepEqual(click(start(), ctx, "tab queue"), { keys: ["tab"] });
    assert.equal(hitAt(queue(), ctx, { x: 70, y: 0 }), null, "blank space does nothing");
  });

  it("reads page up and page down", () => {
    assert.deepEqual(parseInput("\x1b[5~\x1b[6~"), ["pgup", "pgdn"]);
  });
});

describe("the queue's rows from the lock folder and the job records", () => {
  it("reads a foreground run's command from its process, and a detached job from its record", () => {
    const snap = { load: 1, resources: [{ name: "heavy", slots: 1, loadMax: 8, holders: [{}], waiting: [{}] }] };
    const holder = { slot: "heavy", as: "run:411", pid: 411, watch: 411, at: new Date(NOW - 60_000).toISOString() };
    const ticket = { as: "claude", pid: 500, at: new Date(NOW - 30_000).toISOString() };
    const job = { id: "ab12cd", state: "waiting", resource: "heavy", command: ["npm", "test"], cwd: "/h/app", created: new Date(NOW - 10_000).toISOString(), wrapper: { pid: 600 } };
    const { items } = collectQueue({ dir: "/x", snap, now: NOW, jobs: [job], holdersOf: () => [holder], lineOf: () => [ticket, { ...ticket, as: "run:600", pid: 600 }], info: (pid) => ({ command: pid === 411 ? "pnpm check" : "lint-all", cwd: "/h/repos/outrider" }) });
    assert.deepEqual(items.map((row) => [row.id, row.section, row.mode, row.command, row.who, row.place]), [["p411", "running", "foreground", "pnpm check", "you", undefined], ["p500", "waiting", "foreground", "lint-all", "claude", 1], ["ab12cd", "waiting", "detached", "npm test", "you", 2]]);
    assert.equal(items[2].loadHold, undefined);
    const held = collectQueue({ dir: "/x", snap: { load: 9, resources: [{ ...snap.resources[0], holders: [] }] }, now: NOW, jobs: [job], holdersOf: () => [], lineOf: () => [{ ...ticket, as: "run:600", pid: 600 }], info: () => ({ command: "", cwd: "" }) });
    assert.equal(held.items[0].loadHold, true, "a slot is open, the load is over the limit, and it is first");
  });

  it("puts finished jobs under recent with their exit and when they ended", () => {
    const record = (id, state, exit, ended) => ({ id, state, exit, resource: "heavy", command: ["x"], cwd: "/h/app", created: new Date(NOW - 900_000).toISOString(), finished: new Date(NOW - ended).toISOString(), wrapper: { pid: 1 } });
    const { items } = collectQueue({ dir: "/x", snap: { load: 0, resources: [{ name: "heavy", slots: 1, loadMax: 8, holders: [], waiting: [] }] }, now: NOW, jobs: [record("a00001", "done", 0, 120_000), record("a00002", "failed", 1, 300_000)], holdersOf: () => [], lineOf: () => [] });
    assert.deepEqual(items.map((row) => [row.section, row.state, row.exit, row.ended]), [["recent", "done", 0, NOW - 120_000], ["recent", "failed", 1, NOW - 300_000]]);
    assert.deepEqual(items.map((row) => row.cancellable), [false, false]);
  });

  it("finds the command in a run's argument line", () => {
    assert.equal(commandOf("node /opt/beefy/bin/beefy-slot.mjs pnpm check"), "pnpm check");
    assert.equal(commandOf("/usr/bin/node /x/bin/beefy-slot.mjs --wait 5 --as claude -- status"), "status");
    assert.equal(commandOf("node /x/bin/beefy-slot.mjs run heavy --as me --ttl 5 -- npm test"), "npm test");
    assert.equal(commandOf("node /x/bin/beefy-slot.mjs -d --on perf npm run bench"), "npm run bench");
    assert.equal(commandOf("something else"), "");
  });
});

// The loop with fake streams: a bare terminal session on the queue, and `config` straight to settings.
const CLI = fileURLToPath(new URL("../bin/beefy-slot.mjs", import.meta.url));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const terminal = (columns = 80, rows = 30) => {
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setEncoding() {}, setRawMode() {}, resume() {}, pause() {} });
  const stdout = { isTTY: true, columns, rows, data: "", write(chunk) { this.data += chunk; return true; } };
  const screen = () => stdout.data.split("\x1b[H").at(-1).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const until = async (pattern, ms = 6000) => {
    const end = Date.now() + ms;
    while (!pattern.test(screen())) {
      if (Date.now() > end) throw new Error(`never saw ${pattern}\n${screen()}`);
      await wait(40);
    }
  };
  return { stdin, stdout, screen, until };
};
const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-"));
  const env = { BEEFY_SLOT_LOCK_DIR: join(dir, "locks"), BEEFY_SLOT_LOAD_MAX: "1000000", BEEFY_SLOT_STILL: "1", BEEFY_SLOT_NO_COW: "1", NO_COLOR: "1", BEEFY_SLOT_LOCK_POLL_SECONDS: "1", BEEFY_SLOT_LOCK_HEARTBEAT_SECONDS: "1" };
  mkdirSync(join(dir, "home"));
  return { dir, env, home: join(dir, "home"), cwd: dir };
};

describe("the queue and settings in a terminal", () => {
  it("opens the queue for a bare beefy, and `config` opens settings", async () => {
    const box = sandbox();
    const bare = terminal();
    const closed = runTui({ stdin: bare.stdin, stdout: bare.stdout, env: box.env, home: box.home, cwd: box.cwd, cores: 8, screen: "queue" });
    await bare.until(/beefy-slot queue .*● idle/);
    assert.match(bare.screen(), /Run a command and it joins the line/);
    bare.stdin.emit("data", "\t");
    await bare.until(/beefy-slot settings/);
    bare.stdin.emit("data", "\t");
    await bare.until(/beefy-slot queue/);
    bare.stdin.emit("data", "q");
    assert.equal(await closed, 0);
    const config = terminal();
    const done = configMain([], { stdin: config.stdin, stdout: config.stdout, env: box.env, home: box.home, cwd: box.cwd, cores: 8 });
    await config.until(/beefy-slot settings/);
    assert.match(config.screen(), /1 Slots/);
    config.stdin.emit("data", "q");
    assert.equal(await done, 0);
  });

  it("shows a finished job, opens its log, and a click on a named key does what the key does", async () => {
    const box = sandbox();
    const jobs = join(box.env.BEEFY_SLOT_LOCK_DIR, "jobs");
    mkdirSync(jobs, { recursive: true });
    const stamp = new Date(Date.now() - 300_000).toISOString();
    writeFileSync(join(jobs, "abc123.json"), JSON.stringify({ id: "abc123", state: "failed", exit: 1, resource: "heavy", command: ["npm", "test"], cwd: "/h/repos/code-scry", created: stamp, finished: stamp }));
    writeFileSync(join(jobs, "abc123.log"), "FAIL test/jobs.test.mjs\n  1 failed\n");
    const t = terminal();
    const closed = runTui({ stdin: t.stdin, stdout: t.stdout, env: box.env, home: box.home, cwd: box.cwd, cores: 8, screen: "queue" });
    await t.until(/▸ ✗  abc123\s+npm test\s+exit 1  5m ago/);
    await t.until(/│ FAIL test\/jobs\.test\.mjs/);
    // A click on "l log" opens the log.
    const lines = t.screen().split("\n");
    const y = lines.findIndex((line) => line.includes("l log"));
    t.stdin.emit("data", `\x1b[<0;${lines[y].indexOf("l log") + 2};${y + 1}M`);
    await t.until(/queue › log/);
    await t.until(/3 {2}FAIL test\/jobs\.test\.mjs/);
    assert.match(t.screen(), /1 {2}\$ npm test {2}\(repos\/code-scry\)/);
    t.stdin.emit("data", "\x1b");
    await t.until(/↑↓ select/);
    t.stdin.emit("data", "x");
    await wait(200);
    assert.doesNotMatch(t.screen(), /Cancel/, "a finished job cannot be cancelled");
    t.stdin.emit("data", "q");
    assert.equal(await closed, 0);
  });

  it("cancels a running detached job after x and y, and keeps it after n", async () => {
    const box = sandbox();
    const run = (args) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...box.env }, cwd: box.cwd, encoding: "utf8" });
    const id = run(["-d", "node", "-e", "setInterval(() => {}, 1000)"]).stdout.trim();
    assert.match(id, /^[0-9a-f]{6}$/);
    const state = () => JSON.parse(run(["jobs", "--json"]).stdout)[0].state;
    for (let look = 0; state() !== "running" && look < 100; look++) await wait(50);
    assert.equal(state(), "running");
    const t = terminal();
    const closed = runTui({ stdin: t.stdin, stdout: t.stdout, env: box.env, home: box.home, cwd: box.cwd, cores: 8, screen: "queue" });
    await t.until(new RegExp(`▸ .. ${id}\\s+node -e`));
    t.stdin.emit("data", "x");
    await t.until(new RegExp(`Cancel ${id}`));
    t.stdin.emit("data", "n");
    await t.until(/↑↓ select/);
    assert.equal(state(), "running", "n keeps it");
    t.stdin.emit("data", "x");
    await t.until(new RegExp(`Cancel ${id}`));
    t.stdin.emit("data", "y");
    await t.until(new RegExp(`cancelled ${id}`), 20_000);
    await t.until(new RegExp(`${id}.*cancel`), 8000);
    assert.equal(state(), "cancelled");
    t.stdin.emit("data", "q");
    assert.equal(await closed, 0);
  });
});

// What the review of the queue screen found: a short terminal, long lists, text from outside, stale pids, odd records, the way out.
const RESOURCES = [{ name: "heavy", slots: 1, loadMax: 8, holders: [{}], waiting: [], waivers: [] }];
const SNAP = { load: 1, resources: RESOURCES };
const COLD = { command: "", cwd: "" };

describe("the queue screen in a short terminal and with a long list", () => {
  it("keeps the confirm box whole at 24 rows and trims the list instead", () => {
    const ctx = busy([J7, J8, J9, J6, J5], { tail: null });
    const drawn = render(queue({ confirm: "j7" }), ctx, { width: 80, rows: 24 });
    assert.ok(drawn.length <= 24, `${drawn.length} lines`);
    const screen = drawn.join("\n");
    assert.match(screen, /Cancel j7 {2}pnpm check\?/);
    assert.match(screen, /everything it started, then j8 takes the slot at once\./);
    assert.match(screen, /y {2}cancel it {6}n {2}keep it/);
    assert.match(screen, /└─+┘/, "the box has its bottom");
    assert.match(screen, /▸ .. j7/, "the row it is about shows");
    assert.match(screen, / {2}y cancel it {3}n keep it {3}esc back/);
  });

  it("scrolls the list to the cursor, so the row marked and the row x acts on are the same one you can see", () => {
    const recent = Array.from({ length: 20 }, (_, i) => item(`a${String(i).padStart(2, "0")}`, "recent", { state: "done", exit: 0, ended: NOW - 60_000 * (i + 1), cancellable: false }));
    const ctx = busy([J7, ...recent]);
    for (const pick of ["a00", "a14", "a19"]) {
      const drawn = render(queue({ pick }), ctx, { width: 80, rows: 24 });
      assert.ok(drawn.length <= 24, `${pick}: ${drawn.length} lines`);
      assert.ok(drawn.some((line) => new RegExp(`▸ ✓ {2}${pick}`).test(line)), `${pick} is marked and on screen`);
    }
    const drawn = render(queue({ pick: "a14" }), ctx, { width: 80, rows: 24 });
    const y = drawn.findIndex((line) => line.includes("a14"));
    assert.deepEqual(hitAt(queue({ pick: "a14" }), ctx, { x: 10, y, width: 80, rows: 24 }), { pick: "a14" }, "a click lands on the row drawn there");
    assert.equal(update(queue({ pick: "a14" }), "l", ctx).state.log.key, "a14");
    // A failed job's lines hang under it, and show with it.
    const failed = busy([J7, ...recent.slice(0, 15), { ...J5, id: "z99", key: "z99" }], { tail: { key: "z99", lines: ["boom", "bang"] } });
    assert.match(render(queue({ pick: "z99" }), failed, { width: 80, rows: 24 }).join("\n"), /▸ ✗ {2}z99[^\n]*\n[^\n]*┌/);
  });
});

describe("text from outside the program", () => {
  const HOSTILE = "ls\x1b[2J\x1b]0;title\x07 \x1b[?1049l\x1b[?1000l\x1b[?25h\ttab\rback\x07\x9b2J";
  it("strips escape sequences and control characters, and keeps tabs as gaps", () => {
    assert.equal(clean(HOSTILE), "ls  tabback");
    assert.equal(clean("a\x1b[31mred\x1b[0m\x00b\x7fc d"), "aredbcd");
    assert.equal(clean("日本語 ok"), "日本語 ok");
  });

  it("never lets a command, folder, name, log line or failed tail reach the terminal as a code", () => {
    const rows = [item("j1", "running", { command: HOSTILE, cwd: `/h/${HOSTILE}`, who: HOSTILE, mode: "foreground" }), item("j6", "recent", { state: "failed", exit: 1, ended: NOW - 5000, command: HOSTILE })];
    const ctx = busy(rows, { tail: { key: "j6", lines: [HOSTILE, "\x1b[2Jplain"] } });
    for (const state of [queue(), queue({ pick: "j6" }), queue({ confirm: "j1" })]) for (const width of [80, 120]) for (const line of render(state, ctx, { width })) assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f]/, line);
    const log = busy([rows[0]], { logView: { key: "j1", lines: logLines(rows[0], `${HOSTILE}\nprogress 10%\r50%\r100%\n`) } });
    const drawn = render(queue({ screen: "log", log: { key: "j1", top: null } }), log, { width: 80, rows: 30 });
    for (const line of drawn) assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f]/, line);
    assert.match(drawn.join("\n"), /100%/);
    assert.doesNotMatch(drawn.join("\n"), /10%/, "a carriage return keeps the last redraw");
    const { items } = collectQueue({ dir: "/x", snap: SNAP, now: NOW, jobs: [], holdersOf: () => [{ slot: "heavy", as: HOSTILE, pid: 411, watch: 411, at: new Date(NOW).toISOString() }], lineOf: () => [{ as: HOSTILE, pid: 500, at: new Date(NOW).toISOString() }], info: () => ({ command: HOSTILE, cwd: HOSTILE }) });
    for (const row of items) for (const field of [row.command, row.cwd, row.who]) assert.doesNotMatch(field, /[\x00-\x1f\x7f-\x9f]/);
  });
});

describe("wide characters", () => {
  it("counts a wide character as two columns and a mark as none", () => {
    assert.deepEqual([cols("abc"), cols("日本語"), cols("é"), cols("a🙂b")], [3, 6, 1, 4]);
  });

  it("keeps every row inside the frame when commands are wide", () => {
    const wide = ["日本語のコマンドを実行する非常に長い名前のテスト", "🙂🙂🙂 emoji run", "ééé marks"];
    const rows = [J7, ...wide.map((command, i) => item(`w${i}`, i ? "waiting" : "running", { command, place: i, cwd: "/h/日本語/プロジェクト", who: "田中さん" })), item("r1", "recent", { command: wide[0], state: "done", exit: 0, ended: NOW - 1000 })];
    for (const state of [queue(), queue({ confirm: "w0" }), queue({ pick: "r1" })]) {
      for (const width of [60, 80, 100, 120]) for (const line of render(state, busy(rows), { width })) assert.ok(cols(line) <= width, `${width}: ${cols(line)} ${line}`);
    }
    const drawn = render(queue(), busy(rows), { width: 80 });
    assert.ok(drawn.slice(1).every((line) => cols(line) === cols(drawn[1])), "every line of the box is as wide as the top");
  });
});

describe("what a cancel may signal", () => {
  const holder = (pid, extra = {}) => ({ slot: "heavy", as: `run:${pid}`, pid, watch: pid, at: new Date(NOW).toISOString(), ...extra });
  const rows = (holders, tickets, info) => collectQueue({ dir: "/x", snap: SNAP, now: NOW, jobs: [], holdersOf: () => holders, lineOf: () => tickets, info }).items;

  it("makes a foreground run cancellable only when its process still looks like a beefy run", () => {
    const [found] = rows([holder(411)], [], () => ({ command: "pnpm check", cwd: "/h" }));
    assert.deepEqual([found.cancellable, found.command, found.pid], [true, "pnpm check", 411]);
    const [stale] = rows([holder(411)], [], () => COLD);
    assert.deepEqual([stale.cancellable, stale.command], [false, "run:411"]);
  });

  it("ignores pids that are not one process: below 2, negative, fractions, strings", () => {
    const asked = [];
    const info = (pid) => (asked.push(pid), { command: "x", cwd: "" });
    const tickets = [-5, 0, 1, -1, 2.5, "412", null, undefined].map((pid) => ({ as: "t", pid, at: new Date(NOW).toISOString() }));
    const items = rows([holder(-9), holder(1, { slot: "heavy~2" })], tickets, info);
    assert.deepEqual(items.map((row) => [row.cancellable, row.pid]), items.map(() => [false, undefined]));
    assert.deepEqual(asked, [], "the process table is not asked about them");
    assert.equal(new Set(items.map((row) => row.key)).size, items.length, "keys stay apart");
  });

  it("leaves an unrelated process alone when a stale record names its pid", async () => {
    const box = sandbox();
    const other = spawn("sleep", ["300"], { stdio: "ignore" });
    try {
      mkdirSync(box.env.BEEFY_SLOT_LOCK_DIR, { recursive: true });
      const at = new Date().toISOString();
      writeFileSync(join(box.env.BEEFY_SLOT_LOCK_DIR, "heavy.json"), JSON.stringify({ resource: "heavy", as: `run:${other.pid}`, id: "x", slots: 1, at, until: new Date(Date.now() + 1_800_000).toISOString(), pid: other.pid, watch: other.pid }));
      const t = terminal();
      const closed = runTui({ stdin: t.stdin, stdout: t.stdout, env: box.env, home: box.home, cwd: box.cwd, cores: 8, screen: "queue" });
      await t.until(new RegExp(`p${other.pid}`));
      t.stdin.emit("data", "x");
      await t.until(/no beefy run found/);
      assert.doesNotMatch(t.screen(), /Cancel/);
      assert.equal(process.kill(other.pid, 0), true, "the sleep is still there");
      assert.equal(other.exitCode, null);
      t.stdin.emit("data", "q");
      assert.equal(await closed, 0);
    } finally {
      other.kill();
    }
  });

  it("asks a real foreground run to stop with SIGTERM, says so, and keeps its row until it exits", async () => {
    const box = sandbox();
    const run = spawn(process.execPath, [CLI, "node", "-e", "setInterval(() => {}, 1000)"], { env: { ...process.env, ...box.env }, cwd: box.cwd, stdio: "ignore" });
    const exited = new Promise((resolve) => run.on("exit", (code, signal) => resolve({ code, signal })));
    try {
      const t = terminal();
      const closed = runTui({ stdin: t.stdin, stdout: t.stdout, env: box.env, home: box.home, cwd: box.cwd, cores: 8, screen: "queue" });
      await t.until(new RegExp(`▸ .. p${run.pid}\\s+node -e`), 15_000);
      t.stdin.emit("data", "x");
      await t.until(new RegExp(`Cancel p${run.pid}`));
      t.stdin.emit("data", "y");
      await t.until(new RegExp(`asked p${run.pid} to stop \\(SIGTERM\\)`));
      assert.doesNotMatch(t.screen(), /cancelled/);
      const end = await exited;
      assert.ok(end.code === 143 || end.signal === "SIGTERM" || end.code === 130, JSON.stringify(end));
      t.stdin.emit("data", "q");
      assert.equal(await closed, 0);
    } finally {
      run.kill();
    }
  });

  it("makes a lost job cancellable, says what that does, and does not say 'number undefined' for one that ended", () => {
    const lost = { id: "ab12cd", state: "lost", resource: "heavy", command: ["npm", "test"], cwd: "/h", created: new Date(NOW - 90_000).toISOString(), wrapper: { pid: 4242, start: "" } };
    const [row] = collectQueue({ dir: "/x", snap: SNAP, now: NOW, jobs: [lost], holdersOf: () => [], lineOf: () => [] }).items;
    assert.deepEqual([row.section, row.cancellable], ["recent", true]);
    assert.match(inner(queue({ confirm: row.key }), busy([row])), /Its wrapper is gone, so the command may still be running/);
    assert.equal(update(queue({ confirm: row.key }), "y", busy([row])).effect, "cancel");
    const ended = { ...J5, cancellable: false, state: "done", exit: 0 };
    const stale = inner(queue({ confirm: "j5" }), busy([ended]));
    assert.match(stale, /It has already ended; there is nothing to cancel\./);
    assert.doesNotMatch(stale, /undefined/);
    const yes = update(queue({ confirm: "j5" }), "y", busy([ended]));
    assert.deepEqual([yes.effect, yes.state.confirm, yes.state.message], [undefined, null, "j5 already ended"]);
  });
});

describe("rows from odd records", () => {
  const stamp = new Date(NOW - 60_000).toISOString();
  const wrong = [{ as: 5 }, { cwd: 5 }, { as: {}, cwd: [] }, { resource: 7 }, { state: 5 }, { state: {} }, { created: 5, finished: {} }, { exit: "1", state: "failed", finished: stamp }, { wrapper: "x" }, { wrapper: 5 }, { wrapper: { pid: "9" } }, { command: [1, null, { a: 1 }] }, { id: "a9\x1b[2J" }, { started: [] }];
  it("draws and collects records with the wrong types without a crash", () => {
    const box = sandbox();
    const jobs = join(box.env.BEEFY_SLOT_LOCK_DIR, "jobs");
    mkdirSync(jobs, { recursive: true });
    wrong.forEach((odd, i) => {
      const id = odd.id ?? `b${String(i).padStart(5, "0")}`;
      writeFileSync(join(jobs, `${id}.json`), JSON.stringify({ id, state: "failed", exit: 1, resource: "heavy", command: ["npm", "test"], cwd: "/h/app", created: stamp, finished: stamp, ...odd, id }));
    });
    const { items } = collectQueue({ dir: box.env.BEEFY_SLOT_LOCK_DIR, snap: SNAP, now: NOW });
    assert.equal(items.length, wrong.length);
    for (const row of items) {
      for (const field of ["id", "command", "cwd", "who", "resource"]) assert.equal(typeof row[field], "string", `${row.key}.${field}`);
      assert.ok(Number.isFinite(row.since), `${row.key}.since`);
    }
    for (const state of [queue(), ...items.map((row) => queue({ pick: row.key })), ...items.map((row) => queue({ confirm: row.key }))]) for (const width of [60, 120]) render(state, busy(items, { tail: { key: items[0].key, lines: ["x"] } }), { width });
    for (const state of items.map((row) => queue({ screen: "log", log: { key: row.key, top: null } }))) render(state, busy(items, { logView: { key: state.log.key, lines: ["$ x", ""] } }), { width: 80, rows: 24 });
  });

  it("says a resource other than heavy by name, so its place number is not taken for heavy's", () => {
    const rows = [item("p1", "waiting", { resource: "perf", command: "pnpm bench", place: 1 }), item("p2", "waiting", { command: "lint-all", place: 1 })];
    const screen = inner(queue(), busy(rows));
    assert.match(screen, /▚1 p1\s+\[perf\] pnpm bench/);
    assert.match(screen, /▚1 p2\s+lint-all/);
  });

  it("leaves a finished job's wrapper out, so a new run with its pid is not hidden", () => {
    const old = { id: "ab12cd", state: "done", exit: 0, resource: "heavy", command: ["x"], cwd: "/h", created: new Date(NOW - 60_000).toISOString(), finished: new Date(NOW - 30_000).toISOString(), wrapper: { pid: 411 } };
    const holder = { slot: "heavy", as: "run:411", pid: 411, watch: 411, at: new Date(NOW).toISOString() };
    const { items } = collectQueue({ dir: "/x", snap: SNAP, now: NOW, jobs: [old], holdersOf: () => [holder], lineOf: () => [], info: () => ({ command: "pnpm check", cwd: "" }) });
    assert.deepEqual(items.map((row) => [row.id, row.section]), [["p411", "running"], ["ab12cd", "recent"]]);
  });
});

describe("the process facts cache", () => {
  const fake = (calls, command = "node /x/bin/beefy-slot.mjs pnpm check") => (name) => (calls.push(name), name === "ps" ? { status: command === null ? 1 : 0, stdout: command ?? "" } : { stdout: "n/h/app\n" });
  it("keeps a lookup, a miss too, for a few seconds, then asks again, and a fresh one skips it", () => {
    const calls = [];
    const pid = 90_001;
    assert.equal(processFacts(pid, { now: 1000, run: fake(calls) }).command, "pnpm check");
    const first = calls.length;
    processFacts(pid, { now: 3000, run: fake(calls) });
    assert.equal(calls.length, first, "cached");
    assert.equal(processFacts(pid, { now: 7000, run: fake(calls, "node /x/bin/beefy-slot.mjs npm test") }).command, "npm test", "a reused pid shows its new command");
    const second = calls.length;
    processFacts(pid, { fresh: true, now: 7100, run: fake(calls) });
    assert.ok(calls.length > second, "fresh asks");
    const dead = 90_002;
    const before = calls.length;
    for (const now of [1000, 1500, 2000]) assert.equal(processFacts(dead, { now, run: fake(calls, null) }).command, "");
    assert.equal(calls.length - before, 2, "a dead pid's miss is asked once (ps and lsof), not every tick");
  });

  it("does not ask about a pid that is not a process", () => {
    const calls = [];
    for (const pid of [0, 1, -1, 2.5, "7", undefined]) assert.deepEqual(processFacts(pid, { run: fake(calls) }), COLD);
    assert.deepEqual(calls, []);
  });
});

describe("handing the terminal back", () => {
  const trapped = (extra = {}) => {
    const box = sandbox();
    const t = terminal();
    const proc = new EventEmitter();
    const errors = { data: "", write(chunk) { this.data += chunk; } };
    const closed = runTui({ stdin: t.stdin, stdout: t.stdout, env: box.env, home: box.home, cwd: box.cwd, cores: 8, screen: "queue", proc, stderr: errors, ...extra });
    return { t, proc, errors, closed, box };
  };
  const restored = (data) => {
    for (const code of ["\x1b[?1049l", "\x1b[?1000l", "\x1b[?1006l", "\x1b[?25h"]) assert.ok(data.includes(code), JSON.stringify(code));
  };

  for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]]) {
    it(`restores the screen, mouse and cursor on ${signal} and ends with ${code}`, async () => {
      const { t, proc, closed } = trapped();
      await t.until(/beefy-slot queue/);
      assert.ok(!t.stdout.data.includes("\x1b[?1049l"));
      proc.emit(signal);
      assert.equal(await closed, code);
      restored(t.stdout.data);
      assert.equal(proc.listenerCount(signal), 0, "the handler is taken off");
    });
  }

  it("restores the terminal on an error nobody caught, writes it to stderr, and exits 1", async () => {
    for (const event of ["uncaughtException", "unhandledRejection"]) {
      const { t, proc, errors, closed } = trapped();
      await t.until(/beefy-slot queue/);
      proc.emit(event, new Error("boom"));
      assert.equal(await closed, 1);
      restored(t.stdout.data);
      assert.match(errors.data, /beefy: Error: boom/);
      assert.ok(t.stdout.data.lastIndexOf("\x1b[?1049l") > t.stdout.data.lastIndexOf("\x1b[H"), `${event}: nothing painted after`);
    }
  });

  it("paints nothing after leaving, even when a cancel answers late", async () => {
    const box = sandbox();
    const jobs = join(box.env.BEEFY_SLOT_LOCK_DIR, "jobs");
    mkdirSync(jobs, { recursive: true });
    const stamp = new Date().toISOString();
    writeFileSync(join(jobs, "abc123.json"), JSON.stringify({ id: "abc123", state: "running", resource: "heavy", command: ["sleep", "9"], cwd: "/h", created: stamp, wrapper: { pid: process.pid, start: "" } }));
    const t = terminal();
    const closed = runTui({ stdin: t.stdin, stdout: t.stdout, env: box.env, home: box.home, cwd: box.cwd, cores: 8, screen: "queue", cancel: () => wait(300).then(() => 0) });
    await t.until(/▸ .. abc123/);
    t.stdin.emit("data", "x");
    await t.until(/Cancel abc123/);
    t.stdin.emit("data", "y");
    await t.until(/cancelling abc123/);
    t.stdin.emit("data", "q");
    assert.equal(await closed, 0);
    const length = t.stdout.data.length;
    await wait(600);
    assert.equal(t.stdout.data.length, length, "the late answer wrote nothing");
  });

  it("keeps the screen up and says so when the config check cannot read the lock folder", { skip: process.getuid?.() === 0 }, async () => {
    const box = sandbox();
    mkdirSync(box.env.BEEFY_SLOT_LOCK_DIR, { recursive: true });
    chmodSync(box.env.BEEFY_SLOT_LOCK_DIR, 0o000);
    try {
      const { t, closed } = trapped({ env: box.env, home: box.home, cwd: box.cwd });
      await t.until(/config check failed/);
      t.stdin.emit("data", "q");
      assert.equal(await closed, 0);
      restored(t.stdout.data);
    } finally {
      chmodSync(box.env.BEEFY_SLOT_LOCK_DIR, 0o755);
    }
  });
});
