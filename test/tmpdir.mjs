/*
  Give each test process a temporary folder and remove it on exit, including failures.
  Import this before modules that create fixtures. Child processes inherit the folder.
  TMPDIR, TMP, and TEMP point at it so all temporary files share the same cleanup.
*/
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "beefy-slot-test-"));
// Allow child processes using another user to traverse the temporary folder without listing it.
chmodSync(sandbox, 0o711);
for (const name of ["TMPDIR", "TMP", "TEMP"]) process.env[name] = sandbox;
// HOME too, so no test reads the real machine's ~/.beefy-slot/config.json or its lock folder.
mkdirSync(join(sandbox, "home"));
process.env.HOME = join(sandbox, "home");

const clean = () => rmSync(sandbox, { recursive: true, force: true });
// "exit" covers a normal end, a failed assertion, and process.exit(); it can only do sync work, which rmSync is.
process.once("exit", clean);
// A signal skips "exit", so clean, then die of the same signal so the test process retains its termination cause.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    clean();
    process.kill(process.pid, signal);
  });
}
