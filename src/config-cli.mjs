// The `config` commands: the screen, and its three plain-text forms for scripts and pipes.
// Used by: the bin entry point.
// Run: `beefy-slot config` (the screen, on a terminal), `config check [--strict]`, `config show`, `config preset <name> [--write]`.
// Writes: the screen and `preset --write` save ~/.beefy-slot/config.json; `check` probes the lock folder only when its lockDir is not from the project file.
// Exit: 0 done; 2 usage, a config error, or a warning under --strict.
// Exports: configMain.

import { availableParallelism, homedir } from "node:os";

import { checkConfig, plain } from "./check.mjs";
import { machineConfigPath, readMachineConfig, writeMachineConfig } from "./config.mjs";
import { PRESETS, preset } from "./presets.mjs";
import { runTui } from "./tui.mjs";

const USAGE = `usage: beefy-slot config [check [--strict] | show | preset <name> [--write]]\n  presets: ${Object.keys(PRESETS).join(", ")}`;
const pad = (text, width) => text + " ".repeat(Math.max(0, width - text.length));

export const configMain = async (argv, { out: write = console.log, err = console.error, env = process.env, home = homedir(), cwd = process.cwd(), cores = availableParallelism(), stdin = process.stdin, stdout = process.stdout } = {}) => {
  const [verb, ...rest] = argv;
  // Config files and lock records are not ours: nothing they hold reaches the terminal as a control character.
  const out = (text) => write(String(text).split("\n").map(plain).join("\n"));
  if (verb === undefined && stdin.isTTY && stdout.isTTY) return runTui({ stdin, stdout, env, home, cwd, cores });
  if (verb === "check" && rest.every((flag) => flag === "--strict")) {
    const result = await checkConfig({ cwd, home, env, cores, strict: rest.includes("--strict") });
    for (const finding of result.findings) out(`${pad(finding.level, 6)}${finding.text}`);
    out(`${result.errors} error${result.errors === 1 ? "" : "s"}, ${result.warnings} warning${result.warnings === 1 ? "" : "s"}`);
    return result.code;
  }
  // Without a terminal there is no screen to draw: `config` alone prints what `show` does.
  if ((verb === "show" && rest.length === 0) || verb === undefined) {
    const result = await checkConfig({ cwd, home, env, cores });
    out(`machine file  ${machineConfigPath(home)}${result.loaded.machine ? "" : " (none yet)"}`);
    out(`project file  ${result.loaded.project?.path ?? "none"}`);
    for (const row of result.rows) out(`${pad(row.key, 18)}${pad(String(row.value === "" ? "none" : row.value), 40)}  ${row.source}`);
    for (const [name, entry] of Object.entries(result.settings.resources)) out(`${pad(`resources.${name}`, 18)}${pad(`${entry.slots ?? 1} slot${(entry.slots ?? 1) === 1 ? "" : "s"}, load limit ${entry.loadGate ? "on" : "off"}`, 40)}  ${result.loaded.sources.resources === "machine" ? "machine file" : "project file"}`);
    if (verb === undefined) out("beefy-slot config opens the config screen on a terminal");
    return result.errors ? 2 : 0;
  }
  if (verb === "preset" && rest.length >= 1 && rest.slice(1).every((flag) => flag === "--write")) {
    let current;
    try {
      current = readMachineConfig(home)?.config ?? {};
    } catch (error) {
      err(plain(error.message));
      return 2;
    }
    const next = preset(rest[0], current, cores);
    if (!next) {
      err(`${USAGE}\nbeefy-slot config: ${plain(rest[0])} is not a preset`);
      return 2;
    }
    out(JSON.stringify(next, null, 2));
    if (rest.includes("--write")) {
      try {
        out(`wrote ${writeMachineConfig(next, home)}`);
      } catch (error) {
        err(plain(error.message));
        return 2;
      }
    } else out(`not written; add --write to save it to ${machineConfigPath(home)}`);
    return 0;
  }
  err(USAGE);
  return 2;
};
