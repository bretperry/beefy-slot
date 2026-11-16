/*
  The package imports only itself and Node builtins; the transported core imports builtins alone.
  Used by: node:test.
  Uses: the package's source files, walked from the bin and programmatic entry points.
*/
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

it("walks every package import without crossing its boundary or adding a dependency", () => {
  const seen = new Set();
  const walk = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const text = readFileSync(path, "utf8");
    const imports = [...text.matchAll(/(?:\b(?:import|export)\s+(?:[^;]*?\s+from\s*)?|\bimport\s*\()\s*["']([^"']+)["']/g)].map((match) => match[1]);
    for (const spec of imports) {
      if (spec.startsWith("node:")) continue;
      assert.notEqual(path, resolve(ROOT, "src/beefy-slot.mjs"), `transported core imports ${spec}`);
      assert.ok(spec.startsWith("."), `non-builtin dependency: ${spec}`);
      const target = resolve(dirname(path), spec);
      assert.ok(!relative(ROOT, target).startsWith(`..${sep}`), `outside package: ${spec}`);
      walk(target);
    }
  };
  walk(resolve(ROOT, "bin/beefy-slot.mjs"));
  walk(resolve(ROOT, "src/index.mjs"));
  for (const folder of ["src", "bin"]) {
    for (const name of readdirSync(resolve(ROOT, folder))) assert.ok(seen.has(resolve(ROOT, folder, name)), `unwalked file: ${folder}/${name}`);
  }
});
