// Config discovery, strict file validation, and CLI refusal for invalid settings.
import "./tmpdir.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { linkFailure } from "../src/beefy-slot.mjs";
import { findConfig, resolveSettings, validate } from "../src/index.mjs";

const CLI = fileURLToPath(new URL("../bin/beefy-slot.mjs", import.meta.url));
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "config-"));
  mkdirSync(join(dir, ".git"));
  return dir;
};

describe("config", () => {
  it("finds the nearest file and stops at a repository boundary", () => {
    const dir = fixture();
    const child = join(dir, "child");
    const nested = join(child, "nested");
    mkdirSync(nested, { recursive: true });
    assert.equal(findConfig(nested), null);
    writeFileSync(join(dir, "beefy-slot.json"), '{"heavySlots":2}');
    assert.deepEqual(findConfig(nested), { path: join(dir, "beefy-slot.json"), config: { heavySlots: 2 } });
    writeFileSync(join(child, "beefy-slot.json"), '{"heavySlots":3}');
    assert.equal(findConfig(nested).config.heavySlots, 3);
    mkdirSync(join(nested, ".git"));
    assert.equal(findConfig(nested), null);
  });

  it("validates file keys, types, bounds, and judge paths", () => {
    assert.equal(validate({}), null);
    assert.equal(validate({ lockDir: "~/.chute-boss/locks", heavySlots: 16, perfHost: "", perfLoadMax: 1.5, judge: "scripts/judge.mjs" }), null);
    assert.equal(validate({ judge: "some-judge" }), null);
    for (const config of [null, [], 1]) assert.match(validate(config), /object/);
    for (const [key, value] of [["unknown", 1], ["lockDir", ""], ["lockDir", 1], ["heavySlots", 0], ["heavySlots", 17], ["heavySlots", "2"], ["heavySlots", 1.5], ["perfHost", false], ["perfLoadMax", 0], ["perfLoadMax", Infinity], ["perfLoadMax", "1"], ["judge", "../judge.mjs"], ["judge", "/judge.mjs"], ["judge", "a\\judge.mjs"], ["judge", "file:judge.mjs"]]) {
      assert.match(validate({ [key]: value }), new RegExp(key));
    }
  });

  it("keeps standalone defaults and expands a configured home folder", () => {
    const home = fixture();
    assert.equal(resolveSettings({ env: {}, home }).lockDir, join(home, ".beefy-slot", "locks"));
    assert.equal(resolveSettings({ env: {}, home, config: { lockDir: "~/custom" } }).lockDir, join(home, "custom"));
  });

  it("keeps a machine's pre-rename ~/.chute-boss/locks until it has a ~/.beefy-slot/locks", () => {
    const home = fixture();
    mkdirSync(join(home, ".chute-boss", "locks"), { recursive: true });
    assert.equal(resolveSettings({ env: {}, home }).lockDir, join(home, ".chute-boss", "locks"));
    mkdirSync(join(home, ".beefy-slot", "locks"), { recursive: true });
    assert.equal(resolveSettings({ env: {}, home }).lockDir, join(home, ".beefy-slot", "locks"));
  });

  it("rejects malformed and invalid files before take, run, or waive; status remains available", () => {
    for (const [text, key] of [["{", /beefy-slot\.json/], ['{"typo":1}', /typo/], ['{"heavySlots":17}', /heavySlots/]]) {
      const dir = fixture();
      const locks = join(dir, "locks");
      const marker = join(dir, "ran");
      writeFileSync(join(dir, "beefy-slot.json"), text);
      assert.throws(() => findConfig(dir), key);
      const env = { ...process.env, BEEFY_SLOT_LOCK_DIR: locks, BEEFY_SLOT_LOAD_MAX: "1000000" };
      const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env, encoding: "utf8" });
      for (const args of [["take", "x", "--as", "a"], ["waive", "x", "--as", "a", "--reason", "test"], ["run", "x", "--", process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`]]) {
        const result = run(...args);
        assert.equal(result.status, 2, result.stderr);
        assert.match(result.stderr, key);
        assert.equal(existsSync(locks), false);
        assert.equal(existsSync(marker), false);
      }
      const status = run("status");
      assert.equal(status.status, 0);
      assert.match(status.stderr, key, "status names the config error");
      assert.match(status.stdout, /^beefy-slot /);
      assert.equal(run("free", "x", "--as", "a").status, 2);
    }
  });

  it("explains a folder without hard links and passes other errors through", () => {
    const refused = linkFailure(Object.assign(new Error("x"), { code: "EPERM" }), "/mnt/share/locks/heavy.json");
    assert.equal(refused.code, "ENOHARDLINK");
    assert.match(refused.message, /could not create a lock in \/mnt\/share\/locks \(EPERM\)/);
    assert.match(refused.message, /not be allowed to write/);
    assert.match(refused.message, /lockDir/);
    const other = Object.assign(new Error("y"), { code: "ENOSPC" });
    assert.equal(linkFailure(other, "/x/y.json"), other);
  });

  it("prints the version", () => {
    const result = spawnSync(process.execPath, [CLI, "--version"], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  });

  it("still reads the pre-rename chute-boss.json, CHUTE_BOSS_ variables and held marker", () => {
    const dir = fixture();
    writeFileSync(join(dir, "chute-boss.json"), '{"heavySlots":2}');
    assert.deepEqual(findConfig(dir), { path: join(dir, "chute-boss.json"), config: { heavySlots: 2 } });
    writeFileSync(join(dir, "beefy-slot.json"), '{"heavySlots":4}');
    assert.equal(findConfig(dir).config.heavySlots, 4, "beefy-slot.json wins when both exist");
    const home = fixture();
    assert.equal(resolveSettings({ env: { CHUTE_BOSS_HEAVY_SLOTS: "3" }, home }).heavySlots, 3);
    const both = resolveSettings({ env: { BEEFY_SLOT_HEAVY_SLOTS: "2", CHUTE_BOSS_HEAVY_SLOTS: "3" }, home, err: () => {} });
    assert.equal(both.heavySlots, 2, "the new name wins over the alias");
    assert.equal(resolveSettings({ env: { CHUTE_BOSS_LOCK_HELD: "a:1" }, home }).held, "a:1");
    assert.equal(resolveSettings({ env: { BEEFY_SLOT_LOCK_HELD: "b:2" }, home }).held, "b:2");
    assert.deepEqual(resolveSettings({ env: {}, home }).heldNames, ["BEEFY_SLOT_LOCK_HELD", "CHUTE_BOSS_LOCK_HELD"]);
  });
});
