// The machine's config file: its keys, how it merges over a project file, config check, show and presets.
import "./tmpdir.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { inspectMachineFile } from "../src/config.mjs";
import { checkConfig, explain, loadConfig, machineConfigPath, preset, readMachineConfig, resolveSettings, validate, writeMachineConfig } from "../src/index.mjs";

const CLI = fileURLToPath(new URL("../bin/beefy-slot.mjs", import.meta.url));

// A home folder and a project folder of their own; no BEEFY_SLOT_ or CHUTE_BOSS_ variable is set.
const machine = (config, project) => {
  const home = mkdtempSync(join(tmpdir(), "machine-"));
  const cwd = join(home, "project");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  if (config !== undefined) {
    mkdirSync(dirname(machineConfigPath(home)), { recursive: true });
    writeFileSync(machineConfigPath(home), typeof config === "string" ? config : JSON.stringify(config));
  }
  if (project !== undefined) writeFileSync(join(cwd, "beefy-slot.json"), JSON.stringify(project));
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("BEEFY_SLOT_") && !name.startsWith("CHUTE_BOSS_")));
  const run = (args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...clean, HOME: home, ...extra }, encoding: "utf8" });
  return { home, cwd, run };
};

describe("machine config file", () => {
  it("validates the three new keys and their ends", () => {
    assert.equal(validate({ loadMax: 12, pollSeconds: 5, heartbeatSeconds: 60 }), null);
    for (const [key, value] of [["loadMax", 0], ["loadMax", "8"], ["pollSeconds", 0], ["pollSeconds", 601], ["heartbeatSeconds", 61], ["heartbeatSeconds", -1]]) assert.match(validate({ [key]: value }), new RegExp(key));
  });

  it("takes a judge by full path only in the machine file", () => {
    assert.match(validate({ judge: "/opt/judge.mjs" }), /inside the config folder/);
    assert.equal(validate({ judge: "/opt/judge.mjs" }, { machine: true }), null);
    assert.equal(validate({ judge: "~/judges/judge.mjs" }, { machine: true }), null);
    assert.equal(validate({ judge: "some-judge" }, { machine: true }), null);
    assert.match(validate({ judge: "~/../judge.mjs" }, { machine: true }), /judge/);
  });

  it("reaches the settings from the file, under the environment", () => {
    const home = mkdtempSync(join(tmpdir(), "settings-"));
    const config = { loadMax: 12, pollSeconds: 5, heartbeatSeconds: 10 };
    const settings = resolveSettings({ env: {}, config, home });
    assert.deepEqual([settings.loadMax, settings.pollSeconds, settings.heartbeatSeconds], [12, 5, 10]);
    assert.equal(resolveSettings({ env: { BEEFY_SLOT_LOAD_MAX: "4" }, config, home }).loadMax, 4);
  });

  it("lays the machine file over the project file, key by key", () => {
    const { home, cwd } = machine({ heavySlots: 2, judge: "~/judge.mjs" }, { heavySlots: 4, perfLoadMax: 2, judge: "scripts/judge.mjs" });
    const loaded = loadConfig({ cwd, home });
    assert.equal(loaded.error, null);
    assert.deepEqual(loaded.config, { heavySlots: 2, perfLoadMax: 2, judge: "~/judge.mjs" });
    assert.deepEqual(loaded.sources, { heavySlots: "machine", perfLoadMax: "project", judge: "machine" });
    assert.deepEqual(loaded.judge, { spec: join(home, "judge.mjs"), baseDir: join(home, ".beefy-slot") });
  });

  it("keeps a project's judge when the machine file names none", () => {
    const { home, cwd } = machine({ heavySlots: 2 }, { judge: "scripts/judge.mjs" });
    assert.deepEqual(loadConfig({ cwd, home }).judge, { spec: "scripts/judge.mjs", baseDir: cwd });
    assert.equal(loadConfig({ cwd: home, home: join(home, "nobody") }).judge, null);
  });

  it("writes a file it reads back, and refuses one it would not", () => {
    const { home } = machine();
    assert.equal(readMachineConfig(home), null);
    const path = writeMachineConfig({ heavySlots: 3, resources: { ci: { slots: 4, loadGate: false } } }, home);
    assert.equal(path, machineConfigPath(home));
    assert.deepEqual(readMachineConfig(home).config, { heavySlots: 3, resources: { ci: { slots: 4, loadGate: false } } });
    assert.match(readFileSync(path, "utf8"), /\n$/);
    assert.throws(() => writeMachineConfig({ heavySlots: 99 }, home), /not saved: heavySlots/);
    assert.equal(readMachineConfig(home).config.heavySlots, 3, "a refused write leaves the file as it was");
  });

  it("sizes the heavy pool for every project on the machine", () => {
    const { run } = machine({ heavySlots: 2 }, { heavySlots: 1 });
    const env = { BEEFY_SLOT_LOAD_MAX: "1000000" };
    assert.equal(run(["take", "heavy", "--as", "a"], env).status, 0);
    assert.equal(run(["take", "heavy", "--as", "b"], env).status, 0, "the machine file's 2 wins over the project's 1");
    assert.equal(run(["take", "heavy", "--as", "c"], env).status, 75);
    const other = machine({ heavySlots: 2 });
    assert.equal(other.run(["take", "heavy", "--as", "a"], { ...env, BEEFY_SLOT_HEAVY_SLOTS: "1" }).status, 0);
    assert.equal(other.run(["take", "heavy", "--as", "b"], { ...env, BEEFY_SLOT_HEAVY_SLOTS: "1" }).status, 75, "the environment wins over the file");
  });

  it("refuses take on a malformed machine file and names it; status still runs", () => {
    const { run, home } = machine('{"heavySlot":2}');
    const take = run(["take", "heavy", "--as", "a"]);
    assert.equal(take.status, 2);
    assert.match(take.stderr, /config\.json: heavySlot: unknown key/);
    assert.equal(existsSync(join(home, ".beefy-slot", "locks")), false);
    const status = run(["status"]);
    assert.equal(status.status, 0);
    assert.match(status.stderr, /heavySlot/);
  });
});

