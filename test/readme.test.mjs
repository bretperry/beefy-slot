// Runs each command in the README's example code blocks, in a temp project, so the steps cannot rot.
import "./tmpdir.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { BUSY, commandArgv, isCommand } from "../src/index.mjs";

const CLI = fileURLToPath(new URL("../bin/beefy-slot.mjs", import.meta.url));
const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");

// The text under a heading, up to the next heading of the same or a higher level.
const section = (heading) => {
  const level = heading.match(/^#+/)[0].length;
  const after = README.split(new RegExp(`^${heading}$`, "m"))[1];
  assert.ok(after !== undefined, `README has no "${heading}"`);
  return after.split(new RegExp(`^#{1,${level}} `, "m"))[0];
};
// Fenced `sh` blocks in a section, as single commands. Plain (untagged) blocks show syntax or output and are not run.
const shLines = (text) => [...text.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((m) => m[1].split("\n").filter((line) => line.trim()));
const plainBlocks = (text) => [...text.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1]);

// The README's runnable examples, in reading order: the quickstart, the command, background jobs, then the lock commands.
const SECTIONS = ["## Quickstart", "## Running a command", "## Background jobs", "### Take and free by hand"];
const commands = SECTIONS.flatMap((heading) => shLines(section(heading)));

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), "readme-"));
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "beefy-slot.json"), JSON.stringify({ lockDir: join(dir, "locks") }));
  // `e2e` is the slow job the quickstart hands over and cancels; the others end at once.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "node -e 0", test: "node -e 0", e2e: "node -e \"setTimeout(() => {}, 600000)\"" } }));
  // The README says `beefy-slot` and `beefy`; the temp folder's bin stands in for the installed commands.
  const shim = (name, body) => {
    writeFileSync(join(dir, "bin", name), body);
    chmodSync(join(dir, "bin", name), 0o755);
  };
  for (const name of ["beefy-slot", "beefy"]) shim(name, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  // A program named like a verb, for `beefy -- status`.
  shim("status", "#!/bin/sh\necho ran the program, not the verb\n");
  const env = { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, BEEFY_SLOT_LOAD_MAX: "1000000" };
  return { dir, run: (command) => spawnSync("sh", ["-c", command], { cwd: dir, env, encoding: "utf8", timeout: 60_000 }) };
};

