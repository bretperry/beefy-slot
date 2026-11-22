// A folder holding only beefy-slot.json takes, queues, refuses on load, waives, and runs.
import "./tmpdir.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const CLI = fileURLToPath(new URL("../bin/beefy-slot.mjs", import.meta.url));

// The folder has the config and nothing else; no BEEFY_SLOT_ or CHUTE_BOSS_ variable is set, so defaults and the file decide.
const project = (config = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "standalone-"));
  mkdirSync(join(dir, ".git"));
  const locks = join(dir, "locks");
  writeFileSync(join(dir, "beefy-slot.json"), JSON.stringify({ lockDir: locks, ...config }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("BEEFY_SLOT_") && !name.startsWith("CHUTE_BOSS_")));
  const run = (args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env: { ...env, ...extra }, encoding: "utf8" });
  return { dir, locks, run };
};

describe("standalone defaults", () => {
  it("takes, turns the next holder away with 75, and frees", () => {
    const { run, locks } = project();
    assert.equal(run(["take", "heavy", "--as", "a"], { BEEFY_SLOT_LOAD_MAX: "1000000" }).status, 0);
    assert.ok(existsSync(locks), "the file's lockDir is used");
    const second = run(["take", "heavy", "--as", "b"], { BEEFY_SLOT_LOAD_MAX: "1000000" });
    assert.equal(second.status, 75, second.stderr);
    assert.match(run(["status"]).stdout, /heavy: a/);
    assert.equal(run(["free", "heavy", "--as", "a"]).status, 0);
    assert.equal(run(["take", "heavy", "--as", "b"], { BEEFY_SLOT_LOAD_MAX: "1000000" }).status, 0);
  });

  it("queues for a second slot when the file sets heavySlots", () => {
    const { run } = project({ heavySlots: 2 });
    const env = { BEEFY_SLOT_LOAD_MAX: "1000000" };
    assert.equal(run(["take", "heavy", "--as", "a"], env).status, 0);
    assert.equal(run(["take", "heavy", "--as", "b"], env).status, 0);
    assert.equal(run(["take", "heavy", "--as", "c"], env).status, 75);
  });

  it("refuses on load, and a waiver lets that holder through", () => {
    const { run } = project();
    const env = { BEEFY_SLOT_LOAD_MAX: "0.000001" };
    const refused = run(["take", "heavy", "--as", "a"], env);
    assert.equal(refused.status, 75, refused.stderr);
    assert.equal(run(["waive", "heavy", "--as", "a", "--reason", "test"], env).status, 0);
    assert.equal(run(["take", "heavy", "--as", "a"], env).status, 0);
  });

  it("runs a command under the lock and passes its exit code on", () => {
    const { run, locks } = project();
    const env = { BEEFY_SLOT_LOAD_MAX: "1000000" };
    const result = run(["run", "heavy", "--", process.execPath, "-e", "process.exit(7)"], env);
    assert.equal(result.status, 7, result.stderr);
    assert.match(run(["status"]).stdout, /no locks held/);
    assert.ok(existsSync(locks));
  });

  it("prints the folder and judge on status's first line", () => {
    const { run, locks } = project();
    assert.equal(run(["status"]).stdout.split("\n")[0], `beefy-slot 0.4.1 · folder ${locks} · judge none`);
  });
  it("uses BEEFY_SLOT_LOCK_DIR over the file's lockDir", () => {
    const { run, dir, locks } = project();
    const other = join(dir, "env-locks");
    assert.equal(run(["take", "heavy", "--as", "a"], { BEEFY_SLOT_LOAD_MAX: "1000000", BEEFY_SLOT_LOCK_DIR: other }).status, 0);
    assert.ok(existsSync(other));
    assert.ok(!existsSync(locks));
  });

  it("names an unusable BEEFY_SLOT_LOCK_DIR and exits nonzero", () => {
    const { run, dir } = project();
    const file = join(dir, "not-a-folder");
    writeFileSync(file, "x");
    const result = run(["take", "heavy", "--as", "a"], { BEEFY_SLOT_LOAD_MAX: "1000000", BEEFY_SLOT_LOCK_DIR: join(file, "locks") });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /lockDir .*not-a-folder.* is not usable/);
  });

  it("refuses free and take on a config error without touching the lockDir", () => {
    const { run, dir } = project();
    writeFileSync(join(dir, "beefy-slot.json"), "{ not json");
    const home = join(dir, "home");
    mkdirSync(home);
    for (const args of [["free", "heavy", "--as", "a"], ["take", "heavy", "--as", "a"]]) {
      const result = run(args, { HOME: home });
      assert.equal(result.status, 2, `${args[0]}: ${result.stderr}`);
      assert.match(result.stderr, /beefy-slot\.json/);
    }
    assert.deepEqual(readdirSync(home), [], "default lockDir was not created");
  });

  it("does not report an unrelated ENOENT as a lockDir problem, but does report the lockDir's own", async () => {
    const { main, resolveSettings } = await import("../src/index.mjs");
    const { dir, locks } = project();
    const settings = resolveSettings({ config: { lockDir: locks }, env: {} });
    const lines = [];
    const base = { settings, load: 0, judge: () => null, out: () => {}, err: (m) => lines.push(m) };
    const unrelated = Object.assign(new Error("spawn nosuch ENOENT"), { code: "ENOENT", path: "nosuch" });
    assert.throws(() => main(["run", "heavy", "--", "nosuch"], { ...base, spawn: () => { throw unrelated; } }), /spawn nosuch/);
    assert.deepEqual(lines, []);
    const own = Object.assign(new Error("own"), { code: "ENOENT", path: join(locks, "heavy.json") });
    assert.equal(main(["run", "heavy", "--", "x"], { ...base, spawn: () => { throw own; } }), 1);
    assert.match(lines.join("\n"), /lockDir .* is not usable \(ENOENT\)/);
    assert.ok(dir);
  });
});
