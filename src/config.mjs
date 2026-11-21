// Discover JSON settings without executing code, and reject misspelled or malformed file settings.
// Two files: the machine's (~/.beefy-slot/config.json, the one new settings go in) and a project's
// beefy-slot.json (read as before; the machine file wins key by key).
// Used by: the bin entry point, the config commands and embedders.
// Exports: findConfig (walk to the repository boundary), validate (strict file validation),
//   machineConfigPath, readMachineConfig, inspectMachineFile (what the screen starts from), writeMachineConfig,
//   machineConfigText, hashOf,
//   loadConfig (both files as one), MACHINE_KEYS.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

// Every key but `judge` describes the machine, not a project.
export const MACHINE_KEYS = ["lockDir", "heavySlots", "loadMax", "perfHost", "perfLoadMax", "pollSeconds", "heartbeatSeconds", "resources"];
const KEYS = [...MACHINE_KEYS, "judge"];
const RESOURCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const RESERVED = { heavy: "heavySlots", perf: "perfLoadMax" };

// Why these ends: a record is good for 2 minutes after a renewal, so a heartbeat past 60 s leaves
// room for one missed renewal at most; a poll past 10 minutes is a queue nobody is watching.
export const MAX_HEARTBEAT_SECONDS = 60;
export const MAX_POLL_SECONDS = 600;

// A named resource's entry: only `slots` (1 to 16) and `loadGate` (false turns the load limit off).
const validateResources = (resources) => {
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) return "resources: expected an object of resource names";
  for (const [name, entry] of Object.entries(resources)) {
    if (!RESOURCE.test(name)) return `resources.${name}: not a resource name`;
    if (Object.hasOwn(RESERVED, name)) return `resources.${name}: ${name} is reserved; ${name === "heavy" ? "its slots are" : "its load limit is"} set by ${RESERVED[name]}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return `resources.${name}: expected an object`;
    for (const [key, value] of Object.entries(entry)) {
      if (key === "slots") {
        if (!Number.isInteger(value) || value < 1 || value > 16) return `resources.${name}.slots: expected an integer from 1 to 16`;
      } else if (key === "loadGate") {
        if (typeof value !== "boolean") return `resources.${name}.loadGate: expected true or false`;
      } else return `resources.${name}.${key}: unknown key`;
    }
  }
  return null;
};

const NUMBERS = { perfLoadMax: Infinity, loadMax: Infinity, pollSeconds: MAX_POLL_SECONDS, heartbeatSeconds: MAX_HEARTBEAT_SECONDS };

// Return the first invalid key's explanation, or null. Code-passed settings do not use this check.
// `machine` is true for the machine's file, whose judge is a path on the machine (absolute, or under
// `~/`) or a package name; a project's judge stays inside the project's folder. `keepUnknown` lets a key
// this version does not know pass (the screen keeps what a newer version wrote).
export const validate = (config, { machine = false, keepUnknown = false } = {}) => {
  if (!config || typeof config !== "object" || Array.isArray(config)) return "config must be an object";
  for (const [key, value] of Object.entries(config)) {
    if (!KEYS.includes(key)) {
      if (keepUnknown) continue;
      return `${key}: unknown key`;
    }
    if (key === "resources") {
      const problem = validateResources(value);
      if (problem) return problem;
      continue;
    }
    if (key === "heavySlots") {
      if (!Number.isInteger(value) || value < 1 || value > 16) return `${key}: expected an integer from 1 to 16`;
    } else if (Object.hasOwn(NUMBERS, key)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return `${key}: expected a positive number`;
      if (value > NUMBERS[key]) return `${key}: expected a number up to ${NUMBERS[key]}`;
    } else if (typeof value !== "string" || (key !== "perfHost" && !value)) return `${key}: expected a string${key === "perfHost" ? "" : " that is not empty"}`;
    if (key === "lockDir" && !isAbsolute(value) && !value.startsWith("~/")) return `${key}: expected an absolute path or one starting with ~/ (a relative one is a different folder from every directory)`;
    if (key === "judge") {
      const path = machine && value.startsWith("~/") ? value.slice(2) : value;
      if ((!machine && isAbsolute(path)) || path.includes("\\") || path.split("/").some((part) => part === "..") || path.includes(":")) return `${key}: expected ${machine ? "a path on this machine or a package name" : "a path inside the config folder or a package name"}`;
    }
  }
  return null;
};

// A malformed file throws with its path so callers cannot mistake it for no config.
const readFile = (path, options) => {
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: ${error.message}`, { cause: error });
  }
  const error = validate(config, options);
  if (error) throw Object.assign(new Error(`${path}: ${error}`), { found: { path, config } });
  return { path, config };
};

export const hashOf = (text) => createHash("sha256").update(text).digest("hex");

