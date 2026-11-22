# beefy-slot

A queue for heavy jobs on one machine, so parallel builds, tests and agents take turns instead of piling on.

## Who it's for

You run several heavy jobs at once on one computer: builds, test suites, simulators, or agents that
each start their own. The machine slows down and timing-sensitive runs turn flaky.

`beefy-slot` is a queue with a set number of slots. A job takes a slot, runs, and frees it. When all
slots are taken, or the machine's load is high, the next job joins the queue and waits its turn, or
is told to come back later. Waiting jobs are served first come, first served.

Next to the tools you may already use:

- `flock` guards one file on one shell. `beefy-slot` also checks machine load, allows more than one
  slot, shows who holds what, and frees a slot when its holder dies.
- A CI `concurrency` group queues runs of one workflow on the CI service. `beefy-slot` queues work
  on your own machine, from any script or terminal.

## Install

Needs Node 22 or newer. macOS and Linux.

```sh
npm i -g beefy-slot
```

A global install puts `beefy` on your PATH, and the examples below use it. To add it to one project
instead, run `npm i -D beefy-slot`, then start it with `npx beefy-slot npm test` or `pnpm exec beefy npm test`.
To try it without installing anything, run `npx beefy-slot npm test`.

`beefy` and `beefy-slot` are the same program under two names. An unrelated npm package is also called
`beefy` (a browserify dev server). Do not run `npx beefy` unless this package is installed in the
project: npx would download the other one. If that other package is installed globally, npm
refuses to link ours over it, so remove one or use the name `beefy-slot`.

## Quickstart

Put `beefy` in front of the command you want to run:

```sh
beefy npm test
```

`beefy` joins the line for the `heavy` pool and starts your command the moment a slot is free. It
waits as long as it takes, runs your command with its output on your terminal, and exits with your
command's exit code, so a script or a CI step behaves as if you had run the command alone. While it
waits, it prints one line, such as `waiting: 2 ahead on heavy`.

To hand a job over and get your terminal back, add `-d`. It prints a job id and returns at once:

```sh
beefy -d npm run e2e
```

```
a1b2c3
```

The job waits its turn, runs in the background, and keeps its output and exit code. Use the id to
look in on it. Replace `<id>` with the id `-d` printed; `beefy jobs` lists every id:

```sh
beefy jobs
beefy log <id>
beefy cancel <id>
```

See who holds a slot and who is in line:

```sh
beefy status
```

```
beefy-slot 0.4.1 · folder ~/.beefy-slot/locks · judge none
heavy: run:48213 until 2026-11-21T01:36:09.277Z
```

`status` with nothing held prints `no locks held`. The folder is printed as a full path.

To see the queue on a terminal, run `beefy` with nothing after it. See The queue screen below.

## Running a command

```
beefy [-d] [--on <resource>] [--wait <min>] [--as <who>] [--] <command...>
```

- `beefy <command...>` queues on `heavy` and runs the command. It has no timeout: it waits until a
  slot is free and the machine's load is under the limit, and it serves waiting jobs first come, first
  served. `--on <resource>` queues on another resource instead, such as `ci`.
- **The foreground is the default.** The command's output goes to your terminal and `beefy` exits with
  the command's exit code. The command gets no stdin: `beefy` closes it, and says so if you pipe text in.
- **`-d` runs it in the background.** It prints a job id and returns. The command's output goes to a log
  file, and `beefy jobs` shows its state and exit code. See Background jobs below.
- **The process is the lease.** There is no time limit on the slot. It stays held while the command
  lives and is free the moment the command ends, and the next job in line starts at once. There is no
  daemon: each job's own `beefy` process watches its command.
- **Stopping it stops the command.** `kill` on `beefy` (SIGTERM, SIGINT or SIGHUP) passes the signal on
  to the command and its children, and the slot frees only after they are gone. If `beefy` is killed
  outright (SIGKILL), a small guard process stops the command first, then frees the slot. On a
  terminal, Ctrl-C goes to the command as it would without `beefy`.
- **`--wait <min>` caps the wait.** Give it 0 to 240 minutes. A command that still has no slot when
  the cap ends does not run, and `beefy` exits 75. With `--wait 0`, a busy slot turns it away at once.
