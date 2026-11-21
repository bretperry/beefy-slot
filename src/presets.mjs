// Starting points for a machine's config, sized from its core count.
// Used by: `beefy-slot config preset` and the config screen.
// Exports: PRESETS (name → what it is for), preset (apply one to a config).

import { availableParallelism } from "node:os";

const clamp = (n, low, high) => Math.min(high, Math.max(low, n));

// Why these sizes. laptop: one heavy job is what keeps a machine someone is typing on usable.
// ci-box: a quarter of the cores as heavy jobs leaves each several cores; its `ci` pool admits a runner
// per two cores and takes no load limit, because the load on a CI box is its own jobs.
// perf-rig: timings move when anything else runs, so one heavy job, a load limit of half the cores, and a
// perf limit of 1.
export const PRESETS = {
  laptop: "one heavy job at a time, the default load limit",
  "ci-box": "several heavy jobs and a `ci` pool with no load limit",
  "perf-rig": "one heavy job and tight load limits, for timing runs",
};

// The config with the preset laid over it, or null for a name that is not a preset. Keys the preset does
// not speak to (lockDir, judge, other resources) are kept.
export const preset = (name, config = {}, cores = availableParallelism()) => {
  const next = { ...config };
  if (name === "laptop") {
    next.heavySlots = 1;
    delete next.loadMax;
  } else if (name === "ci-box") {
    next.heavySlots = clamp(Math.floor(cores / 4), 1, 16);
    delete next.loadMax;
    next.resources = { ...config.resources, ci: { slots: clamp(Math.floor(cores / 2), 1, 16), loadGate: false } };
  } else if (name === "perf-rig") {
    next.heavySlots = 1;
    next.loadMax = Math.max(3, Math.ceil(cores / 2));
    next.perfLoadMax = 1;
  } else return null;
  return next;
};
