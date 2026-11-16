#!/usr/bin/env node
// CLI entry point: discover JSON settings and load the judge only for run.
// Used by: direct node invocations.
// Run: `node bin/beefy-slot.mjs <verb> …`; supports lock verbs, perf and --version.
// When: using the package directly; project shims supply their own aliases and settings.
// Env: BEEFY_SLOT_LOCK_DIR, BEEFY_SLOT_LOAD_MAX, BEEFY_SLOT_PERF_LOAD_MAX, BEEFY_SLOT_HEAVY_SLOTS, BEEFY_SLOT_PERF_HOST, BEEFY_SLOT_LOCK_POLL_SECONDS, BEEFY_SLOT_LOCK_HEARTBEAT_SECONDS, BEEFY_SLOT_LOCK_HELD. (each has a CHUTE_BOSS_ twin, read as a legacy alias for one release)
// Writes: lock and waiver records; run starts a command and keeper; perf may call ssh.
// Exit: 0 done, 1 refused, 2 usage or bad config, 75 busy; run returns its command's code.

import { dirname } from "node:path";
import { main, findConfig, loadJudge, resolveSettings } from "../src/index.mjs";

const argv = process.argv.slice(2);
let found;
let configError;
try {
  if (argv[0] !== "keep") found = findConfig(process.cwd());
} catch (error) {
  configError = error.message;
  found = error.found;
}
const config = found?.config ?? {};
const judge = argv[0] === "run" ? !configError && config.judge ? await loadJudge(config.judge, dirname(found.path)) : () => null : undefined;
process.exitCode = main(argv, { settings: argv[0] === "keep" ? undefined : resolveSettings({ config }), judge, configError });
