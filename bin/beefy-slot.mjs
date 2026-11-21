#!/usr/bin/env node
// CLI entry point: read the machine and project settings and load the judge only for run.
// Used by: direct node invocations.
// Run: `beefy-slot <verb> …` or `beefy <verb> …` (the same file); bare on a terminal opens the queue screen, `config` opens settings; `beefy [-d] [--on r] [--wait m] [--as who] [--] <cmd…>` queues with no cap and runs (`-d`: in the background, as a job); supports lock verbs, jobs, log, cancel, perf, config and --version.
// When: using the package directly; project shims supply their own aliases and settings.
// Env: BEEFY_SLOT_LOCK_DIR, BEEFY_SLOT_LOAD_MAX, BEEFY_SLOT_PERF_LOAD_MAX, BEEFY_SLOT_HEAVY_SLOTS, BEEFY_SLOT_PERF_HOST, BEEFY_SLOT_LOCK_POLL_SECONDS, BEEFY_SLOT_LOCK_HEARTBEAT_SECONDS, BEEFY_SLOT_LOCK_HELD. (each has a CHUTE_BOSS_ twin, read as a legacy alias for one release)
// Writes: lock and waiver records; job records and logs; run starts a command and keeper; perf may call ssh.
// Exit: 0 done, 1 refused, 2 usage or bad config, 75 busy; run returns its command's code.

import { commandArgv, configMain, isCommand, main, runTui, USAGE, loadConfig, loadJudge, resolveSettings } from "../src/index.mjs";

const argv = process.argv.slice(2);
// Bare, on a terminal, it opens the queue; `config` opens settings; in a script or pipe a bare call prints usage as before.
if (argv[0] === "config") process.exitCode = await configMain(argv.slice(1));
else if (argv.length === 0 && process.stdin.isTTY && process.stdout.isTTY) process.exitCode = await runTui({ screen: "queue" });
else {
  // `keep` is the internal renewer: it is told everything it needs and reads no config.
  const loaded = argv[0] === "keep" ? { config: {}, judge: null, error: null } : loadConfig();
  const judge = argv[0] === "run" || argv[0] === "job" || isCommand(argv) ? (!loaded.error && loaded.judge ? await loadJudge(loaded.judge.spec, loaded.judge.baseDir) : () => null) : undefined;
  const command = isCommand(argv) ? commandArgv(argv) : null;
  if (isCommand(argv) && !command) {
    console.error(USAGE);
    process.exitCode = 2;
  } else process.exitCode = await main(command?.argv ?? argv, { settings: argv[0] === "keep" ? undefined : resolveSettings({ config: loaded.config }), judge, configError: loaded.error ?? undefined, uncapped: command?.uncapped, command: command !== null, detach: command?.detach });
}
