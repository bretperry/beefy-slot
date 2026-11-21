// Live readings for the config screen: how busy each core is, and how full memory is.
// Used by: the config screen's loop.
// Exports: coreTimes, coreLoads, parseMeminfo, parsePsi, parseSysctl, pressureOf, readMemory.
// Reads: /proc/meminfo and /proc/pressure/memory on Linux; runs `sysctl` on macOS. Writes nothing.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus, freemem, platform, totalmem } from "node:os";

const unit = (n) => Math.min(1, Math.max(0, n));

// Each core's counters now: { idle, total } in ms since boot.
export const coreTimes = () => cpus().map(({ times }) => ({ idle: times.idle, total: times.user + times.nice + times.sys + times.idle + times.irq }));

// How busy each core was between two readings, 0 to 1.
export const coreLoads = (before, after) => after.map((now, index) => {
  const was = before[index];
  const total = now.total - (was?.total ?? 0);
  return was && total > 0 ? unit(1 - (now.idle - was.idle) / total) : 0;
});

// A pressure word from how full memory is, for when the system gives none.
export const pressureOf = (used) => (used >= 0.92 ? "critical" : used >= 0.8 ? "warn" : "normal");

// /proc/meminfo → the share of memory in use, or null when it cannot be read.
export const parseMeminfo = (text) => {
  const kb = (name) => Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(text)?.[1]);
  const used = 1 - kb("MemAvailable") / kb("MemTotal");
  return Number.isFinite(used) ? unit(used) : null;
};

// /proc/pressure/memory → a pressure word from the share of the last 10 s some task waited on memory.
export const parsePsi = (text) => {
  const stalled = Number(/^some avg10=([\d.]+)/m.exec(text)?.[1]);
  return Number.isFinite(stalled) ? (stalled >= 10 ? "critical" : stalled >= 1 ? "warn" : "normal") : null;
};

// `sysctl -n kern.memorystatus_level kern.memorystatus_vm_pressure_level` → { used, pressure }, or null.
export const parseSysctl = (text) => {
  const [free, level] = text.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(free)) return null;
  const used = unit((100 - free) / 100);
  return { used, pressure: { 1: "normal", 2: "warn", 4: "critical" }[level] ?? pressureOf(used) };
};

const rough = () => {
  const used = unit(1 - freemem() / totalmem());
  return { used, pressure: pressureOf(used) };
};

// Memory now, as { used: 0 to 1, pressure: "normal" | "warn" | "critical" }. Never rejects.
export const readMemory = () => new Promise((done) => {
  if (platform() === "darwin") {
    execFile("/usr/sbin/sysctl", ["-n", "kern.memorystatus_level", "kern.memorystatus_vm_pressure_level"], { timeout: 2000 }, (error, out) => done((error ? null : parseSysctl(String(out))) ?? rough()));
    return;
  }
  try {
    const used = parseMeminfo(readFileSync("/proc/meminfo", "utf8"));
    let pressure = null;
    try {
      pressure = parsePsi(readFileSync("/proc/pressure/memory", "utf8"));
    } catch {}
    done(used === null ? rough() : { used, pressure: pressure ?? pressureOf(used) });
  } catch {
    done(rough());
  }
});
