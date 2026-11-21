// The config screen's terminal loop, on fake streams: save, leave, clicks, a file it must not harm, signals and crashes.
import "./tmpdir.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { machineConfigPath } from "../src/config.mjs";
import { createState, render, runTui } from "../src/tui.mjs";

const RESTORE = "\x1b[?1006l\x1b[?1000l\x1b[0m\x1b[?25h\x1b[?1049l";
const TUI = fileURLToPath(new URL("../src/tui.mjs", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, ms = 4000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (check()) return true;
  return check();
};

// A home folder and a project folder (a repository, so the walk up stops there).
const place = ({ machine, project } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "loop-"));
  const cwd = join(home, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  if (machine !== undefined) {
    mkdirSync(join(home, ".beefy-slot"), { recursive: true });
    writeFileSync(machineConfigPath(home), typeof machine === "string" ? machine : JSON.stringify(machine));
  }
  if (project !== undefined) writeFileSync(join(cwd, "beefy-slot.json"), typeof project === "string" ? project : JSON.stringify(project));
  return { home, cwd };
};

// The screen on fake streams. `key` types; `shown` is everything drawn so far. Always `end()` it: a screen left open keeps the test alive.
const open = ({ home, cwd }, env = {}) => {
  const stdin = Object.assign(new EventEmitter(), { raw: null, setEncoding() {}, setRawMode(on) { this.raw = on; }, resume() {}, pause() {} });
  const stdout = Object.assign(new EventEmitter(), { columns: 100, rows: 30, shown: "", write(chunk) { this.shown += chunk; return true; } });
  const done = runTui({ stdin, stdout, env: { BEEFY_SLOT_NO_COW: "1", BEEFY_SLOT_STILL: "1", NO_COLOR: "1", ...env }, home, cwd, cores: 8 });
  return { stdin, stdout, done, key: (keys) => stdin.emit("data", keys), end: () => stdin.emit("data", "\x03") };
};

