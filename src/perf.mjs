// Queue for one quiet perf machine, waiting on the caller's side so a killed caller leaves no wait behind.
// Used by: the package entry point and perf shim.
// Exports: main, lockCommand (stdin transport), perfSettings, HOST, PERF_RESOURCE, PERF_LOAD_MAX.
// Uses: the self-contained lock core, ssh and node on a remote host.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { BUSY, MAX_WAIT_MINUTES, PERF, PERF_LOAD_MAX, resolveSettings } from "./beefy-slot.mjs";

// The core owns the reserved resource and its load limit.
export { PERF_LOAD_MAX };
export const PERF_RESOURCE = PERF;

// How long ssh waits to connect, and how often it checks the connection.
const SSH_CONNECT_SECONDS = 10;
const SSH_KEEPALIVE_SECONDS = 30;

// A host as ssh takes it (a name, an alias, user@name): no leading dash, so it can't pass for an option.
export const HOST = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

const VERBS = ["take", "free", "status", "waive"];
const REFUSED_FLAGS = ["--ignore-load", "--slots"];

export const perfSettings = (settings) => ({ host: settings.perfHost, loadMax: settings.perfLoadMax });

// One word as a POSIX shell reads it back as the same word.
const quote = (word) => `'${word.replace(/'/g, `'\\''`)}'`;

// Send only the self-contained core. Resolve the caller's config again on the host so ~/ is its home.
export const lockCommand = ({ host, loadMax, lockArgs, source, settings }) => {
  const remote = ["node", "--input-type=module", "-", ...lockArgs.map(quote)].join(" ");
  const input = `${source}\nprocess.exitCode = main(process.argv.slice(2), { settings: resolveSettings({ env: { ...process.env, BEEFY_SLOT_PERF_LOAD_MAX: ${JSON.stringify(String(loadMax))} }, config: ${JSON.stringify(settings.config)}, envAliases: ${JSON.stringify(settings.envAliases)} }) });\n`;
  return {
    command: host ? "ssh" : process.execPath,
    args: host ? ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${SSH_CONNECT_SECONDS}`, "-o", `ServerAliveInterval=${SSH_KEEPALIVE_SECONDS}`, host, remote] : ["--input-type=module", "-", ...lockArgs],
    input,
    env: settings.childEnv,
  };
};

// Runs a call with stdout shared and stderr held back, so a wait prints only its last answer.
const defaultExec = ({ command, args, input, env }) => spawnSync(command, args, { env, input, stdio: [input === undefined ? "inherit" : "pipe", "inherit", "pipe"], encoding: "utf8" });

// Blocks the thread for `ms`.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const USAGE = "usage: beefy-slot perf take --as <who> [--wait <minutes>] [--ttl <minutes>] | free --as <who> | status | waive --as <who> --reason <why> [--ttl <minutes>]\nbeefy-slot perf: --ignore-load and --slots are not accepted; waive the load limit with `waive`";

// Returns the exit code. The executor, core source reader, sleep and clock are test seams.
export const main = (argv, { settings = resolveSettings(), exec = defaultExec, readSource = () => readFileSync(fileURLToPath(new URL("./beefy-slot.mjs", import.meta.url)), "utf8"), sleep = pause, clock = () => Date.now(), err = console.error } = {}) => {
  const [verb, ...flags] = argv;
  if (!VERBS.includes(verb) || flags.some((flag) => REFUSED_FLAGS.includes(flag))) {
    err(USAGE);
    return 2;
  }
  // --wait is taken here and not sent: the waiting is this process's, so nothing outlives a caller that is killed.
  let wait = 0;
  let lockFlags = flags;
  const at = flags.indexOf("--wait");
  if (at !== -1) {
    const value = flags[at + 1] ?? "";
    if (verb !== "take" || !/^\d+$/.test(value) || Number(value) > MAX_WAIT_MINUTES) {
      err(`${USAGE}\nbeefy-slot perf: --wait is for take, 0 to ${MAX_WAIT_MINUTES} minutes`);
      return 2;
    }
    wait = Number(value);
    lockFlags = flags.filter((_, i) => i !== at && i !== at + 1);
  }
  const { host, loadMax } = perfSettings(settings);
  if (host && !HOST.test(host)) {
    err(`beefy-slot perf: the perf host "${host}" is not a host name ssh would take`);
    return 2;
  }
  const lockArgs = verb === "status" ? ["status", PERF] : [verb, PERF, ...lockFlags];
  const call = lockCommand({ host, loadMax, lockArgs, source: readSource(), settings });
  const poll = settings.pollSeconds * 1000;
  const deadline = clock() + wait * 60_000;
  for (;;) {
    const result = exec(call);
    const code = result.status ?? -1;
    // The core answers 0, 1, 2, or 75. Anything else is the transport: ssh's 255, a missing node, a kill.
    const answer = [0, 1, 2, BUSY].includes(code) ? code : -1;
    if (answer === BUSY && clock() < deadline) {
      sleep(Math.min(poll, Math.max(deadline - clock(), 1)));
      continue;
    }
    if (result.stderr) err(result.stderr.trimEnd());
    if (answer === -1) {
      err(`beefy-slot perf: could not run the lock on ${host || "this machine"} (exit ${code}); is ssh set up for it, and is node on its PATH?`);
      return 1;
    }
    return answer;
  }
};

