// Discover JSON settings without executing code, and reject misspelled or malformed file settings.
// Used by: the bin entry point and embedders.
// Exports: findConfig (walk to the repository boundary), validate (strict file validation).

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const KEYS = ["lockDir", "heavySlots", "perfHost", "perfLoadMax", "judge", "resources"];
const RESOURCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const RESERVED = { heavy: "heavySlots", perf: "perfLoadMax" };

// A named resource's entry: only `slots` (1 to 16) and `loadGate` (false turns the load gate off).
const validateResources = (resources) => {
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) return "resources: expected an object of resource names";
  for (const [name, entry] of Object.entries(resources)) {
    if (!RESOURCE.test(name)) return `resources.${name}: not a resource name`;
    if (Object.hasOwn(RESERVED, name)) return `resources.${name}: ${name} is reserved; ${name === "heavy" ? "its slots are" : "its load line is"} set by ${RESERVED[name]}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return `resources.${name}: expected an object`;
    for (const [key, value] of Object.entries(entry)) {
      if (key === "slots") {
        if (!Number.isInteger(value) || value < 1 || value > 16) return `resources.${name}.slots: expected an integer from 1 to 16`;
      } else if (key === "loadGate") {
        if (typeof value !== "boolean") return `resources.${name}.loadGate: expected true or false`;
      } else return `resources.${name}.${key}: unknown key`;
    }
  }
  return null;
};

// Return the first invalid key's explanation, or null. Code-passed settings do not use this check.
export const validate = (config) => {
  if (!config || typeof config !== "object" || Array.isArray(config)) return "config must be an object";
  for (const [key, value] of Object.entries(config)) {
    if (!KEYS.includes(key)) return `${key}: unknown key`;
    if (key === "resources") {
      const problem = validateResources(value);
      if (problem) return problem;
      continue;
    }
    if (key === "heavySlots") {
      if (!Number.isInteger(value) || value < 1 || value > 16) return `${key}: expected an integer from 1 to 16`;
    } else if (key === "perfLoadMax") {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return `${key}: expected a positive number`;
    } else if (typeof value !== "string" || (key !== "perfHost" && !value)) return `${key}: expected a string${key === "perfHost" ? "" : " that is not empty"}`;
    if (key === "judge" && (isAbsolute(value) || value.includes("\\") || value.split("/").some((part) => part === "..") || value.includes(":"))) return `${key}: expected a path inside the config folder or a package name`;
  }
  return null;
};

// A malformed file throws with its path so callers cannot mistake it for no config.
export const findConfig = (dir) => {
  let folder = resolve(dir);
  for (;;) {
    // beefy-slot.json wins over the old chute-boss.json when a folder holds both.
    const path = [join(folder, "beefy-slot.json"), join(folder, "chute-boss.json")].find((candidate) => existsSync(candidate));
    if (path) {
      let config;
      try {
        config = JSON.parse(readFileSync(path, "utf8"));
      } catch (error) {
        throw new Error(`${path}: ${error.message}`, { cause: error });
      }
      const error = validate(config);
      if (error) throw Object.assign(new Error(`${path}: ${error}`), { found: { path, config } });
      return { path, config };
    }
    const parent = dirname(folder);
    if (existsSync(join(folder, ".git")) || parent === folder) return null;
    folder = parent;
  }
};