describe("config check", () => {
  it("is clean on a machine with no files", async () => {
    const { home, cwd } = machine();
    const result = await checkConfig({ home, cwd, env: {} });
    assert.deepEqual([result.errors, result.warnings, result.code], [0, 0, 0]);
    assert.ok(result.findings.some((finding) => /no machine file/.test(finding.text)));
    assert.equal(existsSync(join(home, ".beefy-slot")), false, "check makes no folder");
  });

  it("does not probe a lock folder a project file names, and still probes the machine file's", async (t) => {
    if (process.getuid?.() === 0) return t.skip("root can write a read-only folder");
    const locks = mkdtempSync(join(tmpdir(), "locks-"));
    chmodSync(locks, 0o555);
    t.after(() => {
      chmodSync(locks, 0o755);
      rmSync(locks, { recursive: true, force: true });
    });
    const fromProject = machine(undefined, { lockDir: locks });
    const result = await checkConfig({ home: fromProject.home, cwd: fromProject.cwd, env: {} });
    assert.equal(result.errors, 0, "nothing was written there, so nothing failed");
    assert.ok(result.findings.some((finding) => /not probed \(project file\)/.test(finding.text)));
    assert.deepEqual(readdirSync(locks), []);
    const fromMachine = machine({ lockDir: locks });
    const own = await checkConfig({ home: fromMachine.home, cwd: fromMachine.cwd, env: {} });
    assert.ok(own.findings.some((finding) => finding.level === "error" && /cannot be written/.test(finding.text)), "the machine file's folder is still probed");
  });

  it("names a variable whose value is ignored, and fails only under --strict", async () => {
    const { home, cwd, run } = machine({ heavySlots: 2 });
    const env = { BEEFY_SLOT_HEAVY_SLOTS: "0", CHUTE_BOSS_LOAD_MAX: "lots" };
    const result = await checkConfig({ home, cwd, env });
    assert.equal(result.code, 0);
    assert.equal(result.warnings, 2);
    assert.ok(result.findings.some((finding) => finding.level === "warn" && /BEEFY_SLOT_HEAVY_SLOTS=0 is ignored/.test(finding.text)));
    assert.ok(result.findings.some((finding) => /CHUTE_BOSS_LOAD_MAX=lots is ignored/.test(finding.text)));
    assert.equal((await checkConfig({ home, cwd, env, strict: true })).code, 2);
    const cli = run(["config", "check"], { BEEFY_SLOT_HEAVY_SLOTS: "0" });
    assert.equal(cli.status, 0);
    assert.match(cli.stdout, /^warn  BEEFY_SLOT_HEAVY_SLOTS=0/m);
    assert.match(cli.stdout, /0 errors, 1 warning$/m);
    assert.equal(run(["config", "check", "--strict"], { BEEFY_SLOT_HEAVY_SLOTS: "0" }).status, 2);
  });

  it("says where each value comes from", () => {
    const { home, cwd } = machine({ heavySlots: 2 }, { perfLoadMax: 2 });
    const { rows } = explain({ env: { BEEFY_SLOT_LOCK_POLL_SECONDS: "3" }, loaded: loadConfig({ cwd, home }), home, cores: 8 });
    const source = Object.fromEntries(rows.map((row) => [row.key, row.source]));
    assert.equal(source.heavySlots, "machine file");
    assert.equal(source.perfLoadMax, "project file");
    assert.equal(source.pollSeconds, "env BEEFY_SLOT_LOCK_POLL_SECONDS");
    assert.equal(source.loadMax, "default");
    assert.equal(rows.find((row) => row.key === "loadMax").value, 8);
  });

  it("flags a project file's machine keys once a machine file exists", async () => {
    const quiet = machine(undefined, { heavySlots: 2 });
    assert.equal((await checkConfig({ home: quiet.home, cwd: quiet.cwd, env: {} })).warnings, 0, "the 0.2 layout alone is not a warning");
    const { home, cwd } = machine({ heavySlots: 2 }, { heavySlots: 4, perfLoadMax: 2, judge: "j.mjs" });
    const texts = (await checkConfig({ home, cwd, env: {}, load: async () => () => null })).findings.filter((finding) => finding.level === "warn").map((finding) => finding.text);
    assert.ok(texts.some((text) => /sets heavySlots; the machine file wins/.test(text)), texts.join("\n"));
    assert.ok(texts.some((text) => /still sets perfLoadMax/.test(text)), texts.join("\n"));
  });

  it("reports a bad file, a lock folder that is a file, and a judge that does not load as errors", async () => {
    const bad = machine("{");
    const first = await checkConfig({ home: bad.home, cwd: bad.cwd, env: {} });
    assert.equal(first.code, 2);
    assert.match(first.findings[0].text, /config\.json/);
    const { home, cwd } = machine({ lockDir: "~/locks", judge: "~/missing-judge.mjs" });
    writeFileSync(join(home, "locks"), "");
    const second = await checkConfig({ home, cwd, env: {} });
    const errors = second.findings.filter((finding) => finding.level === "error").map((finding) => finding.text);
    assert.ok(errors.some((text) => /lock folder .*locks: it is a file/.test(text)), errors.join("\n"));
    assert.ok(errors.some((text) => /judge ~\/missing-judge\.mjs does not work/.test(text)), errors.join("\n"));
  });

  it("tests an existing lock folder for hard links and leaves nothing behind", async () => {
    const { home, cwd, run } = machine();
    assert.equal(run(["take", "heavy", "--as", "a"], { BEEFY_SLOT_LOAD_MAX: "1000000" }).status, 0);
    const result = await checkConfig({ home, cwd, env: {} });
    assert.ok(result.findings.some((finding) => finding.level === "ok" && /hard links, read and write/.test(finding.text)));
    assert.deepEqual(spawnSync("ls", ["-A", join(home, ".beefy-slot", "locks")], { encoding: "utf8" }).stdout.trim().split("\n"), ["heavy.json"]);
  });

  it("warns when the old lock folder still holds a live record", async () => {
    const { home, cwd } = machine();
    const old = join(home, ".chute-boss", "locks");
    mkdirSync(old, { recursive: true });
    mkdirSync(join(home, ".beefy-slot", "locks"), { recursive: true });
    writeFileSync(join(old, "heavy.json"), JSON.stringify({ resource: "heavy", as: "old-job", id: "1", until: new Date(Date.now() + 60_000).toISOString() }));
    const result = await checkConfig({ home, cwd, env: {} });
    assert.ok(result.findings.some((finding) => finding.level === "warn" && /holds 1 live record/.test(finding.text)));
  });
});

