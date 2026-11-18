// Programmatic entry point: route perf calls and supply the judge seam to the self-contained core.
// Used by: the bin entry point and embedders.
// Exports: main, resolveSettings, findConfig, validate, loadJudge, lock constants and helpers.

import { sep } from "node:path";
import { USAGE, main as lockMain, resolveSettings } from "./beefy-slot.mjs";
import { main as perfMain } from "./perf.mjs";
import { sinkRefusal } from "./judge.mjs";

export * from "./beefy-slot.mjs";
export { findConfig, validate } from "./config.mjs";
export { loadJudge, sinkRefusal, shellQuote, quoteCommand } from "./judge.mjs";

// File system errors that mean lockDir is a file, missing a parent, or not accessible.
const DIR_ERRORS = ["ENOTDIR", "EEXIST", "EACCES", "EPERM", "EROFS", "ENOENT", "EISDIR"];

// True when the error's path is the lockDir, something inside it, or a parent on the way to it (its creation).
const aboutLockDir = (error, dir) => typeof error?.path === "string" && (error.path === dir || error.path.startsWith(dir + sep) || dir.startsWith(error.path.endsWith(sep) ? error.path : error.path + sep));

export const VERSION = "0.2.1";

export const main = (argv, options = {}) => {
  if (argv[0] === "--version") {
    (options.out ?? console.log)(VERSION);
    return 0;
  }
  if (argv[0] === "--help") {
    (options.out ?? console.log)(USAGE);
    return 0;
  }
  const settings = options.settings ?? resolveSettings(options);
  const verb = argv[0] === "perf" ? argv[1] : argv[0];
  // A malformed beefy-slot.json blocks `free` too: it may have moved lockDir, and freeing in the wrong folder would leave the real lock held.
  if (options.configError && verb !== "status") {
    (options.err ?? console.error)(options.configError);
    return 2;
  }
  // status still runs so a person can see state, and says why the config was refused.
  if (options.configError && verb === "status") (options.err ?? console.error)(`config error: ${options.configError}`);
  const guarded = (run) => {
    try {
      return run();
    } catch (error) {
      const report = options.err ?? console.error;
      if (error?.code === "ENOHARDLINK") {
        report(error.message);
        return 1;
      }
      if (DIR_ERRORS.includes(error?.code) && aboutLockDir(error, settings.lockDir)) {
        report(`beefy-slot: lockDir ${settings.lockDir} is not usable (${error.code}); it must be a folder you can read and write. Set lockDir in beefy-slot.json or BEEFY_SLOT_LOCK_DIR.`);
        return 1;
      }
      throw error;
    }
  };
  if (argv[0] === "perf") return guarded(() => perfMain(argv.slice(1), { ...options, settings }));
  if (argv[0] === "status" && options.statusHeader !== false) (options.out ?? console.log)(`beefy-slot ${VERSION} · folder ${settings.lockDir} · judge ${options.judgePath ?? settings.config.judge ?? "none"}`);
  return guarded(() => lockMain(argv, { ...options, settings, refusal: (command) => sinkRefusal(command, options.judge) }));
};
