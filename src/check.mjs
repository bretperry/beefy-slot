// Say where each setting comes from, and what is wrong or surprising about the machine's setup.
// Used by: `beefy-slot config check`, `config show` and the config screen.
// Exports: explain (value and source of each setting), checkConfig (findings and an exit code), plain (text safe to print).
// Writes: checkConfig makes and removes two probe files in an existing lock folder, to test hard links, only when the lockDir is not from the project file.
// Runs: the machine file's judge, never a project's: a repo's code does not run because someone looked at its settings.

import { accessSync, constants, existsSync, linkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { dirname, join } from "node:path";

import { ENV_KNOBS, HEARTBEAT_TTL_MINUTES, resolveSettings, snapshot } from "./beefy-slot.mjs";
import { MACHINE_KEYS, loadConfig, machineConfigPath } from "./config.mjs";
import { loadJudge } from "./judge.mjs";
import { HOST } from "./perf.mjs";

const legacy = (name) => name.replace(/^BEEFY_SLOT_/, "CHUTE_BOSS_");
const FILE = { machine: "machine file", project: "project file" };

// Text as a terminal may safely show it: control characters (ESC, BEL, CR, the C1 range) and bidirectional
// overrides become U+FFFD. Config files, lock records and error text come from outside the screen's own code.
export const plain = (text) => String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "\ufffd");

// One row per setting: { key, value, source, ignored }. `source` is "default", "machine file", "project file"
// or "env <NAME>"; `ignored` lists variables that are set but not valid, as { name, value, expects }.
export const explain = ({ env = process.env, loaded = loadConfig(), cores = availableParallelism(), home = homedir() } = {}) => {
  const settings = resolveSettings({ env, config: loaded.config, cores, home, err: () => {} });
  const rows = ENV_KNOBS.map(({ key, env: name, valid, expects }) => {
    const names = [name, legacy(name)].filter((candidate) => env[candidate] !== undefined);
    const winner = names.find((candidate) => valid(env[candidate]) !== null);
    const ignored = names.filter((candidate) => valid(env[candidate]) === null).map((candidate) => ({ name: candidate, value: env[candidate], expects }));
    return { key, value: settings[key], source: winner ? `env ${winner}` : FILE[loaded.sources[key]] ?? "default", ignored };
  });
  rows.push({ key: "judge", value: loaded.config.judge ?? "", source: FILE[loaded.sources.judge] ?? "default", ignored: [] });
  return { settings, rows };
};

// The nearest folder that exists, at or above `path`.
const nearest = (path) => {
  let folder = path;
  while (!existsSync(folder) && dirname(folder) !== folder) folder = dirname(folder);
  return folder;
};

// Why the lock folder cannot be used, or null. A folder that is not there yet only needs a parent that can be written.
// `probe` false (a folder a project file named) only looks, never writes: a repo's file must not make this create files elsewhere.
const folderProblem = (dir, probe = true) => {
  if (!existsSync(dir)) {
    try {
      accessSync(nearest(dir), constants.W_OK);
      return null;
    } catch {
      return `it does not exist and ${nearest(dir)} cannot be written`;
    }
  }
  if (!statSync(dir).isDirectory()) return "it is a file, not a folder";
  if (!probe) return null;
  const base = join(dir, `.probe.${process.pid}`);
  try {
    writeFileSync(`${base}.tmp`, "");
    linkSync(`${base}.tmp`, `${base}.link`);
    return null;
  } catch (error) {
    return error?.syscall === "link" ? `it cannot make hard links (${error.code}); use a local disk` : `it cannot be written (${error?.code ?? error})`;
  } finally {
    rmSync(`${base}.tmp`, { force: true });
    rmSync(`${base}.link`, { force: true });
  }
};

