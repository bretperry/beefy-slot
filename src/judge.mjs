// Load a synchronous command judge and bound its evaluation; only null permits a run.
// Used by: the bin entry point and embedders.
// Exports: loadJudge, sinkRefusal, shellQuote, quoteCommand.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

// A word as a POSIX shell reads it back as the same single word: bare when it is only safe
// characters, else in single quotes.
export const shellQuote = (word) => (/^[A-Za-z0-9_@%+:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

// The command line the judge reads for an argv: the same array passed to spawn, one word per element.
export const quoteCommand = (argv) => argv.map(shellQuote).join(" ");

// Import failures become a throwing judge, leaving all non-run verbs available.
export const loadJudge = async (spec, baseDir) => {
  try {
    const local = resolve(baseDir, spec);
    const require = createRequire(pathToFileURL(resolve(baseDir, "beefy-slot.json")));
    const target = spec.startsWith(".") || existsSync(local) || spec.endsWith(".mjs") ? pathToFileURL(local).href : pathToFileURL(require.resolve(spec)).href;
    const module = await import(target);
    if (typeof module.judge !== "function") throw new Error(`${spec} does not export judge`);
    const timeout = module.timeoutMs === undefined ? 2000 : module.timeoutMs;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10000) throw new Error(`${spec}: timeoutMs must be 1 to 10000`);
    return (command, context) => runInNewContext("verdict()", { verdict: () => module.judge(command, context) }, { timeout });
  } catch (error) {
    return () => { throw error; };
  }
};

// Why `argv` may not run, or null when the judge has no objection. Only a null verdict allows: a deny,
// an ask, a verdict of any other shape, and a judge that throws all refuse.
export const sinkRefusal = (argv, guard, cwd = process.cwd()) => {
  const command = quoteCommand(argv);
  let verdict;
  try {
    verdict = guard(command, { argv, cwd });
  } catch (error) {
    return `the judge failed (${error instanceof Error ? error.message : String(error)}), so \`${command}\` is not run`;
  }
  if (verdict === null) return null;
  if (verdict?.decision === "deny" || verdict?.decision === "ask") {
    const why = verdict.decision === "deny" ? "refuses" : "needs the user to confirm";
    return `the judge ${why} \`${command}\` (${verdict.decision}): ${verdict.reason}. \`run\` cannot ask for confirmation, so it does not start a command the judge would deny or ask about.`;
  }
  return `the judge returned an answer beefy-slot cannot read for \`${command}\`, so it is not run`;
};