- `--as <who>` names the holder shown in `status`. The default is `run:<pid>`.
- If a config names a judge, it looks at the command first, as it does for `run`. A refused command
  never joins the line (exit 1), and with `-d` it never becomes a job.
- If a command started by `beefy` runs `beefy` again on the same resource, the inner one starts at
  once. It does not wait on its parent.
- If your command has the same name as a `beefy` command, such as `status`, `log` or `jobs`, put `--`
  before it so `beefy` runs it as your command:

```sh
beefy -- status
```

A foreground run has no job record and no saved log. It shows on the queue screen and in `status`, not
in `beefy jobs`.

When the machine's load is over its limit, the waiting line says so and names the busiest process, for
example `waiting: load 9.4 over 8.0 (busiest: node)`. See Load limit below.

## Background jobs

```
beefy -d [--on <resource>] [--wait <min>] [--as <who>] [--] <command...>
beefy jobs [--json]
beefy log <id> [-f]
beefy cancel <id>
```

- `beefy -d` prints an id (six characters: digits and the letters a to f) and returns at once. It starts a
  background wrapper process in its own process group, so closing your terminal does not stop the job.
  The wrapper waits its turn, runs the command in the folder and with the environment you started it
  from, and writes the command's output to a log. The command gets no stdin.
- `beefy jobs` lists running jobs first, then waiting ones, then the finished ones, newest first. A
  job is `waiting`, `running`, `done`, `failed` (the command exited non-zero, shown as `failed (exit 3)`), `cancelled`, or
  `lost` (its wrapper died without recording an end). `--json` prints the records as one JSON array.
- `beefy log <id>` prints the job's output so far. `-f` keeps following it and returns when the job
  ends.
- `beefy cancel <id>` stops a waiting or a running job. A waiting job leaves the line and never runs.
  A running job's command and everything it started get SIGTERM, and SIGKILL after 10 seconds if they
  are still there. The slot frees after they are gone. `cancel` exits 1 for an id it does not know
  and for a job that has already ended.
- A job's record and log live in the `jobs` folder inside the lock folder, as `<id>.json` and
  `<id>.log`. The 50 most recent finished jobs are kept; older ones are removed when a job is added or
  ends. A waiting or running job is never removed.

```sh
beefy -d --as nightly npm test
beefy log <id> -f
beefy jobs --json
```

## The queue screen

Run `beefy` with nothing after it on a terminal to open the queue screen. It shows the jobs running
on `heavy` with the free slots beside them, then the jobs waiting in line, then the recent finished
jobs. When a job waits only because the load is over the limit, the screen says so and names the
busiest process. A failed job shows the last lines of its log. Foreground runs show up too, named by
their process id, and they have no saved output.

- **Select:** `↑` `↓`, `w` `s`, or `k` `j`. You can also click a row.
- **Cancel:** `x` asks first. Press `y` to cancel the job, or `n` or `esc` to keep it. It works on a
  foreground run too, which stops its command and frees the slot.
- **Log:** `l` or `enter` opens the job's log. `f` follows the end or stops following. `esc` goes back.
- **Settings:** `tab` switches between the queue and the settings screen. `?` lists the keys, and `q`
  quits.

`beefy config` opens the settings screen straight away (see The settings screen below). In a script or a
pipe, a bare `beefy` prints usage and exits 2.

## Advanced

Everything above is for jobs you hand to `beefy`. The commands in this section keep the behavior they
had before `beefy <command>` existed, so existing scripts keep working. They do not wait unless you pass
`--wait`, and a busy slot exits 75. Use them when you need to hold a slot across several steps
(`take`), tie a slot to a long-lived process (`--worker`), or control the lease yourself.

### Take and free by hand

Take a slot, do the work, free the slot:

```sh
beefy-slot take heavy --as my-build
npm run build
beefy-slot free heavy --as my-build
```

`take` exits 0 when it has the slot and 75 when the pool is busy. Add `--wait 10` to join the queue for up
to 10 minutes instead of failing at once.

Or let `run` do all three steps. It frees the slot when the command ends, even if the command fails:

```sh
beefy-slot run heavy --wait 10 -- npm test
```

### Lock commands

