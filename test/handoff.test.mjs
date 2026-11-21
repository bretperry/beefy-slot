/*
  Instant handoff: a waiting take wakes when the lock folder changes, and looks at once.
  Run with node --test. The wake tests run real waiters in child processes (a wait blocks its thread) with a
  20 s poll, so only the watcher can make them fast; the fault tests take the watcher away and the poll serves.
*/
import "./tmpdir.mjs";
import assert from "node:assert/strict";
import { spawn as start } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { free, holder, take } from "../src/index.mjs";

const SRC = fileURLToPath(new URL("../src/index.mjs", import.meta.url));
const fresh = () => mkdtempSync(join(tmpdir(), "handoff-"));
const taker = (dir, overrides = {}) => ({ dir, resource: "heavy", slots: 1, load: 0, reload: () => 0, ...overrides });

const waitFor = async (check, what, ms = 20_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

// A real waiter: takes `heavy` as `as`, holds it `holdMs`, frees it. Prints "waiting", "taken <ms>", "freeing <ms>", "freed <ms>".
const waiter = (dir, as, { holdMs = 0, poll = 20, env = {} } = {}) => {
  const code = `
    import { take, free } from ${JSON.stringify(SRC)};
    let said = false;
    const got = take({ dir: ${JSON.stringify(dir)}, resource: "heavy", as: ${JSON.stringify(as)}, id: ${JSON.stringify(as)}, slots: 1, wait: 1, pollSeconds: ${poll}, load: 0, reload: () => 0,
      onWait: () => { if (!said) { said = true; console.log("waiting"); } } });
    console.log(got.ok ? "taken " + Date.now() : "failed " + got.reason);
    await new Promise((resolve) => setTimeout(resolve, ${holdMs}));
    console.log("freeing " + Date.now());
    free({ dir: ${JSON.stringify(dir)}, resource: "heavy", as: ${JSON.stringify(as)}, id: ${JSON.stringify(as)} });
    console.log("freed " + Date.now());
  `;
  const child = start(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  const lines = [];
  let text = "";
  child.stdout.on("data", (chunk) => {
    text += chunk;
    const parts = text.split("\n");
    text = parts.pop();
    lines.push(...parts);
  });
  const stamp = (word) => {
    const line = lines.find((l) => l.startsWith(`${word} `));
    return line ? Number(line.slice(word.length + 1)) : null;
  };
  return { child, lines, stamp, done: new Promise((resolve) => child.on("close", resolve)) };
};

// The ticket files the waiters have written: a waiter is in line once its file is there.
const ticketCount = (dir) => (existsSync(join(dir, "tickets")) ? readdirSync(join(dir, "tickets")).filter((n) => n.endsWith(".json")).length : 0);

// Under BEEFY_SLOT_WATCH=off (a full-suite run at poll speed) the real-watcher tests have nothing to test.
const OFF = process.env.BEEFY_SLOT_WATCH === "off";

describe("instant handoff", { skip: OFF }, () => {
  it("a waiter takes a freed slot in under a second, with a 20 s poll", async () => {
    const dir = fresh();
    take({ ...taker(dir), as: "holder", id: "holder" });
    const w = waiter(dir, "w1");
    await waitFor(() => w.lines.includes("waiting") && ticketCount(dir) === 1, "the waiter in line");
    // The watcher starts after the first look; give it time to be listening.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const freedAt = Date.now();
    free({ dir, resource: "heavy", as: "holder", id: "holder" });
    await w.done;
    const lag = w.stamp("taken") - freedAt;
    assert.ok(w.stamp("taken") !== null, w.lines.join("\n"));
    assert.ok(lag < 1000, `the waiter took the slot ${lag} ms after it freed`);
  });

  it("serves two waiters in ticket order, each within a second of the slot freeing", async () => {
    const dir = fresh();
    take({ ...taker(dir), as: "holder", id: "holder" });
    const a = waiter(dir, "a", { holdMs: 300 });
    await waitFor(() => ticketCount(dir) === 1 && a.lines.includes("waiting"), "a in line");
    const b = waiter(dir, "b", { holdMs: 0 });
    await waitFor(() => ticketCount(dir) === 2 && b.lines.includes("waiting"), "b in line");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const freedAt = Date.now();
    free({ dir, resource: "heavy", as: "holder", id: "holder" });
    await Promise.all([a.done, b.done]);
    assert.ok(a.stamp("taken") < b.stamp("taken"), "a, first in line, goes first");
    assert.ok(a.stamp("freeing") <= b.stamp("taken"), "b waits for a to free");
    assert.ok(a.stamp("taken") - freedAt < 1000, "a took the slot within a second");
    assert.ok(b.stamp("taken") - a.stamp("freeing") < 1000, "b took a's slot within a second");
  });

  it("ticket renewals do not set the waiters off: three waiters stay quiet while the slot is held", async () => {
    const dir = fresh();
    take({ ...taker(dir), as: "holder", id: "holder" });
    const ws = ["w1", "w2", "w3"].map((name) => waiter(dir, name));
    await waitFor(() => ticketCount(dir) === 3 && ws.every((w) => w.lines.includes("waiting")), "three waiters in line");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const before = readdirSync(join(dir, "tickets")).length;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(readdirSync(join(dir, "tickets")).length, before);
    free({ dir, resource: "heavy", as: "holder", id: "holder" });
    await Promise.all(ws.map((w) => w.done));
    assert.deepEqual(ws.map((w) => w.stamp("taken") !== null), [true, true, true]);
  });

  it("another resource's traffic is not looked at", async () => {
    const dir = fresh();
    take({ ...taker(dir), as: "holder", id: "holder" });
    let wakes = 0;
    // A waker that counts: a real watcher, with its wait wrapped. Run in a child, so count there.
    const code = `
      import { take, free } from ${JSON.stringify(SRC)};
      let looks = 0;
      const got = take({ dir: ${JSON.stringify(dir)}, resource: "heavy", as: "w", slots: 1, wait: 1, pollSeconds: 20, load: 0, reload: () => { looks += 1; return 0; }, onWait: () => console.log("waiting") });
      console.log("looks " + looks + " " + got.ok);
      free({ dir: ${JSON.stringify(dir)}, resource: "heavy", as: "w" });
    `;
    const child = start(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    await waitFor(() => out.includes("waiting"), "the waiter");
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (let i = 0; i < 20; i += 1) {
      take({ ...taker(dir), resource: "other", as: `o${i}`, id: `o${i}` });
      free({ dir, resource: "other", as: `o${i}`, id: `o${i}` });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    free({ dir, resource: "heavy", as: "holder", id: "holder" });
    await new Promise((resolve) => child.on("close", resolve));
    wakes = Number(/looks (\d+) true/.exec(out)?.[1]);
    // First look, the look right after the watcher starts, then the wake for the free: 3 reloads (the first look uses `load`).
    assert.ok(wakes <= 4, `the waiter looked ${wakes} times, 20 other-resource takes included`);
  });
});

describe("watch off and watch faults", () => {
  it("watch off: with the watcher disabled the poll still takes a freed slot, in order", async () => {
    const dir = fresh();
    take({ ...taker(dir), as: "holder", id: "holder" });
    const env = { BEEFY_SLOT_WATCH: "off" };
    const a = waiter(dir, "a", { poll: 1, holdMs: 100, env });
    await waitFor(() => ticketCount(dir) === 1 && a.lines.includes("waiting"), "a in line");
    const b = waiter(dir, "b", { poll: 1, env });
    await waitFor(() => ticketCount(dir) === 2 && b.lines.includes("waiting"), "b in line");
    free({ dir, resource: "heavy", as: "holder", id: "holder" });
    await Promise.all([a.done, b.done]);
    assert.ok(a.stamp("taken") !== null && b.stamp("taken") !== null, `${a.lines} ${b.lines}`);
    assert.ok(a.stamp("taken") < b.stamp("taken"), "a goes first");
    assert.ok(a.stamp("freeing") <= b.stamp("taken"), "b waits for a to free");
  });

  it("a watcher that throws leaves the poll to serve", () => {
    const dir = fresh();
    take({ ...taker(dir), as: "holder", id: "holder" });
    let polls = 0;
    const result = take({
      ...taker(dir, { reload: () => (polls += 1, 0) }), as: "w", wait: 1, pollSeconds: 0.05,
      waker: () => {
        // Free the slot from inside the first wait.
        free({ dir, resource: "heavy", as: "holder", id: "holder" });
        throw new Error("watch failed");
      },
    });
    assert.equal(result.ok, true);
    assert.equal(holder(dir, "heavy").as, "w");
    rmSync(dir, { recursive: true, force: true });
  });

  it("dropped events: a watcher that never fires still gets the take on the poll, in order", () => {
    const dir = fresh();
    take({ ...taker(dir), as: "holder", id: "holder" });
    const waits = [];
    const deaf = () => ({
      seen: () => 0,
      // Sleeps the whole step like a watcher that hears nothing; the slot frees on the third wait.
      wait: (ms) => {
        waits.push(ms);
        if (waits.length === 3) free({ dir, resource: "heavy", as: "holder", id: "holder" });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      },
      close: () => {},
    });
    const started = Date.now();
    const result = take({ ...taker(dir), as: "w", wait: 1, pollSeconds: 0.1, waker: deaf });
    assert.equal(result.ok, true);
    assert.ok(waits.length >= 3 && waits.every((ms) => ms === 100), `looked again each poll: ${waits.length} waits`);
    assert.ok(Date.now() - started < 5000);
  });

  it("a watcher that cannot start (null) leaves the poll to serve", () => {
    const dir = fresh();
    take({ ...taker(dir), as: "holder", id: "holder" });
    let looks = 0;
    const result = take({ ...taker(dir, { reload: () => { looks += 1; if (looks === 2) free({ dir, resource: "heavy", as: "holder", id: "holder" }); return 0; } }), as: "w", wait: 1, pollSeconds: 0.05, waker: () => null });
    assert.equal(result.ok, true);
  });

  it("a wait with an injected sleep never starts a watcher", () => {
    const dir = fresh();
    take({ ...taker(dir), as: "holder", id: "holder" });
    const result = take({ ...taker(dir), as: "w", wait: 1, pollSeconds: 20, sleep: () => free({ dir, resource: "heavy", as: "holder", id: "holder" }), waker: () => assert.fail("watched") });
    assert.equal(result.ok, true);
  });
});
