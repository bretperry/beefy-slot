// The live readings: core loads between two samples, and memory from each system's own numbers.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { coreLoads, coreTimes, parseMeminfo, parsePsi, parseSysctl, pressureOf, readMemory } from "../src/vitals.mjs";

describe("vitals", () => {
  it("turns two readings of the cores into how busy each was", () => {
    const before = [{ idle: 100, total: 200 }, { idle: 50, total: 100 }, { idle: 0, total: 0 }];
    const after = [{ idle: 150, total: 300 }, { idle: 50, total: 200 }, { idle: 0, total: 0 }, { idle: 5, total: 10 }];
    assert.deepEqual(coreLoads(before, after), [0.5, 1, 0, 0]);
    assert.equal(coreLoads(coreTimes(), coreTimes()).every((share) => share >= 0 && share <= 1), true);
  });

  it("reads memory from meminfo, pressure files and sysctl", () => {
    assert.equal(parseMeminfo("MemTotal:       16000 kB\nMemFree:  100 kB\nMemAvailable:    4000 kB\n"), 0.75);
    assert.equal(parseMeminfo("nothing"), null);
    assert.equal(parsePsi("some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00"), "normal");
    assert.equal(parsePsi("some avg10=4.20 avg60=1.00"), "warn");
    assert.equal(parsePsi("some avg10=31.00 avg60=1.00"), "critical");
    assert.equal(parsePsi(""), null);
    assert.deepEqual(parseSysctl("68\n1\n"), { used: 0.32, pressure: "normal" });
    assert.deepEqual(parseSysctl("10\n4\n"), { used: 0.9, pressure: "critical" });
    assert.equal(parseSysctl("5\n").pressure, "critical", "no level: judged from how full it is");
    assert.equal(parseSysctl("sysctl: unknown oid"), null);
    assert.deepEqual([pressureOf(0.5), pressureOf(0.85), pressureOf(0.95)], ["normal", "warn", "critical"]);
  });

  it("reads this machine's memory", async () => {
    const mem = await readMemory();
    assert.ok(mem.used >= 0 && mem.used <= 1);
    assert.match(mem.pressure, /^(normal|warn|critical)$/);
  });
});
