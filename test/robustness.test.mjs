// Wrong-shaped lock files, judge loading on bad config, unusable lockDir, spawn failures, signals.
import "./tmpdir.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const CLI = fileURLToPath(new URL("../bin/beefy-slot.mjs", import.meta.url));
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "robust-"));
  mkdirSync(join(dir, ".git"));
  return dir;
};
const cli = (dir, lockDir, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env: { ...process.env, BEEFY_SLOT_LOCK_DIR: lockDir, BEEFY_SLOT_LOAD_MAX: "1000000" }, encoding: "utf8" });

describe("robustness", () => {
  it("treats a lock file of the wrong shape as free", () => {
    for (const text of ["{}", "[]", '"x"', "5", '{"until":"junk"}', '{"as":"a"}', '{"until":"2999-01-01T00:00:00Z"}']) {
      const dir = fixture();
      const locks = join(dir, "locks");
      mkdirSync(locks);
      writeFileSync(join(locks, "x.json"), text);
      const status = cli(dir, locks, ["status", "x"]);
      assert.match(status.stdout, /no locks held/, `${text}: ${status.stdout}`);
      const taken = cli(dir, locks, ["take", "x", "--as", "me"]);
      assert.equal(taken.status, 0, `${text}: ${taken.stderr}`);
      assert.match(cli(dir, locks, ["status", "x"]).stdout, /x: me until/);
      assert.equal(cli(dir, locks, ["free", "x", "--as", "me"]).status, 0);
    }
  });

  it("never loads the judge when the config has an error", () => {
    const dir = fixture();
    const marker = join(dir, "loaded");
    writeFileSync(join(dir, "evil.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, ""); export const judge = () => null;`);
    writeFileSync(join(dir, "beefy-slot.json"), '{"heavySlots":"x","judge":"./evil.mjs"}');
    const result = cli(dir, join(dir, "locks"), ["run", "x", "--", "true"]);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(existsSync(marker), false);
  });

  it("names lockDir in one line when it is a file", () => {
    const dir = fixture();
    const locks = join(dir, "afile");
    writeFileSync(locks, "");
    for (const args of [["take", "x", "--as", "a"], ["status"]]) {
      const result = cli(dir, locks, args);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /^beefy-slot: lockDir .*afile is not usable/);
      assert.equal(result.stderr.trim().split("\n").length, 1);
    }
  });

  it("says why a command failed to start and maps a signal to 128+n", () => {
    const dir = fixture();
    const locks = join(dir, "locks");
    const missing = cli(dir, locks, ["run", "x", "--", "no-such-program-beefy"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /could not start no-such-program-beefy/);
    const killed = cli(dir, locks, ["run", "x", "--", process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"]);
    assert.equal(killed.status, 143, killed.stderr);
  });
});