// Findings as [{ level: "ok" | "warn" | "error", text }], and the exit code: 2 on an error, or on a
// warning with `strict`; else 0. `load` is a seam for the judge loader.
export const checkConfig = async ({ cwd = process.cwd(), home = homedir(), env = process.env, cores = availableParallelism(), strict = false, load = loadJudge } = {}) => {
  const findings = [];
  const add = (level, text) => findings.push({ level, text });
  const loaded = loadConfig({ cwd, home });
  const machinePath = machineConfigPath(home);
  if (loaded.error) add("error", loaded.error);
  if (loaded.machine && !loaded.machineError) add("ok", `machine file ${machinePath} reads clean`);
  else if (!loaded.machine && !loaded.machineError) add("ok", `no machine file at ${machinePath}; defaults apply`);

  if (loaded.project) {
    const keys = MACHINE_KEYS.filter((key) => Object.hasOwn(loaded.project.config, key));
    const lost = keys.filter((key) => loaded.sources[key] === "machine");
    const read = keys.filter((key) => loaded.sources[key] !== "machine");
    if (lost.length) add("warn", `${loaded.project.path} sets ${lost.join(", ")}; the machine file wins. Delete ${lost.length === 1 ? "it" : "them"} there`);
    if (read.length && loaded.machine) add("warn", `${loaded.project.path} still sets ${read.join(", ")} for this machine; move ${read.length === 1 ? "it" : "them"} to the machine file`);
    else if (read.length) add("ok", `${loaded.project.path} sets ${read.join(", ")} (the 0.2 layout); \`beefy-slot config\` moves them to the machine file`);
    if (loaded.sources.judge === "project") add("ok", `judge ${loaded.config.judge} comes from ${loaded.project.path} and was not loaded: loading it runs that repo's code, so only \`run\` does`);
    else if (Object.hasOwn(loaded.project.config, "judge")) add("warn", `${loaded.project.path} names a judge; the machine file's judge wins. Delete it there`);
  }

  const { settings, rows } = explain({ env, loaded, cores, home });
  for (const row of rows) {
    for (const { name, value, expects } of row.ignored) add("warn", `${name}=${value} is ignored: expected ${expects}`);
    if (row.source.startsWith("env ") && loaded.sources[row.key]) add("ok", `${row.source.slice(4)} wins over ${row.key} in the ${FILE[loaded.sources[row.key]]}`);
  }
  if (settings.heartbeatSeconds >= HEARTBEAT_TTL_MINUTES * 60) add("warn", `heartbeat is ${settings.heartbeatSeconds} s, but a record lasts ${HEARTBEAT_TTL_MINUTES} minutes after a renewal; a run would lose its slot between renewals`);
  if (settings.perfHost && !HOST.test(settings.perfHost)) add("error", `perfHost "${settings.perfHost}" is not a host name ssh would take`);

  const fromProject = rows.find((row) => row.key === "lockDir")?.source === FILE.project;
  const problem = folderProblem(settings.lockDir, !fromProject);
  if (problem) add("error", `lock folder ${settings.lockDir}: ${problem}`);
  else add("ok", `lock folder ${settings.lockDir}${existsSync(settings.lockDir) ? (fromProject ? ": not probed (project file)" : ": hard links, read and write") : " is not there yet; the first take makes it"}`);
  const old = join(home, ".chute-boss", "locks");
  if (settings.lockDir === old) add("warn", `still using the pre-rename ${old}; rename it to ${join(home, ".beefy-slot", "locks")} when nothing is held`);
  else if (existsSync(old)) {
    const live = snapshot({ dir: old, settings, load: 0 }).resources.reduce((sum, resource) => sum + resource.holders.length, 0);
    if (live) add("warn", `${old} holds ${live} live record${live === 1 ? "" : "s"} that this folder does not see; something is still using the old folder`);
  }

  if (loaded.judge && !loaded.error && loaded.sources.judge === "machine") {
    const guard = await load(loaded.judge.spec, loaded.judge.baseDir);
    try {
      guard("true", { argv: ["true"], cwd });
      add("ok", `judge ${loaded.config.judge} loads and answers`);
    } catch (error) {
      add("error", `judge ${loaded.config.judge} does not work (${error instanceof Error ? error.message : String(error)}); every \`run\` is refused until it does`);
    }
  }

  const errors = findings.filter((finding) => finding.level === "error").length;
  const warnings = findings.filter((finding) => finding.level === "warn").length;
  return { findings, errors, warnings, code: errors || (strict && warnings) ? 2 : 0, loaded, settings, rows };
};
