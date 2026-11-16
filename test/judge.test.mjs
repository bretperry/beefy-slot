// Synchronous judge loading, bounded evaluation, and CLI behavior with or without a judge.
import "./tmpdir.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { loadJudge, sinkRefusal } from "../src/index.mjs";

const CLI = fileURLToPath(new URL("../bin/beefy-slot.mjs", import.meta.url));
const API = new URL("../src/index.mjs", import.meta.url).href;
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "judge-"));
  mkdirSync(join(dir, ".git"));
  return dir;
};

describe("judge", () => {
  it("loads a fake module and passes the exact argv and cwd to it", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "judge.mjs"), `export const judge = (command, { argv, cwd }) => command === "echo 'a b'" && argv[1] === 'a b' && cwd === ${JSON.stringify(dir)} ? null : { decision: 'deny', reason: 'wrong context' };`);
    const judge = await loadJudge("./judge.mjs", dir);
    assert.equal(sinkRefusal(["echo", "a b"], judge, dir), null);
    assert.match(sinkRefusal(["echo", "other"], judge, dir), /wrong context/);
  });

  it("refuses a missing, broken, throwing, or incomplete module", async () => {
    const dir = fixture();
    assert.match(sinkRefusal(["echo", "hi"], await loadJudge("./missing.mjs", dir)), /command guard failed/);
    for (const [i, source] of ["not valid JavaScript !", "throw new Error('import failed');", "export const other = () => null;", "export const judge = () => { throw new Error('judge failed'); };"].entries()) {
      const name = `judge${i}.mjs`;
      writeFileSync(join(dir, name), source);
      assert.match(sinkRefusal(["echo", "hi"], await loadJudge(`./${name}`, dir)), /command guard failed/);
    }
  });

  it("accepts an omitted timeout and refuses timeout values outside 1 to 10000", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "default.mjs"), "export const judge = () => null;");
    assert.equal(sinkRefusal(["true"], await loadJudge("./default.mjs", dir)), null);
    for (const [i, value] of ["0", "-5", "'x'", "NaN", "10001", "1.5"].entries()) {
      const name = `timeout${i}.mjs`;
      writeFileSync(join(dir, name), `export const timeoutMs = ${value}; export const judge = () => null;`);
      assert.match(sinkRefusal(["true"], await loadJudge(`./${name}`, dir)), /timeoutMs must be 1 to 10000/);
    }
  });

  it("ends a judge that loops and refuses, within a child process timeout", () => {
    const dir = fixture();
    writeFileSync(join(dir, "loop.mjs"), "export const timeoutMs = 300; export const judge = () => { for (;;); };");
    const script = `import { loadJudge, sinkRefusal } from ${JSON.stringify(API)}; console.log(sinkRefusal(['echo', 'hi'], await loadJudge('./loop.mjs', ${JSON.stringify(dir)})));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 8000 });
    assert.equal(result.status, 0, result.error?.message);
    assert.match(result.stdout, /command guard failed .*timed out/s);
  });

  it("a configured judge that cannot load refuses run while take, free, and status work", () => {
    const dir = fixture();
    const locks = join(dir, "locks");
    const marker = join(dir, "ran");
    writeFileSync(join(dir, "beefy-slot.json"), JSON.stringify({ lockDir: locks, judge: "missing.mjs" }));
    const env = { ...process.env, BEEFY_SLOT_LOAD_MAX: "1000000" };
    delete env.BEEFY_SLOT_LOCK_DIR;
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env, encoding: "utf8" });
    const result = run("run", "x", "--", process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /command guard failed/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(locks), false);
    assert.equal(run("take", "x", "--as", "a").status, 0);
    assert.match(run("status").stdout, /x: a until /);
    assert.equal(run("free", "x", "--as", "a").status, 0);
  });

  it("without a configured judge runs a command and reports judge none", () => {
    const dir = fixture();
    const env = { ...process.env, BEEFY_SLOT_LOCK_DIR: join(dir, "locks"), BEEFY_SLOT_LOAD_MAX: "1000000" };
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env, encoding: "utf8" });
    const result = run("run", "x", "--", process.execPath, "-e", "console.log('ran')");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ran/);
    assert.match(run("status").stdout, /judge none/);
  });
});