describe("the screen's terminal loop", () => {
  it("saves with S, leaves with q, and puts the terminal back", async () => {
    const where = place({ machine: { heavySlots: 1 } });
    const screen = open(where);
    try {
      assert.ok(screen.stdout.shown.startsWith("\x1b[?1049h"), "the other screen, on");
      assert.equal(screen.stdin.raw, true);
      screen.key("d");
      screen.key("S");
      assert.match(screen.stdout.shown, /saved ~\/\.beefy-slot\/config\.json/);
      assert.deepEqual(JSON.parse(readFileSync(machineConfigPath(where.home), "utf8")), { heavySlots: 2 });
      screen.key("q");
      assert.equal(await screen.done, 0);
      assert.equal(screen.stdin.raw, false);
      assert.ok(screen.stdout.shown.endsWith(RESTORE), "mouse, colour, cursor and the other screen, all off");
      const length = screen.stdout.shown.length;
      await sleep(150);
      assert.equal(screen.stdout.shown.length, length, "nothing paints after it left");
    } finally {
      screen.end();
    }
  });

  it("follows a click on a section", async () => {
    const where = place({ machine: { heavySlots: 1 } });
    const screen = open(where);
    try {
      const drawn = render(createState({ heavySlots: 1 }), { env: {}, home: where.home, cwd: where.cwd, cores: 8, project: null, machinePath: machineConfigPath(where.home), history: [], busiest: "", findings: [], rows: [], probe: null, now: 0, snap: { load: 0, resources: [] } }, { width: 100, rows: 30 });
      const y = drawn.findIndex((line) => line.includes("3 Perf host"));
      assert.ok(y > 0);
      const before = screen.stdout.shown.length;
      screen.key(`\x1b[<0;${drawn[y].indexOf("3 Perf host") + 2};${y + 1}M`);
      assert.match(screen.stdout.shown.slice(before), /perfLoadMax/);
      screen.key("q");
      assert.equal(await screen.done, 0);
    } finally {
      screen.end();
    }
  });

  it("opens on a file with a null resource, from the machine or the project, and says so", async () => {
    for (const where of [place({ machine: { resources: { a: null } } }), place({ project: { resources: { a: null } } })]) {
      const screen = open(where);
      try {
        screen.key("5");
        assert.ok(await until(() => /resources\.a: expected an object/.test(screen.stdout.shown)), "the error is on the screen");
        screen.key("q");
        assert.equal(await screen.done, 0);
        assert.ok(screen.stdout.shown.endsWith(RESTORE));
      } finally {
        screen.end();
      }
    }
  });

  it("does not run a project's judge by opening the screen", async () => {
    const marker = join(tmpdir(), `judge-ran-${process.pid}`);
    const where = place({ project: { judge: "./j.mjs" } });
    writeFileSync(join(where.cwd, "j.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nexport const judge = () => null;\n`);
    const screen = open(where);
    try {
      screen.key("5");
      assert.ok(await until(() => /was not loaded/.test(screen.stdout.shown)), "the ledger says it was not loaded");
      screen.key("q");
      await screen.done;
      assert.equal(existsSync(marker), false);
    } finally {
      screen.end();
    }
  });

  // A judge that leaves a marker file when loaded and, once loaded, denies with a reason the screen shows.
  const judged = (name, project) => {
    const marker = join(tmpdir(), `judge-${name}-${process.pid}`);
    const where = place(project ? { project: { judge: "./j.mjs" } } : {});
    const path = join(where.cwd, "j.mjs");
    writeFileSync(path, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nexport const judge = () => ({ decision: "deny", reason: "the judge ran" });\n`);
    return { where, marker, path };
  };
  // Opens the screen, runs `steps` (keys, one string each), then tries `npm test` on the inspector and waits for a verdict.
  const tried = async (made, steps, expectRan = false) => {
    const screen = open(made.where);
    try {
      for (const step of steps) screen.key(step === "<path>" ? made.path : step);
      const before = screen.stdout.shown.length;
      for (const step of ["4", "/", "npm test", "\r"]) screen.key(step);
      assert.ok(await until(() => /judge not run|the judge ran|no judge is set/.test(screen.stdout.shown.slice(before))), "the inspector answers");
      await sleep(100);
      const shown = screen.stdout.shown.slice(before);
      screen.key("q");
      screen.key("q");
      await screen.done;
      return shown;
    } finally {
      screen.end();
    }
  };

  it("does not run a project's judge from the inspector either", async () => {
    const made = judged("inspect", true);
    assert.match(await tried(made, []), /project judge not run/);
    assert.equal(existsSync(made.marker), false, "the project's code never ran");
  });

  it("does not run a project's judge that enter prefills and enter accepts", async () => {
    const made = judged("prefill", true);
    assert.match(await tried(made, ["4", "\r", "\r"]), /judge not run/);
    assert.equal(existsSync(made.marker), false, "the prefilled judge never ran");
  });

  it("does not run a project's judge after backspace and retyping its last character", async () => {
    const made = judged("retype", true);
    assert.match(await tried(made, ["4", "\r", "backspace", "s", "\r"].map((k) => (k === "backspace" ? "\x7f" : k))), /judge not run/);
    assert.equal(existsSync(made.marker), false, "the retyped judge never ran");
  });

  it("does not run a judge copied in with m from the project file, until it is saved", async () => {
    const made = judged("copied", true);
    assert.match(await tried(made, ["5", "m"]), /judge not run/);
    assert.equal(existsSync(made.marker), false, "the copied judge never ran without a save");
  });

  it("does not run a typed judge that is not saved", async () => {
    const made = judged("typed", true);
    assert.match(await tried(made, ["4", "\r", "<path>", "\r"]), /judge not run/);
    assert.equal(existsSync(made.marker), false, "the typed judge never ran without a save");
  });

  it("runs a judge once the user has saved it to the machine file", async () => {
    const made = judged("saved", false);
    assert.match(await tried(made, ["4", "\r", "<path>", "\r", "S"]), /the judge ran/);
    assert.equal(JSON.parse(readFileSync(machineConfigPath(made.where.home), "utf8")).judge, made.path);
  });

  it("stops running a judge after u undoes it, or x clears it", async () => {
    for (const steps of [["4", "\r", "<path>", "\r", "u"], ["4", "\r", "<path>", "\r", "S", "x"]]) {
      const made = judged("undone", true);
      const shown = await tried(made, steps);
      assert.match(shown, /project judge not run/);
      assert.doesNotMatch(shown, /the judge ran/);
      if (steps.length === 5) assert.equal(existsSync(made.marker), false, "an undone judge never ran");
    }
  });

  it("keeps saving after a save, and refuses once the file changes after it", async () => {
    const where = place({ machine: { heavySlots: 1 } });
    const screen = open(where);
    try {
      screen.key("d");
      screen.key("S");
      assert.deepEqual(JSON.parse(readFileSync(machineConfigPath(where.home), "utf8")), { heavySlots: 2 });
      screen.key("d");
      screen.key("S");
      assert.deepEqual(JSON.parse(readFileSync(machineConfigPath(where.home), "utf8")), { heavySlots: 3 }, "the second save needs no reopen");
      writeFileSync(machineConfigPath(where.home), '{"heavySlots": 9}\n');
      screen.key("d");
      screen.key("S");
      assert.match(screen.stdout.shown.slice(-3000), /changed since it was read/);
      assert.equal(readFileSync(machineConfigPath(where.home), "utf8"), '{"heavySlots": 9}\n');
      screen.key("q");
      screen.key("q");
      await screen.done;
    } finally {
      screen.end();
    }
  });

  it("will not overwrite a machine file it cannot read, and keeps saying so", async () => {
    const text = '{"heavySlots": 5, "loadMax": 12,\n // by hand\n';
    const where = place({ machine: text });
    const screen = open(where);
    try {
      screen.key("d");
      screen.key("d");
      assert.match(screen.stdout.shown.slice(-3000), /⚠ save is off · config\.json: /, "the error stays on the screen after keys");
      screen.key("S");
      assert.match(screen.stdout.shown.slice(-3000), /not saved: the screen does not write over a file it cannot read/);
      assert.equal(readFileSync(machineConfigPath(where.home), "utf8"), text);
      screen.key("q");
      screen.key("q");
      await screen.done;
    } finally {
      screen.end();
    }
  });

  it("edits a file with a key it does not know, keeps the key, and lets the ledger remove it", async () => {
    const where = place({ machine: { future: { a: 1 }, heavySlots: 2 } });
    const screen = open(where);
    const saved = () => JSON.parse(readFileSync(machineConfigPath(where.home), "utf8"));
    try {
      assert.match(screen.stdout.shown, /future: unknown key \(kept as it is/);
      screen.key("d");
      screen.key("S");
      assert.deepEqual(saved(), { future: { a: 1 }, heavySlots: 3 });
      screen.key("5");
      screen.key("j");
      assert.match(screen.stdout.shown.slice(-4000), /future\s+\{"a":1\}\s+unknown key · x removes it/);
      screen.key("x");
      screen.key("S");
      assert.deepEqual(saved(), { heavySlots: 3 });
      screen.key("q");
      assert.equal(await screen.done, 0);
    } finally {
      screen.end();
    }
  });

  it("refuses a save over a file that changed since it was read", async () => {
    const where = place({ machine: { heavySlots: 2 } });
    const screen = open(where);
    try {
      writeFileSync(machineConfigPath(where.home), '{"heavySlots":2,"perfHost":"mini","pollSeconds":5}\n');
      screen.key("d");
      screen.key("S");
      assert.match(screen.stdout.shown.slice(-3000), /the machine file changed since it was read/);
      assert.deepEqual(JSON.parse(readFileSync(machineConfigPath(where.home), "utf8")), { heavySlots: 2, perfHost: "mini", pollSeconds: 5 });
      screen.key("q");
      screen.key("q");
      await screen.done;
    } finally {
      screen.end();
    }
  });

  it("kills the ssh probe when the screen closes", async () => {
    const where = place({ machine: { perfHost: "mini" } });
    const bin = join(where.home, "bin");
    mkdirSync(bin);
    const pidFile = join(where.home, "ssh.pid");
    writeFileSync(join(bin, "ssh"), `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 30\n`);
    chmodSync(join(bin, "ssh"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    const screen = open(where);
    let pid;
    try {
      screen.key("3");
      screen.key("p");
      assert.ok(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== ""), "the probe started");
      pid = Number(readFileSync(pidFile, "utf8"));
      screen.key("q");
      assert.equal(await screen.done, 0);
      const gone = await until(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, 2000);
      assert.ok(gone, "the probe process is gone");
    } finally {
      process.env.PATH = path;
      screen.end();
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });
});

// A screen in a child process, so a signal or a crash can end it for real. The child prints what it drew.
const child = (action) => new Promise((resolve) => {
  const home = place({ machine: { heavySlots: 1 } }).home;
  const code = `
    import { EventEmitter } from "node:events";
    import { runTui } from ${JSON.stringify(TUI)};
    const stdin = Object.assign(new EventEmitter(), { setEncoding() {}, setRawMode() {}, resume() {}, pause() {} });
    const stdout = Object.assign(new EventEmitter(), { columns: 100, rows: 30, write: (text) => process.stdout.write(Buffer.from(text).toString("base64") + "\\n") });
    setTimeout(() => { ${action} }, 400);
    process.exitCode = await runTui({ stdin, stdout, env: { BEEFY_SLOT_NO_COW: "1", BEEFY_SLOT_STILL: "1" }, home: ${JSON.stringify(home)}, cwd: ${JSON.stringify(home)}, cores: 8 });
  `;
  const proc = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  proc.stdout.on("data", (chunk) => (out += chunk));
  proc.stderr.on("data", (chunk) => (err += chunk));
  const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
  proc.on("close", (status, signal) => {
    clearTimeout(timer);
    resolve({ status, signal, err, drawn: out.split("\n").filter(Boolean).map((line) => Buffer.from(line, "base64").toString()).join("") });
  });
});

describe("the screen when it is ended from outside", () => {
  for (const [name, number] of [["SIGTERM", 15], ["SIGINT", 2], ["SIGHUP", 1], ["SIGQUIT", 3]]) {
    it(`puts the terminal back on ${name} and exits ${128 + number}`, async () => {
      const result = await child(`process.kill(process.pid, "${name}");`);
      assert.deepEqual([result.status, result.signal], [128 + number, null], result.err);
      assert.ok(result.drawn.endsWith(RESTORE), "restored");
    });
  }

  it("puts the terminal back on an uncaught error and exits 1 with the error", async () => {
    const result = await child(`throw new Error("boom in a timer");`);
    assert.equal(result.status, 1);
    assert.ok(result.drawn.endsWith(RESTORE));
    assert.match(result.err, /beefy: Error: boom in a timer/);
  });

  it("puts the terminal back on an unhandled rejection", async () => {
    const result = await child(`Promise.reject(new Error("nobody caught this"));`);
    assert.equal(result.status, 1);
    assert.ok(result.drawn.endsWith(RESTORE));
    assert.match(result.err, /nobody caught this/);
  });
});