describe("README examples", () => {
  it("has commands to run", () => assert.ok(commands.length >= 12, `found ${commands.length}`));

  it("leads with beefy <command> and -d, and keeps the lock commands for Advanced", () => {
    const quickstart = shLines(section("## Quickstart"));
    assert.match(quickstart[0], /^beefy \S/);
    assert.ok(!/^beefy(-slot)? (take|free|run|waive|perf)\b/.test(quickstart[0]), "the first example is not a lock command");
    assert.ok(quickstart.some((line) => /^beefy -d /.test(line)), "the quickstart shows -d");
    const before = README.slice(0, README.indexOf("\n## Advanced\n"));
    assert.ok(before.length > 0, "README has an Advanced section");
    assert.ok(!/^beefy-slot (take|free|run|waive|perf) /m.test(before), "no lock command is shown before Advanced");
    assert.ok(quickstart.findIndex((line) => /^beefy -d /.test(line)) < quickstart.findIndex((line) => /<id>/.test(line)), "an id is used only after -d printed one");
  });

  it("runs each example in a temp folder, in order", () => {
    const { run } = project();
    let id = null;
    try {
      for (const command of commands) {
        const line = command.replaceAll("<id>", id ?? "<id>");
        assert.ok(id !== null || !command.includes("<id>"), `${command} needs an id, but no -d example came before it`);
        const result = run(line);
        assert.equal(result.status, 0, `${line}\n${result.stdout}${result.stderr}`);
        // `beefy -d …` prints the job id on stdout, and the examples after it use it.
        if (/^beefy -d /.test(command)) {
          id = result.stdout.trim();
          assert.match(id, /^[0-9a-f]{6}$/, `${command} printed ${JSON.stringify(result.stdout)}`);
        }
        if (command === "beefy -- status") assert.match(result.stdout, /ran the program/);
      }
    } finally {
      // Whatever failed above, no job outlives the test.
      const jobs = JSON.parse(run("beefy jobs --json").stdout || "[]");
      for (const job of jobs) if (job.state === "running" || job.state === "waiting") run(`beefy cancel ${job.id}`);
    }
  });

  it("shows only verbs and flags the CLI knows in the syntax lines", () => {
    const syntax = [...plainBlocks(section("## Running a command")), ...plainBlocks(section("## Background jobs"))].flatMap((block) => block.split("\n").filter((line) => /^beefy /.test(line)));
    assert.ok(syntax.length >= 4, `found ${syntax.length} syntax lines`);
    for (const line of syntax) {
      const word = line.split(/\s+/)[1];
      if (["jobs", "log", "cancel"].includes(word)) assert.ok(!isCommand([word]), `${word} is a verb`);
      else for (const flag of ["--on", "--wait", "--as"]) assert.ok(line.includes(`[${flag} `), `${line} names ${flag}`);
    }
    // The command form the syntax lines show: -d, --on, --wait and --as, then `--` and the command.
    assert.deepEqual(commandArgv(["-d", "--on", "ci", "--wait", "5", "--as", "me", "--", "echo", "hi"]), { argv: ["run", "ci", "--wait", "5", "--as", "me", "--", "echo", "hi"], uncapped: false, detach: true });
    assert.deepEqual(commandArgv(["echo", "hi"]), { argv: ["run", "heavy", "--", "echo", "hi"], uncapped: true, detach: false });
    assert.ok(isCommand(["--", "status"]) && commandArgv(["--", "status"]).argv.at(-1) === "status", "`--` forces a command");
    assert.ok(!isCommand(["status"]), "a bare verb is a verb");
  });

  it("prints usage and exits 2 for a bare beefy without a terminal, as the README says", () => {
    const { run } = project();
    const result = run("beefy </dev/null");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^usage: beefy-slot/);
  });

  it("prints help to stdout and exits 0, listing every lock command in the README", () => {
    const result = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    // The README's Lock commands block, one command per line, without the leading `beefy-slot `.
    const block = plainBlocks(section("### Lock commands"))[0];
    const listed = block.split("\n").filter((line) => line.trim()).map((line) => line.replace(/^beefy-slot /, ""));
    assert.ok(listed.length >= 7, `found ${listed.length} commands`);
    // The README spells `<min>` where --help spells `<minutes>`; --help itself is not a line of its own in --help.
    const normal = (text) => text.replace(/<minutes>/g, "<min>").replace(/…/g, "...").replace(/\s+/g, " ").trim();
    const help = result.stdout.split("\n").slice(1).map((line) => normal(line.trim())).filter(Boolean);
    for (const line of listed.filter((entry) => entry !== "--help").map(normal)) assert.ok(help.includes(line), `--help lists: ${line}`);
    assert.ok(listed.includes("--help"), "the README lists --help");
  });

  it("returns the exit codes the README states", () => {
    const rows = [...section("## Exit codes").matchAll(/^\| (\d+) \| (.*) \|$/gm)].map((m) => ({ code: Number(m[1]), meaning: m[2] }));
    const stated = (word) => rows.find((row) => new RegExp(`^${word}`).test(row.meaning))?.code;
    const dir = mkdtempSync(join(tmpdir(), "readme-codes-"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "beefy-slot.json"), JSON.stringify({ lockDir: join(dir, "locks") }));
    const env = { ...process.env, BEEFY_SLOT_LOAD_MAX: "1000000" };
    const code = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env, encoding: "utf8" }).status;
    assert.equal(rows.length, 4, "four rows: done, refused, usage error, busy");
    assert.equal(code("take", "heavy", "--as", "a"), stated("Done"));
    assert.equal(code("take", "heavy", "--as", "b"), stated("Busy"), "pool busy");
    assert.equal(code("--wait", "0", "node", "-e", "0"), stated("Busy"), "beefy <command> with --wait 0 on a busy pool");
    assert.equal(code("free", "heavy", "--as", "b"), stated("Refused"), "free by a non-holder");
    assert.equal(code("log", "abcdef"), stated("Refused"), "log of a job that does not exist");
    assert.equal(code("cancel", "abcdef"), stated("Refused"), "cancel of a job that does not exist");
    assert.equal(code("take", "heavy"), stated("Usage error"), "usage error");
    assert.equal(code("free", "heavy", "--as", "a"), stated("Done"));
    assert.equal(code("node", "-e", "process.exit(3)"), 3, "beefy <command> returns its command's exit code");
    assert.equal(stated("Busy"), BUSY, "the busy code the source exports");
  });
});