describe("config show and preset", () => {
  it("prints each value with its source, and the same without a terminal", () => {
    const { run } = machine({ heavySlots: 2, resources: { ci: { slots: 4, loadGate: false } } });
    const show = run(["config", "show"]);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /^heavySlots\s+2\s+machine file$/m);
    assert.match(show.stdout, /^resources\.ci\s+4 slots, load limit off\s+machine file$/m);
    const bare = run(["config"]);
    assert.equal(bare.status, 0);
    assert.match(bare.stdout, /opens the config screen on a terminal/);
    assert.equal(run(["config", "nonsense"]).status, 2);
  });

  it("sizes a preset from the cores and keeps what it does not speak to", () => {
    const base = { lockDir: "~/x", resources: { sim: { slots: 1 } }, loadMax: 9 };
    assert.deepEqual(preset("ci-box", base, 16), { lockDir: "~/x", heavySlots: 4, resources: { sim: { slots: 1 }, ci: { slots: 8, loadGate: false } } });
    assert.deepEqual(preset("laptop", base, 16), { lockDir: "~/x", resources: { sim: { slots: 1 } }, heavySlots: 1 });
    assert.deepEqual(preset("perf-rig", {}, 2), { heavySlots: 1, loadMax: 3, perfLoadMax: 1 });
    assert.equal(preset("nope", {}, 8), null);
    for (const name of ["laptop", "ci-box", "perf-rig"]) for (const cores of [1, 8, 128]) assert.equal(validate(preset(name, {}, cores), { machine: true }), null, `${name} on ${cores} cores`);
  });

  it("prints a preset, and writes it only with --write", () => {
    const { run, home } = machine();
    const dry = run(["config", "preset", "laptop"]);
    assert.equal(dry.status, 0);
    assert.match(dry.stdout, /"heavySlots": 1/);
    assert.equal(existsSync(machineConfigPath(home)), false);
    assert.equal(run(["config", "preset", "laptop", "--write"]).status, 0);
    assert.deepEqual(readMachineConfig(home).config, { heavySlots: 1 });
    assert.equal(run(["config", "preset", "desktop"]).status, 2);
  });
});