// The machine's file as the screen starts from it: { state, path, hash, config, error }. `state` is "none" (no file),
// "ok", "unknown" (valid but for keys this version does not know: `config` keeps them), or "bad" (not JSON, not
// readable, or invalid: no `config`, and the screen must not overwrite it). `hash` is the content read, for writeMachineConfig's `expect`.
export const inspectMachineFile = (home = homedir()) => {
  const path = machineConfigPath(home);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return error?.code === "ENOENT" ? { state: "none", path, hash: null, config: {}, error: null } : { state: "bad", path, hash: null, error: `${path}: ${error.message}` };
  }
  const hash = hashOf(text);
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    return { state: "bad", path, hash, error: `${path}: ${error.message}` };
  }
  const strict = validate(config, { machine: true });
  if (!strict) return { state: "ok", path, hash, config, error: null };
  return validate(config, { machine: true, keepUnknown: true }) ? { state: "bad", path, hash, error: `${path}: ${strict}` } : { state: "unknown", path, hash, config, error: `${path}: ${strict}` };
};

export const findConfig = (dir) => {
  let folder = resolve(dir);
  for (;;) {
    // beefy-slot.json wins over the old chute-boss.json when a folder holds both.
    const path = [join(folder, "beefy-slot.json"), join(folder, "chute-boss.json")].find((candidate) => existsSync(candidate));
    if (path) return readFile(path);
    const parent = dirname(folder);
    if (existsSync(join(folder, ".git")) || parent === folder) return null;
    folder = parent;
  }
};

export const machineConfigPath = (home = homedir()) => join(home, ".beefy-slot", "config.json");

// The machine's file as { path, config }, or null when there is none. Throws like findConfig.
export const readMachineConfig = (home = homedir()) => {
  const path = machineConfigPath(home);
  return existsSync(path) ? readFile(path, { machine: true }) : null;
};

// The text writeMachineConfig puts on disk for `config`; hashOf of it is the `expect` for the next save.
export const machineConfigText = (config) => `${JSON.stringify(config, null, 2)}\n`;

// Write the machine's file whole (aside, then renamed over), refusing a config it would not read back. A symlinked
// file is written through to its target. `expect` is the `hash` inspectMachineFile gave (null: no file yet): the write
// is refused when the file is no longer that, so a screen never erases an edit made since it read the file.
// A failure leaves no half-written file behind and throws a plain "not saved: ..." message.
export const writeMachineConfig = (config, home = homedir(), { expect, keepUnknown = false } = {}) => {
  const problem = validate(config, { machine: true, keepUnknown });
  if (problem) throw new Error(`not saved: ${problem}`);
  const path = machineConfigPath(home);
  let target = path;
  try {
    target = realpathSync(path);
  } catch {
    try {
      if (lstatSync(path).isSymbolicLink()) target = resolve(dirname(path), readlinkSync(path));
    } catch {}
  }
  const aside = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    if (expect !== undefined) {
      let now = null;
      try {
        now = hashOf(readFileSync(target, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") now = "unreadable";
      }
      if (now !== expect) throw new Error("the machine file changed since it was read (another screen, or an edit by hand); nothing was overwritten. Quit and open the screen again to see it");
    }
    writeFileSync(aside, machineConfigText(config));
    renameSync(aside, target);
  } catch (error) {
    rmSync(aside, { force: true });
    throw new Error(`not saved: ${error.message}`, { cause: error });
  }
  return path;
};

// Both files as the one config the commands use: the machine file's keys over the project file's.
// `judge` is { spec, baseDir } for loadJudge, from the machine file when it names one, else the project's.
// `error` is the first file that could not be read or is not valid; the files that could be are still merged,
// so `status` can show state (`machineError` and `projectError` say which file was not valid). `sources` says which file each key came from ("machine" or "project").
export const loadConfig = ({ cwd = process.cwd(), home = homedir() } = {}) => {
  let error = null;
  const problems = {};
  const read = (find, which) => {
    try {
      return find();
    } catch (problem) {
      error ??= problem.message;
      problems[which] = problem.message;
      return problem.found ?? null;
    }
  };
  const machine = read(() => readMachineConfig(home), "machine");
  const project = read(() => findConfig(cwd), "project");
  const config = { ...project?.config, ...machine?.config };
  const sources = {};
  for (const key of Object.keys(config)) sources[key] = machine && Object.hasOwn(machine.config, key) ? "machine" : "project";
  let judge = null;
  if (typeof config.judge === "string" && config.judge) {
    if (sources.judge === "machine") judge = { spec: config.judge.startsWith("~/") ? join(home, config.judge.slice(2)) : config.judge, baseDir: dirname(machine.path) };
    else judge = { spec: config.judge, baseDir: dirname(project.path) };
  }
  return { config, machine, project, sources, judge, error, machineError: problems.machine ?? null, projectError: problems.project ?? null };
};
