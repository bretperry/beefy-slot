// Waiting takes are served first come, first served: tickets, their lease, stepping aside, and status.
import "./tmpdir.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { free, liveHolders, main, resolveSettings, snapshot, take, waiting } from "../src/beefy-slot.mjs";

const CLI = fileURLToPath(new URL("../bin/beefy-slot.mjs", import.meta.url));
const folder = () => mkdtempSync(join(tmpdir(), "tickets-"));
const NOW = new Date("2026-11-17T12:00:00.000Z");
const later = (seconds) => new Date(NOW.getTime() + seconds * 1000);

// Another waiter's ticket, as its take would have written it. This process stands in for the waiter, so it is alive.
const ticket = (dir, as, { resource = "heavy", at = NOW, lease = 60, pid = process.pid, ...rest } = {}) => {
  mkdirSync(join(dir, "tickets"), { recursive: true });
  writeFileSync(join(dir, "tickets", `${resource}~${as}.json`), JSON.stringify({ resource, as, id: as, at: at.toISOString(), until: new Date(at.getTime() + lease * 1000).toISOString(), pid, ...rest }));
};
const quick = { load: 0, loadMax: 10 };

describe("waiter tickets", () => {
  it("writes a ticket while a take waits and removes it, and the folder, when the wait ends", () => {
    const dir = folder();
    assert.equal(take({ dir, resource: "heavy", as: "holder", now: NOW, ...quick }).ok, true);
    const seen = [];
    const result = take({ dir, resource: "heavy", as: "waiter", wait: 1, pollSeconds: 20, now: NOW, ...quick, reload: () => 0, sleep: () => seen.push(waiting(dir, "heavy", NOW).map((entry) => entry.as)) });
    assert.equal(result.ok, false);
    assert.match(result.reason, /held by holder .*\(waited 1 min\)/);
    assert.deepEqual(seen, [["waiter"], ["waiter"], ["waiter"]]);
    assert.equal(existsSync(join(dir, "tickets")), false);
  });

  it("makes a take with no ticket yield to the takes already waiting", () => {
    const dir = folder();
    ticket(dir, "first");
    const refused = take({ dir, resource: "heavy", as: "newcomer", now: later(1), ...quick });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /1 earlier take is waiting for heavy/);
    assert.deepEqual(liveHolders(dir, "heavy", later(1)), [], "the open slot is left for the first in line");
    assert.equal(take({ dir, resource: "other", as: "newcomer", now: later(1), ...quick }).ok, true, "another resource has its own line");
  });

  it("lets a later take in when the open slots reach past the line", () => {
    const dir = folder();
    ticket(dir, "first");
    assert.equal(take({ dir, resource: "heavy", as: "second", slots: 2, now: later(1), ...quick }).ok, true, "two open, one ahead");
    assert.equal(take({ dir, resource: "heavy", as: "third", slots: 2, now: later(2), ...quick }).ok, false, "one open, one ahead");
  });

  it("serves two waiters in the order they arrived", () => {
    const dir = folder();
    assert.equal(take({ dir, resource: "heavy", as: "holder", now: NOW, ...quick }).ok, true);
    ticket(dir, "early", { at: later(1), lease: 600 });
    let looks = 0;
    // The late waiter looks first after the slot frees, and still does not take it: early is ahead.
    const late = take({ dir, resource: "heavy", as: "late", wait: 1, pollSeconds: 20, now: later(2), ...quick, reload: () => 0, sleep: () => {
      if (++looks === 1) free({ dir, resource: "heavy", as: "holder" });
    } });
    assert.equal(late.ok, false);
    assert.match(late.reason, /1 earlier take is waiting/);
    assert.deepEqual(liveHolders(dir, "heavy", later(3)), []);
  });

  it("does not count a ticket that stepped aside, lapsed, or whose waiter is gone", () => {
    const gone = spawnSync(process.execPath, ["-e", "0"]).pid;
    for (const [name, options] of [["aside", { yield: true }], ["lapsed", { lease: -1 }], ["dead", { pid: gone }]]) {
      const dir = folder();
      ticket(dir, name, options);
      assert.equal(take({ dir, resource: "heavy", as: "newcomer", now: later(1), ...quick }).ok, true, name);
      assert.equal(existsSync(join(dir, "tickets", `heavy~${name}.json`)), name === "aside", `${name}: a take sweeps dead tickets`);
    }
  });

  it("steps aside when a slot is open to it and the load keeps it out", () => {
    const dir = folder();
    const seen = [];
    const result = take({ dir, resource: "heavy", as: "loaded", wait: 1, pollSeconds: 30, now: NOW, load: 99, loadMax: 10, reload: () => 99, sleep: () => seen.push(waiting(dir, "heavy", NOW)[0].yield === true) });
    assert.equal(result.ok, false);
    assert.match(result.reason, /machine is busy/);
    assert.deepEqual(seen, [true, true]);
  });

  it("never holds up a holder refreshing its own slot", () => {
    const dir = folder();
    assert.equal(take({ dir, resource: "heavy", as: "holder", now: NOW, ...quick }).ok, true);
    ticket(dir, "first");
    const again = take({ dir, resource: "heavy", as: "holder", now: later(1), ...quick });
    assert.equal(again.ok, true);
    assert.equal(again.refreshed, true);
  });

  it("shows the line in status and in status --json", () => {
    const dir = folder();
    const settings = resolveSettings({ env: { BEEFY_SLOT_LOCK_DIR: dir }, config: { resources: { ci: { slots: 4, loadGate: false } } }, cores: 8 });
    assert.equal(take({ dir, resource: "heavy", as: "holder", now: NOW, ...quick }).ok, true);
    ticket(dir, "first");
    ticket(dir, "second", { at: later(5) });
    const out = [];
    assert.equal(main(["status"], { settings, now: later(6), out: (text) => out.push(text) }), 0);
    assert.match(out[0], /^heavy: holder until /);
    assert.match(out[0], /\nheavy: waiting, first come first: first since 2026-11-17T12:00:00.000Z, second since /);
    const json = [];
    assert.equal(main(["status", "--json"], { settings, now: later(6), load: 2, out: (text) => json.push(text) }), 0);
    const state = JSON.parse(json[0]);
    assert.equal(state.load, 2);
    assert.deepEqual(state.resources.map((entry) => entry.name), ["heavy", "perf", "ci"]);
    const heavy = state.resources[0];
    assert.deepEqual([heavy.slots, heavy.loadMax, heavy.holders.map((held) => held.as), heavy.waiting.map((entry) => entry.as)], [1, 8, ["holder"], ["first", "second"]]);
    assert.equal(state.resources[2].loadMax, null, "a resource with no load limit");
    assert.deepEqual(snapshot({ dir, settings, now: later(6), only: "ci" }).resources.map((entry) => entry.name), ["ci"]);
    assert.equal(main(["take", "heavy", "--as", "a", "--json"], { settings, err: () => {} }), 2, "--json is for status");
  });

  it("serves real waiting processes in order", async () => {
    const dir = folder();
    const env = { ...process.env, BEEFY_SLOT_LOCK_DIR: dir, BEEFY_SLOT_LOAD_MAX: "1000000", BEEFY_SLOT_LOCK_POLL_SECONDS: "0.2" };
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
    const start = (as) => spawn(process.execPath, [CLI, "take", "heavy", "--as", as, "--wait", "1"], { env, stdio: "ignore" });
    const ended = (child) => new Promise((done) => child.once("exit", done));
    const until = async (test) => {
      for (let i = 0; i < 100 && !test(); i++) await new Promise((done) => setTimeout(done, 100));
      assert.ok(test(), "timed out");
    };
    const line = () => waiting(dir, "heavy").map((entry) => entry.as);
    assert.equal(run("take", "heavy", "--as", "holder").status, 0);
    const first = start("first");
    await until(() => line().length === 1);
    const second = start("second");
    try {
      await until(() => line().length === 2);
      assert.deepEqual(line(), ["first", "second"]);
      assert.equal(run("free", "heavy", "--as", "holder").status, 0);
      assert.equal(await ended(first), 0);
      assert.deepEqual(liveHolders(dir, "heavy").map((held) => held.as), ["first"]);
      assert.deepEqual(line(), ["second"]);
      assert.equal(run("free", "heavy", "--as", "first").status, 0);
      assert.equal(await ended(second), 0);
      assert.deepEqual(readdirSync(dir).sort(), ["heavy.json"], "no ticket or folder is left");
    } finally {
      first.kill();
      second.kill();
    }
  });
});