```
beefy-slot take <resource> --as <who> [--ttl <minutes>] [--slots <n>] [--wait <minutes>] [--worker <pid>] [--ignore-load --reason <why>]
beefy-slot free <resource> --as <who>
beefy-slot status [<resource>] [--json]
beefy-slot waive <resource> --as <who> --reason <why> [--ttl <minutes>]
beefy-slot run <resource> [--as <who>] [--ttl <minutes>] [--slots <n>] [--wait <minutes>] [--ignore-load --reason <why>] -- <command…>
beefy-slot perf take --as <who> [--wait <minutes>] [--ttl <minutes>] | free --as <who> | status | waive --as <who> --reason <why>
beefy-slot config [check [--strict] | show | preset <name> [--write]]
beefy-slot -- <command…>   run a command even when its name is a verb
beefy-slot --version
beefy-slot --help
```

- A resource name is up to 64 characters: letters, digits, `.`, `_`, `:`, `-`, starting with a letter or digit.
- `heavy` is the pool for heavy jobs. Its size is `heavySlots`; there is no `--slots` flag for it.
  Any other resource name is its own lock with one holder, or `--slots <n>` holders (1 to 16).
- `--as` names the holder. Only that name can free its slot. `run` defaults to `run:<pid>`.
- `--ttl` is how many minutes a `take` lasts (default 60). A `run` renews its slot every 30 seconds
  while its command lives; `--ttl` sets a hard end for the run. `beefy <command>` sets no `--ttl`.
- `--wait` is minutes to queue, 0 to 240 (default 0). Waiters are served first come, first
  served. A waiter looks when the lock folder changes, and every 20 seconds as a backup. See Waiting in
  line below.
- Load limit: `take` and `run` refuse when the 1-minute load average is above the limit. The limit is
  the larger of 3 and one per CPU core. The refusal names the busiest process. `beefy <command>` waits
  for the load to drop instead of refusing.
- `waive` excuses the load limit for one holder on one resource, 30 minutes by default and 120 at most.
  It never opens a full pool. `--ignore-load --reason <why>` does the same for one take. Both are
  logged in `waivers.log` in the lock folder.
- `--worker <pid>` ties a `take` to a process: the slot lasts while that process does, not for `--ttl`.
  See Admission for CI jobs below.
- `perf` is a separate single-holder queue with its own, lower load limit, for runs that measure
  timings. It takes no `--slots` or `--ignore-load`. With `perfHost` set it runs on that host over `ssh`
  (needs `ssh` and `node` there).
- `run` gives its command no stdin and sets `BEEFY_SLOT_LOCK_HELD` for it. If a command started by `run` runs `beefy-slot run` on the same resource, the inner one starts at once.
  It does not wait on its parent.
- `beefy` is the same program as `beefy-slot`, so every command here also works as `beefy take`,
  `beefy run`, and so on.

## Config

Optional. The settings describe the machine, so they live in one file for the machine:
`~/.beefy-slot/config.json`. Every project and terminal on the machine reads it. Edit it by hand, or
run `beefy-slot config` (below).

```json
{
  "lockDir": "~/.beefy-slot/locks",
  "heavySlots": 1,
  "loadMax": 8,
  "perfHost": "",
  "perfLoadMax": 1.5,
  "pollSeconds": 20,
  "heartbeatSeconds": 30,
  "judge": "~/judges/judge.mjs",
  "resources": { "ci": { "slots": 4, "loadGate": false } }
}
```

| Key | Meaning | Default |
|---|---|---|
| `lockDir` | Folder for lock records: an absolute path, or one starting with `~/` (your home folder). A relative path is refused, since it would be a different folder from every directory. | `~/.beefy-slot/locks` |
| `heavySlots` | Holders the `heavy` pool admits, 1 to 16. | `1` |
| `loadMax` | The load limit for `take` and `run`. Positive number. | larger of 3 and the core count |
| `perfHost` | Host (as `ssh` takes it) that runs `perf` calls. Empty runs them here. | none |
| `perfLoadMax` | Load limit for `perf`. Positive number. | `1.5` |
| `pollSeconds` | Seconds between a waiter's backup looks, up to 600. A waiter also looks when the lock folder changes. | `20` |
| `heartbeatSeconds` | Seconds between a `run`'s renewals, up to 60. | `30` |
| `judge` | Command judge for `run` (below). A full path, a path under `~/`, or a package name. | none |
| `resources` | Named resources the machine sizes, as `{ "<name>": { "slots": 1 to 16, "loadGate": true or false } }`. Both fields are optional. `heavy` and `perf` are reserved and cannot appear. | none |