describe("what a repo's files and a bad machine file cannot do", () => {
  const judgeRepo = () => {
    const where = machine(undefined, { judge: "./j.mjs" });
    const marker = join(where.home, "judge-ran");
    writeFileSync(join(where.cwd, "j.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nexport const judge = () => null;\n`);
    return { ...where, marker };
  };

  it("does not load a project's judge for config check or config show, and says so", async () => {
    const { home, cwd, run, marker } = judgeRepo();
    const result = await checkConfig({ home, cwd, env: {} });
    assert.equal(existsSync(marker), false);
    assert.ok(result.findings.some((finding) => /judge \.\/j\.mjs comes from .* was not loaded/.test(finding.text)), result.findings.map((finding) => finding.text).join("\n"));
    assert.equal(run(["config", "check"]).status, 0);
    assert.equal(run(["config", "show"]).status, 0);
    assert.equal(existsSync(marker), false, "neither verb ran the repo's code");
  });

  it("still loads the machine file's own judge", async () => {
    const { home, cwd } = machine({ judge: "~/mine.mjs" });
    writeFileSync(join(home, "mine.mjs"), "export const judge = () => null;\n");
    const result = await checkConfig({ home, cwd, env: {} });
    assert.ok(result.findings.some((finding) => finding.level === "ok" && /judge ~\/mine\.mjs loads and answers/.test(finding.text)));
  });

  it("prints only the parse error for a machine file that is not JSON", async () => {
    const { home, cwd, run } = machine("{");
    const texts = (await checkConfig({ home, cwd, env: {} })).findings.map((finding) => finding.text);
    assert.equal(texts.some((text) => /no machine file/.test(text)), false, texts.join("\n"));
    assert.equal(run(["config", "check"]).status, 2);
    assert.doesNotMatch(run(["config", "check"]).stdout, /no machine file/);
  });

  it("neutralizes control characters from files in config check and config show", () => {
    const evil = "\u001b]0;pwned\u0007\u001b[2J";
    const { run } = machine(undefined, { [evil]: 1, perfHost: evil, judge: evil });
    const check = run(["config", "check"]);
    const show = run(["config", "show"]);
    for (const output of [check.stdout, show.stdout, check.stderr]) assert.doesNotMatch(output, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    assert.match(check.stdout, /pwned/, "the text is still there");
  });

  it("refuses a lockDir that is not absolute", async () => {
    assert.match(validate({ lockDir: "locks" }), /lockDir: expected an absolute path or one starting with ~\//);
    assert.match(validate({ lockDir: "./locks" }, { machine: true }), /lockDir/);
    assert.equal(validate({ lockDir: "/var/locks" }), null);
    assert.equal(validate({ lockDir: "~/locks" }, { machine: true }), null);
    const { run, cwd } = machine({ lockDir: "locks" });
    const check = run(["config", "check"]);
    assert.equal(check.status, 2);
    assert.match(check.stdout, /lockDir: expected an absolute path/);
    assert.equal(run(["take", "heavy", "--as", "a"]).status, 2);
    assert.equal(existsSync(join(cwd, "locks")), false);
  });

  it("keeps a key it does not know when asked, and reads a file as ok, unknown or bad", () => {
    assert.match(validate({ future: 1 }, { machine: true }), /unknown key/);
    assert.equal(validate({ future: 1, heavySlots: 2 }, { machine: true, keepUnknown: true }), null);
    assert.match(validate({ future: 1, heavySlots: 99 }, { machine: true, keepUnknown: true }), /heavySlots/);
    const states = (config) => inspectMachineFile(machine(config).home).state;
    assert.deepEqual([undefined, { heavySlots: 2 }, { future: 1, heavySlots: 2 }, { resources: { a: null } }, "{"].map(states), ["none", "ok", "unknown", "bad", "bad"]);
  });

  it("refuses a write over a file that changed since it was read", () => {
    const { home } = machine({ heavySlots: 2 });
    const seen = inspectMachineFile(home).hash;
    writeMachineConfig({ heavySlots: 3 }, home, { expect: seen });
    assert.throws(() => writeMachineConfig({ heavySlots: 4 }, home, { expect: seen }), /changed since it was read/);
    assert.equal(readMachineConfig(home).config.heavySlots, 3);
    assert.throws(() => writeMachineConfig({ heavySlots: 4 }, home, { expect: null }), /changed since it was read/, "a file appeared where there was none");
    const none = machine();
    writeMachineConfig({ heavySlots: 1 }, none.home, { expect: null });
    assert.equal(readMachineConfig(none.home).config.heavySlots, 1);
    assert.equal(readdirSync(dirname(machineConfigPath(home))).some((name) => name.endsWith(".tmp")), false);
  });

  it("writes through a symlinked config file and leaves the link", () => {
    const { home } = machine();
    const dotfiles = join(home, "dotfiles");
    mkdirSync(dotfiles);
    writeFileSync(join(dotfiles, "config.json"), '{"heavySlots":2}');
    mkdirSync(dirname(machineConfigPath(home)), { recursive: true });
    symlinkSync(join(dotfiles, "config.json"), machineConfigPath(home));
    writeMachineConfig({ heavySlots: 5 }, home);
    assert.equal(lstatSync(machineConfigPath(home)).isSymbolicLink(), true);
    assert.deepEqual(JSON.parse(readFileSync(join(dotfiles, "config.json"), "utf8")), { heavySlots: 5 });
    assert.deepEqual(readdirSync(dotfiles), ["config.json"]);
  });

  it("reports a write that fails plainly and leaves no temporary file", () => {
    const { home } = machine();
    mkdirSync(machineConfigPath(home), { recursive: true });
    assert.throws(() => writeMachineConfig({ heavySlots: 2 }, home), /^Error: not saved: /);
    assert.deepEqual(readdirSync(dirname(machineConfigPath(home))), ["config.json"]);
  });

  it("exits 2 with one plain line when config preset --write cannot write", { skip: process.getuid?.() === 0 }, () => {
    const { home, run } = machine({ heavySlots: 2 });
    const folder = dirname(machineConfigPath(home));
    chmodSync(folder, 0o500);
    try {
      const result = run(["config", "preset", "laptop", "--write"]);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /^not saved: /m);
      assert.doesNotMatch(result.stderr, /\n\s+at /);
    } finally {
      chmodSync(folder, 0o700);
    }
    assert.deepEqual(readdirSync(folder), ["config.json"]);
  });
});