The file is plain JSON, so reading it runs no code. It is strict: an unknown key, a wrong type, or a
slot count outside 1 to 16 makes `take`, `run`, `waive`, and `free` exit 2 and name the file and key.
`status` still works and prints the error. There is no `--config` flag.

### Project files

A `beefy-slot.json` in a project is still read: `beefy-slot` looks in the current folder, then each
parent, and stops at the first folder that holds `.git`. It takes the same keys, except that its
`judge` is a path inside the project's folder or a package name. The machine file wins key by key.
A project file that sets machine keys can split a machine (two projects, two `lockDir`s), so new
settings belong in the machine file. `beefy-slot config check` names every key a project file still sets.

### The settings screen

```sh
beefy config
```

On a terminal this opens the settings screen over the machine file. It is also the second tab of the
queue screen: press `tab` there. It has five sections:

- **Slots**: `heavy` and each named resource, drawn as slots with their live holders and the jobs
  waiting behind them. Change slot counts and load limits, add and remove resources, apply a preset.
- **Load**: the load against the limit, the busiest process, whether a new job of each resource
  would start right now, and `loadMax`, `pollSeconds` and `heartbeatSeconds`.
- **Perf host**: `perfHost` and `perfLoadMax`, and a probe that reaches the host over `ssh`.
- **Command rules**: the judge, and a line to try a command against it. It runs only a judge already saved in your machine file; a judge from a project file, or one you have typed, copied with `m` or not yet saved, is never loaded here (save it first; `run` loads a project's).
- **Sources**: `lockDir`, where each value comes from, the findings of `config check`, and the
  changes not yet saved. `m` copies in settings a project file still sets.

Nothing is written until you press `S` (or Ctrl-S). The screen will not save over a machine file it cannot read
(it says so and leaves the file alone), or one that changed on disk since the screen read it. A key this
version does not know is kept, and `x` on its row in Sources removes it. Move with the arrows, `w a s d` or the vim keys `h j k l`;
`1` to `5`, `[` and `]` change section. A section, a row, a preset, and any key named on screen can be clicked.
`?` lists the keys. The screen is drawn dark on white, whatever the terminal's theme; `NO_COLOR`
turns the colours off. A cow walks by now and then, and `c` calls her; `BEEFY_SLOT_NO_COW=1` keeps
her from coming on her own. Without a terminal, `beefy config`
prints what `config show` does.

- `config show` prints each setting, its value, and where it comes from: `default`, `machine file`,
  `project file`, or `env <NAME>`.
- `config check` prints findings as `ok`, `warn` or `error` lines: a file that does not read, a
  variable whose value is ignored, a lock folder that cannot make hard links, a pre-rename lock folder
  that still holds live records, a machine-file judge that does not load. A project file's judge is not
  loaded (that would run the repo's code just for looking at its settings), and `config check` says so. It exits 2 on an error, and on a warning
  with `--strict`; else 0. In an existing lock folder it makes and removes two empty probe files.
- `config preset <name>` prints the machine file with a preset laid over it, and saves it with
  `--write`. The presets are sized from the core count: `laptop` (one heavy job), `ci-box` (a quarter
  of the cores as heavy jobs, and a `ci` pool of half the cores with no load limit), `perf-rig` (one
  heavy job, a load limit of half the cores, a perf limit of 1).

## Waiting in line

A `take` or `run` with `--wait` that is turned away joins the line: it writes a ticket in `tickets/` under the lock
folder and removes it when its wait ends. Takes are served in ticket order: a later take, waiting or
not, is turned away with exit 75 while the open slots do not reach past the line ahead of it.
`status` lists the line, and `status --json` prints the load and, for each resource, its slot count,
load limit, holders and waiters.

- A ticket counts while its waiter's process lives and its lease has not run out. The waiter renews the
  lease at each look; it lasts 60 seconds, or three looks when that is longer.
- A waiter that has a slot open to it and still cannot take it (the load is over the limit, or its
  `--slots` cannot share with a holder) steps aside, so the takes behind it are not held up.
- A take that refreshes a slot it already holds is never in line.
- `perf` over `ssh` does its waiting on the caller's side and takes no ticket.
- A `beefy-slot` older than 0.3.0 on the same machine does not read tickets and can take a slot out of turn.

## Admission for CI jobs

A CI job is a long-lived process (a runner's worker) that asks for a slot once and does not stay
around to free it. Four features cover that. They arrived in 0.2.0. Records from 0.1.0 still
read, and 0.1.0 reads these records as live holders.

**A slot that lives while a worker does.** `take <resource> --as <who> --worker <pid>` ties the slot
to that process. A worker is told from a later process that reuses its number by three things
recorded with the slot: the process ID, its start time, and the boot ID of the machine. When the
worker exits, the slot is free at once, with no wait for a TTL. `take` starts a small keeper process
that renews the slot after `take` itself exits, so the hook that took it can end. `--ttl` is then
an upper bound on how long the keeper renews. `status` shows `(worker <pid>)` next to the holder.

```sh
beefy-slot take ci --as runner-3 --worker "$WORKER_PID" --wait 30
```

A waiting `take --worker` looks at its worker every 5 seconds at most (it also looks for a free slot
then) and exits 1 once the worker is gone, without taking a slot. A worker that is not running when
`take` starts is refused with exit 1. `--worker` is for `take` only, and `perf` does not accept it.

**A take by the same `--as` never reclaims a live record.** The same worker asking again refreshes its
own record, as a retry does. A different worker (or none) under the same `--as` is turned away while
the record's worker lives, and replaces the record once its worker is gone.

**A slot count from the file.** A named resource's `slots` is read from the config file on every
call, and `--slots` is refused for it (exit 2). Raising the count takes effect on a busy machine: the
next `take` uses the new count whatever count the current holders took it with.

**No load limit.** `"loadGate": false` on a resource makes `take` and `run` admit at any load, so a
CI pool never waits on the load its own jobs make. A `heavy` take from inside a job keeps the load
limit.

```json
{ "resources": { "ci": { "slots": 4, "loadGate": false } } }
```

Worker identity needs `/proc` on Linux, or `ps` and `sysctl` on macOS.

## Environment

Environment variables win over the config file. A value that is not valid is ignored.
The old `CHUTE_BOSS_` name of each variable still works; see Upgrading from chute-boss.

| Variable | Overrides | Default |
|---|---|---|
| `BEEFY_SLOT_LOCK_DIR` | `lockDir` | `~/.beefy-slot/locks` |
| `BEEFY_SLOT_HEAVY_SLOTS` | `heavySlots` | `1` |
| `BEEFY_SLOT_LOAD_MAX` | `loadMax` | larger of 3 and the core count |
| `BEEFY_SLOT_PERF_LOAD_MAX` | `perfLoadMax` | `1.5` |
| `BEEFY_SLOT_PERF_HOST` | `perfHost` | none |
| `BEEFY_SLOT_LOCK_POLL_SECONDS` | `pollSeconds` | `20` |
| `BEEFY_SLOT_LOCK_HEARTBEAT_SECONDS` | `heartbeatSeconds` | `30` |
| `BEEFY_SLOT_LOCK_HELD` | set by `run` and `beefy` for their command; do not set it by hand | none |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done. |
| 1 | Refused: `free` by someone who is not the holder, the judge stopped a `run` or `beefy` command, a `--worker` is not running, or `log` or `cancel` has no such job. |
| 2 | Usage error or bad config. A bare `beefy` with no terminal is a usage error. |
| 75 | Busy: no free slot, or load above the limit. Try later. `beefy <command>` returns it only when `--wait` ran out. |

`run` and `beefy <command>` return the exit code of their command once it starts. A command that itself
exits 1, 2, or 75 looks the same as a refusal, so check stderr when it matters. `beefy -d` returns 0 once
the job is recorded; the command's own exit code is in `beefy jobs`.

## Safety model

- Locks are advisory. They stop only jobs that ask. A script that never calls `beefy-slot` is not stopped.
- The judge is a seatbelt, not a sandbox. If a config names a `judge`, `run` and `beefy <command>` ask it
  about the exact command before taking a slot. A deny, an ask, a crash, a timeout, or a missing module refuses the run
  with exit 1. It sees only the command line `run` is about to start; it does not limit what that
  program does afterward.
- No judge unless a config names one: with no `judge` in the machine file, and none in a project's
  `beefy-slot.json` between the current folder and the first `.git` folder above it, every `run` is
  allowed. `status` says `judge none` when that is so. A judge in the machine file covers every `run`
  on the machine, in a repo or not.
- A judge is a module that exports a synchronous `judge(command, { argv, cwd })` and returns `null` to
  allow, or `{ decision: "deny" | "ask", reason }`. It may export `timeoutMs` (1 to 10000, default 2000).

## Known limits

- One machine. Records live in a local folder. Do not point `lockDir` at a network share.
- macOS and Linux. Windows is not supported.
- The lock folder must allow hard links. A lock is created by hard-linking a finished record into
  place, so it exists whole or not at all. On a file system without hard links (some network and
  FAT-style mounts), `take` stops with `could not create a lock in <folder>` and exits 1. The same error
  can mean you lack permission to write there. Set `lockDir` to a local disk.
- A waiter looks when the lock folder changes, so a freed slot goes to the first in line within a moment.
  On a file system that does not report changes, it falls back to looking every 20 seconds (every 5
  with `--worker`), and a freed slot can sit open that long. A waiter that is stopped but not dead
  holds its place until its lease runs out.
- A worker's slot is renewed by its keeper. If the keeper is killed while the worker lives, the slot is
  free 2 minutes after the last renewal. The worker's pid, start time and boot ID are read from this machine,
  so `--worker` means a process on the machine whose `lockDir` it is.
- A lock file that is not valid JSON, is not an object, or lacks a holder (`as`) or a valid `until`
  time counts as free. `status` hides it, and the next `take` replaces it. A lock file edited by hand
  can therefore be lost. If `lockDir` itself is a file or cannot be read, commands print one line naming
  it and exit 1.
- Killing the `run` or `beefy` process with SIGTERM, SIGINT or SIGHUP passes the signal to its command,
  and the slot frees after the command is gone. SIGKILL cannot be passed on: a small guard process
  then stops the command and frees the slot. A command killed by a signal makes `run` and `beefy`
  exit 128 plus the signal number.
- `beefy jobs`, `log` and `cancel` know only the jobs started with `-d`. You stop a foreground
  `beefy <command>` from its terminal, with `kill`, or with `x` on the queue screen, and its output is
  not saved.
- Ctrl-C stops `run` and its command. The slot may stay held for a moment, but once the `run` process
  is gone, `status` shows it free and the next `take` reuses it. A record also expires 2 minutes after
  its last renewal.
- A plain `take` has no process to watch. Without `run`, it holds the slot until `free` or its `--ttl`
  (60 minutes by default), even if your script dies. Prefer `run` for anything that can crash.
- `free` reads the record, then deletes it, with no re-check in between. If the slot changes hands in
  that moment, the new holder's record can be removed.
- `free` only frees your own slot. A stale record from someone else is cleared by the next `take`.
- These limits are fixed in the code: 16 slots, a `--wait` of at most 240 minutes (`beefy <command>`
  without `--wait` has no limit), and a waiver of at most 120 minutes.

## License

MIT. See [LICENSE](LICENSE).

## Security

Report problems privately. See [SECURITY.md](SECURITY.md).

## Contributing

Bug reports are welcome. Outside pull requests are not accepted yet. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Upgrading from chute-boss

`chute-boss.json` and `CHUTE_BOSS_` variables still work; the new name wins when both are set.

- `run` sets `CHUTE_BOSS_LOCK_HELD` for its command next to `BEEFY_SLOT_LOCK_HELD`, so nested runs see either.
- A machine that has `~/.chute-boss/locks` and no `~/.beefy-slot/locks` keeps using the old folder, so its slots do not split. Move it by renaming the folder, or set `lockDir`.

Moving from 0.2.x to 0.3.0: settings now live in `~/.beefy-slot/config.json`. A `beefy-slot.json` in a
project is still read, and the machine file wins key by key. Run `beefy-slot config check` to see which
keys your project files still set.
