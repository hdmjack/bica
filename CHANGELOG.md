# Changelog

Dates are the release date. bica keeps state on the remote that several versions can reach, so
entries note where a change affects what another version sees.

## 0.8.17 — 2026-10-31

### Changed
- **A run's short ssh calls share one connection.** A no-op `bica run true` opened about seventeen
  ssh connections one after another, the lease probes, the rsyncs, the heartbeat and the artifact
  checks, and each paid a full handshake of 0.3 s to 1.2 s. They now reuse one connection per host
  (`ControlMaster=auto`, kept for 60 s after its last use, in a private folder under `/tmp`), and so do
  the rsyncs, through `RSYNC_RSH`. On the same tree against the same host, the no-op took 3.5 to 6.3 s
  where the previous build took 9.6 to 10.4 s. **The command's own connection is not shared**, nor are
  `bica logs --follow` and `bica tunnel`: bica reads a dropped link from that ssh's own debug output,
  which a client on a shared connection does not print, and the command's remote process lives and dies
  with its connection. `BICA_SSH_SHARE=0` turns sharing off, and an `RSYNC_RSH` you set yourself is
  left alone. A master that dies, or leaves its socket behind, is replaced by the next call.

## 0.8.16 — 2026-10-31

### Fixed
- **A file you edited during a live run is no longer listed as one the command wrote.** The live
  session keeps pushing local edits to the remote while the command runs, so those files were newer
  than the run's marker there, and the notice named them: `This command wrote 4 files on the remote`,
  with advice to `--write-back` what was already at home. A live run now leaves out files whose local
  modification time is after its last flush before the command started, which is when the laptop's own
  edits begin to arrive by push. The command's writes are still named, including ones the session has
  already reverted, and `--write-back` and `--detach` runs, which push once, are unchanged.
- **A finished run no longer says it "left a process running" when the process is its own.** The
  heartbeat watcher that ends an abandoned command sits in the run's process group on purpose. When
  the command returned, bica stopped the watcher but not the `sleep` it was in the middle of, which
  outlived it in that group, and the leftovers check blamed the command: `This run left 1 process
  running on mini: 27690 sleep 15`. The `sleep` is ended with the watcher now.

## 0.8.15 — 2026-10-30

### Fixed
- **Ending a sync now removes its Mutagen cache, on the laptop and on the remote.** Mutagen 0.18.1
  keeps `<identifier>_alpha` on the alpha's machine and `<identifier>_beta` on the beta's, in
  `~/.mutagen/caches`, and does not delete either when a session is terminated. Every `bica run`
  started a session, so every run left a pair: about 1,700 files and 3.5 GB on a laptop in a few
  weeks, and the same on the remote. bica reads the session's identifier before it terminates it,
  and once the terminate has succeeded removes those two files here and, over ssh, on the remote.
  The watcher that ends a killed run's sync does the same. It removes only the two files of a session
  it has just ended, never by age, because the remote's cache folder is shared by every machine that
  syncs into it. `MUTAGEN_DATA_DIRECTORY` is honoured on both ends. Caches left by earlier versions are
  not touched.

## 0.8.14 — 2026-10-28

### Fixed
- **The watchers survive whatever kills bica.** 0.8.12 and 0.8.13 start a watcher per run that ends
  its sync and its remote command if bica dies. They were started detached, which is a new process
  group but still bica's child, and an agent's shell tool or a task runner stopping a job kills the
  whole tree of descendants: the watcher died with the run it was watching. A `pnpm typecheck` ran on
  for fourteen minutes that way, holding its workspace. The watchers are now handed to init as they
  start, so nothing that kills bica's tree reaches them.
- **A command whose laptop has gone away is ended on the remote.** Everything else that ends an
  abandoned command runs on the laptop, so a laptop that sleeps, loses its network or is shut does
  none of it. An attached run now refreshes a heartbeat beside its lease every 30 seconds, and each
  leased command runs with a small watcher on the remote that ends its process group once the
  heartbeat has been quiet for eleven minutes, longer than the run's own connection waits before
  giving up, so a network outage it would have survived does not end it. It stops watching as soon as the lease is no longer that
  run's. Detached runs and `bica tunnel` are not watched, and a bica older than this sends no heartbeat
  and so builds scripts without the watcher.
- **A dropped connection now ends the remote command.** When ssh failed mid-run (exit 95), bica kept
  the workspace leased while the command ran to its end with nobody reading it, and disarmed the
  watcher on its way out. It now leaves the watcher armed, so the command is cancelled from a fresh
  connection once bica has exited. If the host cannot be reached at all, the lease is kept as before.

## 0.8.13 — 2026-10-28

### Fixed
- **A run killed outright no longer leaves its command running on the remote.** Ctrl-C and SIGTERM
  already ended the remote command, and `kill -9` could not: the ssh outlived bica, the command ran to
  its end with nobody reading, and the workspace stayed leased the whole time, so other runs met 98.
  Each run now starts a small detached watcher on its own pid. If the run dies without disarming it,
  the watcher sends the same cancel `bica cancel` does, guarded by the run's id so a workspace another
  run has taken since is left alone. A detached run (`--detach`) gets none, since its command is meant
  to outlive the launcher.

## 0.8.12 — 2026-10-28

### Fixed
- **A sync no longer outlives a run that was killed.** A live run ends its Mutagen session in its exit
  hook, and `kill -9`, an out-of-memory kill or a closed terminal skip that hook. The session then went
  on mirroring the checkout into the remote until somebody ran bica from that checkout again: one kept
  watching for twenty minutes after its run died, recreating a workspace folder while it was being
  deleted. Each live run now starts a small detached watcher on its own pid. When the run is gone, the
  watcher ends that run's sessions, keyed on the project id Mutagen makes afresh for every start, so
  a later run from the same checkout is never touched. Any `bica run` or `bica start` also ends
  sessions, from any checkout and into any workspace, whose recorded run is dead.

## 0.8.11 — 2026-10-27

### Fixed
- **Two spellings of one remote folder are one workspace again.** The lease, the install records and
  the run records are named after the remote path as written, so `~/code/x` and
  `/Users/me/code/x` were two workspaces to bica while being one directory on the remote. The second
  spelling usually comes from `BICA_REMOTE_PATH=~/code/x`, which the local shell expands before bica
  sees it. A worktree running that way and the main checkout, whose `.bica/local.yml` kept the `~`,
  each took their own lease and ran in the one directory at once. The worktree's `--write-back` run
  then copied 32 of the other branch's files home over its own. A path under the local home is now
  read as `~/…`, so both take the same lease and the second run is refused with 98.

  **Affects other versions:** a run on an older bica still names the lease after the expanded
  spelling, so it does not see a lease taken by this one. Update every checkout's bica together.

## 0.8.10 — 2026-10-27

### Added
- **`generated.inputs`: rerun the generator when what it is made from changes.** The generated-output
  check only asked whether anything matching `generated.paths` existed, so a set made from last
  week's inputs passed. Master added two icon SVGs without a lockfile change; the remote kept its old
  `Icon*.tsx`, and typecheck failed with TS2307 on the two components nobody generated. List the
  inputs and bica records on the remote what it last generated from, and reruns `generated.command`
  when the local files differ. The first run after adding them regenerates once.

### Fixed
- **The generated-output check runs after an install too.** It used to be skipped whenever the run
  installed, on the assumption that `postinstall` regenerated everything. Whether it did is what the
  check is for.

## 0.8.9 — 2026-10-27

### Fixed
- **A workspace recreated on the remote installs its dependencies again.** The record of what a
  workspace installed lives outside it, in `~/.bica/installs`, so a workspace removed between runs
  left the record behind. A pinned run creates the directory before syncing, which meant the install
  step never saw it as new and never cleared that record: it believed the old install, skipped
  `pnpm install`, and every command failed with `command not found`, reported as an ordinary exit 1.
  The record is now cleared whenever a run creates the workspace, and is only believed while the
  workspace's `node_modules` actually exists, whatever removed it.
- **Several `pnpm` commands no longer print "Multiple package manager plugins match".** One plugin
  matching three commands was counted as three plugins.

## 0.8.8 — 2026-10-25

### Fixed
- **A sync that was not shut down cleanly no longer stops every later run with 94.** Mutagen marks
  a project as running in `.bica/project.yml.lock` and refuses to start it again while the file is
  there, whether or not its sessions are. A run that died without its exit hook left the file, the
  next run ended the leftover session but not the file, and bica took Mutagen's refusal to mean the
  sync was already up: it printed "Remote sync is already running", waited a minute for a session
  that did not exist, and stopped with 94 and advice to check the network and the disk. When the
  project's sessions are gone bica now clears the file and starts the sync.
- **Another checkout's sync into the same workspace is dealt with before a run, not under it.**
  Checkouts that share a remote workspace are kept apart by the lease, but a Mutagen session is
  outside the lease: one left behind by another checkout went on mirroring that checkout's tree into
  the workspace while the next run used it. A `bica run` now records its pid in `.bica/live-run`
  while its sync is up. Before a run or a `bica start`, another checkout's session whose run has
  ended is stopped, and said so. One started with `bica start`, or by a run that is still going, is
  somebody's live sync and is not bica's to end: the run is refused with **98**, with the two ways
  out -- `bica stop` in that checkout, or a `remotePath` of this checkout's own. Sessions from a bica
  older than this carry no marker and are treated as deliberate.

## 0.8.7 — 2026-10-23

### Changed
- **`*.tsbuildinfo` is ignored by default when `dist` is.** bica has warned about the pair since
  0.8.1, and the warning did not get the line written: float-javascript's checkouts printed it before
  every run while a typecheck reported names that exist in no tree, because `dist` belonged to
  whichever checkout sharing the workspace built last and the record of it came from the caller's
  laptop. A bica.yml that ignores `dist` and does not mention tsbuildinfo now gets `"*.tsbuildinfo"`
  added, as a Rust repository gets `target`. A config that mentions it, either way, is left alone.
  `bica doctor` suggests writing it into bica.yml, for teammates on older versions.

  An existing workspace still holds the copies earlier runs sent, and an ignored file is no longer
  deleted by the sync; remove them once (see the README's "Sync ignores and TypeScript `dist/`").

## 0.8.6 — 2026-10-23

### Fixed
- **A `.git` sync that did not complete stops the run.** It was best-effort, so a failed copy
  printed a warning and the commands ran anyway, against a repository with missing refs. From a
  worktree a failed first pass also skipped the overlay of the worktree's own state, so
  `test:run:changed` and `lint:changed` failed on `unknown revision 'origin/master...HEAD'` and
  were reported as ordinary exit 1s. The run now stops before anything runs, with **94**.
- **git's transient files are no longer copied.** Another git process in the same repository
  creates and removes `index.lock` many times a second, and one that vanished mid-copy failed the
  sync with rsync exit 23. `*.lock` and git's temporary pack files are excluded, stale locks an
  earlier sync left on the remote are deleted, a file that vanished (rsync 24) counts as a complete
  copy, and any other failure is retried once before the run is stopped.

## 0.8.5 — 2026-10-23

### Fixed
- **The `--also` watchdog no longer kills healthy commands on a loaded remote.** 0.8.2 gave each
  command a watchdog that reads the connection's pipe and ends the command when it closes. The
  command shared that pipe as its stdin, and so shared its flags, and Node sets `O_NONBLOCK` on a
  pipe it reads. When `pnpm` or `vitest` got there before the watchdog's `cat` reached its `read`,
  `cat` failed with `Resource temporarily unavailable` and the watchdog killed the command. At load
  37 that ordering is likely, and a test run died four seconds in having printed nothing. The
  command now gets `/dev/null` for stdin, and the watchdog retries a failed read instead of taking
  any failure as the connection ending.
- **A command killed by a signal on the remote is reported as such, under 95.** ssh logs
  `Exit status -1` when no status comes back, and bica read any `Exit status` line as the command
  answering for itself, so a killed command surfaced as a silent `=255` that looked like a verdict.
  It now says the command was killed and has no exit code of its own. 95 now covers both ways a
  result can fail to come back: a dropped connection, and a command killed on the remote.

## 0.8.4 — 2026-10-22

### Fixed
- **A lease from before the remote's last restart is void.** A hard reboot of the remote left seven
  leases whose runs had died with it. They were judged by their remote process numbers, which a
  reboot hands out again from the bottom: one named groups 798–801 while the rebooted remote was at
  539 and climbing, so the first long-lived process to draw one of those numbers would have wedged
  that workspace at 98 indefinitely, and `bica cancel` would have signalled it. The remote now
  reports its boot time alongside its clock, and a lease stamped more than 30 seconds before it is
  broken by the next run and cleared by `bica cancel` without a signal. Applies to leases written by
  earlier versions too, since it reads the start stamp they already carry.

## 0.8.3 — 2026-10-22

### Fixed
- **A build whose artifacts did not come home no longer exits 0.** A copy that died on
  `rsync: unexpected end of file` was reported in a dimmed line and the run exited 0, with the
  local binary still at its old timestamp; the caller launched it and reported a change that was
  not in it. A run whose command passed now exits **93** when any `artifacts:` entry could not be
  brought home, the failure is a warning that names the local copy as stale, and `bica wait`
  answers the same way for a detached run. A failing command keeps its own code, and an artifact
  the remote has not got is still not a failure.
- **`bica --help` lists every exit code that is not a verdict on the code**, not only 96 to 98.

## 0.8.2 — 2026-10-22

### Fixed
- **A dropped connection no longer leaves its command running on the remote.** Each command of an
  `--also` run now has the watchdog `bica tunnel` already used: when its connection closes, the
  remote ends that command and everything it started. It had been left out on the reasoning that
  test suites print constantly and so die of `SIGPIPE` on their own. Not all of them print — a
  typecheck is silent until it finishes — and a dropped run left 25 processes behind, one of them
  holding the port the next run's Storybook tests needed. The watchdog now signals the command's
  whole process group rather than the one pid it started, which for a `pnpm` script was `pnpm`
  itself, with the node processes doing the work underneath it.
- **The watchdog works under `sh` and `bash`.** It read stdin from a background job, which POSIX
  shells hand `/dev/null` when job control is off, so it saw the connection end at once and killed
  a healthy command. zsh does not redirect it, and the remote shell defaults to zsh, which is why
  it went unnoticed; with `BICA_LOGIN_SHELL=bash` every tunnel would have been ended as it started.
- **A run whose connection dropped keeps the workspace leased.** It used to give it back on the
  way out, while the remote commands were still running, so the next run synced into a live
  workspace and `bica cancel` found no holder to end. The lease now stays, and is judged as any
  orphan's is: refused with 98 and named for `bica cancel` while anything of the run is still
  running, and taken by the next run once nothing is. This is the backstop for a link that dies
  without the remote noticing, where the watchdog has nothing to wake it.

## 0.8.1 — 2026-10-21

### Added
- **bica says when `sync.ignore.paths` splits a build across two machines.** An incremental build
  keeps two things that only mean anything together: the output, and the record of what produced it.
  Ignoring `dist` while carrying `*.tsbuildinfo` separates them — the remote gets this machine's
  record of what was built, next to output built by whatever ran there last. TypeScript reads the
  record, believes the output is current, and compiles against another tree's declarations, so a
  typecheck reports errors on exports that are plainly present in the source beside it.

  Reported twice, diagnosed first as a broken sync and then as preserved timestamps, which
  measurement disproved: on the reported workspace the source was five hours *newer* than the stale
  declaration. Nothing about it looks like configuration from the inside, so bica now names it, with
  the one-line fix, before the run.

### Fixed
- **A busy-workspace refusal no longer hands back a command bica would refuse.** The claim recorded
  a parallel run by joining its commands with ` -- `, and 0.7.0 stopped accepting that as a
  separator. The refusal quotes that line while telling the reader to wait or re-run. It joins with
  `--also` now.

## 0.8.0 — 2026-10-21

### Changed
- **`git.sync` is on by default.** `.git` is mirrored to the remote with a one-shot
  `rsync -az --delete` before each run, so `--changed`, `--since`, `turbo --filter=...[ref]` and
  `:changed` scripts resolve the same refs they do locally. It was opt-in on the reasoning that
  `.git` is a lot of bytes nobody asked for. Measured, it is not — a repository's history is a few
  large packfiles, so rsync has almost nothing to walk:

  | | `.git` | working tree |
  |---|---|---|
  | files | 1,953 | 181,755 |
  | first sync | 21s | 101s scanning, then the transfer |
  | every run after | 0.4s, zero bytes | — |

  Against that 0.4s, every checkout had to find the setting by watching a `:changed` script fail
  inside its own tooling, several lines into a stack trace. It was reported twice, once as a defect
  in the sync.

  `git: sync: false`, or `BICA_GIT_SYNC=0`, turns it off for a repository whose history really is
  too large to mirror. The one cost worth knowing: `git gc` or an auto-repack rewrites the
  packfiles, so the run after one pays the first-sync price again.

  Verified against a checkout with no `git:` block at all: `bica run pnpm test:run:changed`
  resolved its base ref and ran the impacted suites, where before it exited 1 from git.

### Unchanged
- **`--` still refuses in the old two-command shape.** 0.7.0 said that refusal would go in the next
  release. The transition was meant to give notes and standing instructions time to catch up, not
  to last a fixed number of versions, and it has been a day. It stays for now.

## 0.7.4 — 2026-10-21

### Fixed
- **The note about a missing remote `.git` is said before the run, and every line of it is marked as
  bica's.** The note existed and named the exact setting, and an agent with it on screen still
  diagnosed the stack trace above it and reported the sync as broken. Two reasons, both fixable.

  It only ever appeared *after* the command, and a `:changed` script fails inside its own tooling —
  so by the time bica got a word in, the reader was at the bottom of a forty-line Node trace, where
  one more line is one more line. It is now said before the command runs as well, where no such
  noise exists yet, and where it predicts rather than explains. That prediction is sound: with
  `git.sync` off there is no repository in the workspace at all, so a command that resolves a ref
  cannot do it there.

  And only the note's first line carried `[bica]`. The line that actually says what to change —
  `git:` / `sync: true` — rendered as bare text at the bottom of the failing command's output,
  indistinguishable from the program's own. Every line is prefixed now.

  Unchanged: a run whose commands resolve no refs says nothing, and neither does one with
  `git.sync` already on.

## 0.7.3 — 2026-10-21

### Fixed
- **A large tree is no longer declared stalled while it is being scanned.** `bica run` gives up when
  the sync stops making progress, measured rather than timed — except that scanning publishes no
  number that moves. The status stays `scanning` and the file counts stay null for the whole phase,
  so the progress fingerprint is byte-identical from one poll to the next however hard Mutagen is
  working. A tree past about a minute of scanning therefore hit the 60-second stall budget and
  exited 94 with nothing run, on a healthy remote.

  Measured on an llvm-project checkout of 181,755 files at local load 17: the scan took **101
  seconds**, publishing `null` for every field until the moment it finished. `bica run true` failed
  three times in a row.

  A phase with nothing to publish now gets its own budget of 600 seconds — still a ceiling, so a
  scan that has genuinely wedged ends rather than waiting to be noticed — while staging keeps the
  60 seconds that its climbing file and byte counts justify. The waiting line now carries the
  elapsed time, because four identical sentences read as a hang. The refusal no longer tells you to
  check the remote: scanning reads local disk and sends nothing, so the remote is the one part that
  is certainly not at fault.

  Not a regression in 0.7.2. Nothing between 0.6.4 and 0.7.2 touched the sync path; what changed
  between the reporter's working runs and their failures was the machine's load.

## 0.7.2 — 2026-10-21

### Fixed
- **A detached run that was already finished is collected by the launcher, and its output says one
  thing.** 0.7.1 stopped calling such a run a failed start, but left three lines disagreeing about
  it: "It finished within a second of starting, with exit 1", then "Started detached … to watch",
  then "remote command exited 0". The last is the line a reader — or a script grepping for it —
  takes as the result, and it was reporting the launcher rather than the command.

  There is nothing to watch and nothing to come back for, so bica now finishes the run where it
  stands: the artifacts come home, the lease is given back, and the record is marked with the exit
  code. `bica run --detach false` prints the run id, reports `remote command exited 1`, and exits 1.
  A later `bica wait <id>` answers 1 from the record without troubling a workspace that has moved
  on. A run still going is untouched — it still says "Started detached", and `bica wait` is still
  what ends it.

## 0.7.1 — 2026-10-20

### Fixed
- **A detached run that finishes within a second is no longer reported as a failed start.** bica
  waits one second after launching to see whether the command can start at all, and treated "not
  running any more" as "never ran" — so `bica run --detach true` printed `remote command exited 1`
  and no run id, and so did `ninja` on a tree with nothing to do. The failing exit code sat above a
  log saying the command had succeeded, which reads exactly like a broken build.

  The run id now reaches stdout as it does for any other detached run, so
  `id=$(bica run --detach …) && bica wait "$id"` works on an up-to-date tree, and the remote reports
  the command's real exit status rather than only the fact that it had finished. The launcher still
  exits 0 to mean *started*, which is what it means for every detached run; `bica wait` is what
  gives you the command's own code, and returns immediately for a run already over.

## 0.7.0 — 2026-10-20

### Changed
- **Parallel commands are separated by `--also`; `--` belongs to the program.** `--` is how every
  runner in common use is told that the rest of the line is for the program it runs, and bica read
  those as two commands — running the first without the arguments it had been given, and the
  remainder as a program of its own. Reported from a cargo workspace where
  `bica run cargo run --release -p worldgen-preview -- 1 1024` ran cargo with no program arguments,
  ran `1 1024` as a command, and the binary's defaults happened to be `1` and `1024`, so the output
  looked right. The previous guard made it worse for cargo in particular: it refused
  `cargo run -p x -- --help` and advised dropping the `--`, which passes `--help` to cargo instead
  of to the binary.

  ```bash
  bica run pnpm lint --also pnpm typecheck --also pnpm test:run   # three at once
  bica run cargo run -p x -- 1 1024                               # arguments reach the binary
  bica run pnpm test -- --coverage                                # so does this
  ```

  **For this release only**, a `--` whose next word names a program is refused rather than
  reinterpreted, and the message gives both forms. A line written for the old meaning would
  otherwise become one long command and fail somewhere that says nothing about the separator having
  changed. The refusal is deliberately narrow: it needs the word after `--` to name a known runner
  or to repeat the program the line began with, so `-- 1 1024` and `-- --coverage` pass through
  today. It goes away in the next release.

## 0.6.5 — 2026-10-19

### Fixed
- **`bica tunnel --detach` detaches again.** It had started the tunnel in the foreground instead,
  since 0.4.0. The CLI lifts a few flags out of the whole command line before it chooses a
  subcommand — `bica run --detach` needs its flag read from after the subcommand — and `--detach`
  joined that set when detached runs shipped. The token was therefore removed before `tunnel` could
  read it, and `tunnel` saw a plain foreground request.

  The symptom was hard to read, because every visible sign pointed somewhere else. The command never
  returned, so anything after it in the same shell never ran. Its log stayed empty, because a
  foreground tunnel writes to the terminal — and a terminal behind `| tail` shows nothing until the
  process ends, which it never did. `tunnel --list` reported the tunnel up and ready, because a
  foreground tunnel writes the same record a detached one does. The natural reading was that a
  previous tunnel's state was being reused; nothing of the sort was happening.

  Affects `--detach` on `tunnel` only. `bica run --detach` was always correct.
- **Corrected what bica says about timestamps on the live path.** It warned that the live session
  copies your local timestamps, so a file edited during a build could arrive older than an object
  built from the previous copy. That is not what happens: mutagen propagates content rather than
  mtimes, and a file it delivers carries the remote's own clock. Measured against a real remote — a
  local file stamped 1 January 2025 arrives stamped with the time of the transfer, as does a newly
  created one. The claim sent people to the slower pinned path to avoid a hazard that only the
  pinned path has, since `rsync -a` is what preserves mtimes. The warning now names the hazard the
  live session really does carry: it goes on pushing while the command runs, so an edit made
  mid-build can land behind a build that has already read the files around it.

- **`bica logs` can find a run that `bica wait` has already reported on.** `wait` deleted the run's
  local record when it finished — and that record is the only thing naming the host the log is on,
  so the `bica logs <id>` that `wait` recommends in the same breath answered "No detached run
  called that". The log was never gone; it is still in `~/.bica/runs` on the remote. Finished
  records are now kept and marked, listed by `bica runs` with their exit code, and dropped after
  seven days. The same applied to a run whose workspace changed hands, where the message explicitly
  promised the output was still there.
- **A detached run that dies in its first second gets a record at all.** The launcher says `bica
  logs <id>` has its output, which was true of the log and false of bica's ability to find it: the
  record was written only for a run that was still going. That is the case where the output matters
  most, because the command failed before anyone could watch it.

- **A tunnel stops the server still holding the remote socket before it starts a new one.** It had
  only unlinked the path. A server whose ssh session died — a laptop dropping off the network, where
  the remote's sshd may never learn the client is gone — kept running and kept the socket open, so
  the next start left it listening on a name that no longer existed: reachable by nobody, holding
  its memory, invisible to `tunnel --list`. Three had accumulated on one machine, the oldest two
  days old. The holder is now terminated, given time to let go, and killed if it does not. Scoped to
  processes holding that exact path, which the `rm` was about to make unreachable in any case. A
  remote without `lsof` falls back to the unlink alone.

- **`bica tunnel --stop` and `--list` no longer need a `bica.yml`.** Both read `~/.bica/tunnels`
  and nothing else, but every `tunnel` invocation was treated as one that starts a tunnel, so both
  were refused outside a configured repository — and `--stop` is reached for precisely when
  something has gone wrong, from whichever directory the caller happens to be in. Starting a
  tunnel, and reviving a recorded one with `--restart <path>`, still require one.

## 0.6.4 — 2026-10-19

### Fixed
- **A large pinned sync no longer fails as a transfer error.** rsync's itemised listing is one line
  per file considered, so mirroring a large tree runs to megabytes — 11 MB for an LLVM checkout.
  Node kills a subprocess whose output passes 1 MiB, and rsync's signal handler exits 20, which bica
  reported as a failed transfer that had in fact completed. Output is now read in full, and an
  overflow is named as a bug in bica rather than a failure of the transfer.

## 0.6.3 — 2026-10-19

### Fixed
- **`bica doctor` asks git whether `.bica/` is ignored** instead of reading `.gitignore` itself, so
  an entry in `.git/info/exclude`, a parent directory's `.gitignore` or `core.excludesFile` now
  counts. It had been reporting a repository as unconfigured when the exclusion was real but
  written somewhere it did not look.

## 0.6.2 — 2026-10-19

### Fixed
- **`bica wait` survives a probe that could not run.** An unreachable host made it report the run as
  gone and discard the record. It now says the host is unreachable, keeps polling, and leaves the
  record alone, so a laptop that loses wifi mid-build does not lose the build.
- **Files the sync delivers are stamped, so a build cannot skip an edit made during a run.** A file
  edited while a run was out could land on the remote older than the object built from its previous
  contents, and the next build would skip it. Only content changes are stamped; a file whose
  timestamp alone differs is left alone, because stamping those defeats rsync's own quick check and
  makes every later run re-transfer them.

## 0.6.1 — 2026-10-19

### Fixed
- **The note about remote git history no longer appears under an ordinary test failure.** It was
  printed after any failing run, where it is advice about a situation that is usually not the one
  the caller is in. It now appears only when the command actually reads git history and the remote
  turns out not to have it.

## 0.6.0 — 2026-10-17

Requests 5 and 6: the Rust-specific gaps, and a shared remote build tree.

### Added
- **`target/` is ignored by default for a Rust repository.** It is gitignored, so the local checkout
  usually has none, and the mirror deleted it between runs — every build a clean build. A repository
  that already mentions `target` is left exactly as written.
- **Submodules reach the remote when `git.sync` is on.** The sync ignores `.git` at every level, so a
  submodule's own `.git` — a one-line file naming a path in the parent's `.git/modules` — never
  travelled, while the modules directory it points at did, since that lives inside the parent `.git`.
  The remote held all the data with nothing addressing it, and `git submodule status` reported every
  submodule uninitialised, which is exactly what rustc's bootstrap reads. Verified both ways against
  a real submodule: `-<sha> vendor/inner` without the pointer, ` <sha> vendor/inner (heads/main)`
  with it.
- **`bica doctor` checks a pinned toolchain the remote cannot fetch.** rustup installs what
  `rust-toolchain.toml` names, which holds for a channel or a version and not for `rustup toolchain
  link blackfin build/host/stage1` — that exists only where it was run. The check says how to link it
  on the remote.
- **`buildDir:` in `.bica/local.yml`**, exported to every remote command as `$BICA_BUILD_DIR`, so
  sibling worktrees can share one remote build tree without a wrapper script. Per-machine, because it
  is a fact about this machine's layout and not about the repository.

### Notes
- The cargo plugin's install preflight is `cargo fetch --locked`, which fills the registry cache and
  does not touch the rustup sysroot, so it does not fight `-Zbuild-std`.

## 0.5.0 — 2026-10-17

Request 4: commands that are not a package manager.

### Added
- **`toolchain:`** — tools the remote must have, checked by `bica doctor` with the same PATH a run
  uses. A missing `ninja` was exit 127 forty minutes into a build, under a command that read as
  having failed; it is now one line before anything starts.
- **`env:`** — local environment variables forwarded to every remote command, by name. ssh forwards
  nothing by default, so a `RUSTFLAGS` set for the occasion was absent on the other side and the
  build used different settings with nothing to say so. Never wholesale: copying the environment
  would carry credentials, `PATH` and `HOME` into a remote login shell. A declared variable that is
  unset locally stays unset remotely rather than becoming empty — the two mean different things to
  cargo and cmake alike — and variables describing this machine are refused with a line saying why.
- **`bica doctor` states whether an install preflight applies.** It matches the first word of the
  command, so a script entry point such as `./x build` gets none. That was already true and was only
  discoverable by noticing it had not happened.

## 0.4.0 — 2026-10-17

Request 3 of the large-compiled-projects set: runs that outlast the caller.

### Added
- **`bica run --detach`**, with `bica runs`, `bica logs <id> [--follow]` and `bica wait <id>`. An
  agent's tool call times out after ten minutes and bica ends a remote command when its connection
  goes, so a 50-minute `ninja` could not be started from one at all. A detached run executes on the
  remote under `nohup` with its output in a file there, and the launcher returns as soon as the
  command is confirmed running — which also means a dropped link no longer costs an hour of
  compilation. `wait` blocks, exits with the command's own code, brings artifacts home and gives the
  workspace back. The tree is pushed once and left alone: a live session would go on mirroring local
  edits into a workspace being compiled.
- The lease is held for the whole detached run, so a second `bica run` meets 98 rather than syncing
  over a build. `wait` releases it. Start another run in that workspace first and it will break the
  finished run's lease, taking the recorded exit code with it; `wait` then says so rather than
  reporting a stranger's result.

### Fixed
- An artifact the build has not produced is reported as nothing to bring home yet, rather than as an
  rsync error. `rsync(350): warning: receiver has empty file list: exiting` appeared under ordinary
  runs whose build simply had not got that far.

### Notes
- The detached shell is started with job control on. This is load-bearing rather than hygiene: the
  lease's liveness oracle asks whether the recorded pid is a *process group*, which is right for an
  attached run because ssh makes the remote shell a group leader. A backgrounded job in a
  non-interactive shell does not get its own group and macOS has no `setsid`, so without it the
  detached shell stayed in the launching ssh's group — which dies with the launcher. The next run
  then read the lease as stale, broke it, and synced over a live build. Measured on the remote: pgid
  96707 for a job whose own pid was 96708, against pgid 96712 == pid 96712 with job control on.

## 0.3.0 — 2026-10-17

Large compiled projects: the first two items of the LLVM/rustc feature request.

### Added
- **`artifacts:`** — named outputs copied home from a tree the sync leaves alone. A build directory
  must be in `sync.ignore.paths` to survive, and that is exactly what puts it out of return-flow's
  reach, so the binaries worth having were in the one place return-flow may not look. Each entry is a
  path rather than a pattern, symlinks are followed (so `build/bin/clang` arrives as the binary, not
  as a link to a path this machine has not got), only what changed is transferred, and a trailing
  slash takes a whole tree for rustc's `build/host/stage1/`. Reported like `--write-back`, and pulled
  on pinned runs without `--return-flow`. An artifact the mirror would delete is named before the run
  rather than silently arriving as nothing. Replaces a wrapper that `cp -L`'d binaries into a
  whitelisted directory so return-flow would carry them.
- **A bulk `rsync` seed for an empty remote workspace**, before Mutagen starts. Mutagen stages a
  180,000-file tree one file at a time; rsync does it in one pass. Only when the workspace is empty,
  which is the whole safety argument — nothing can be lost where there is nothing — and always
  honouring `sync.ignore.paths`, so it cannot push a local `node_modules` over the remote's or create
  a `build/` the remote owns. A failed seed is not fatal.

### Fixed
- Both features were written against GNU rsync and corrected against the one macOS actually ships.
  openrsync rejects `--info=`, answering with its usage text, which made the seed fail with a
  truncated "source ... directory"; it ignores the `/./` marker that `--relative` uses, so artifacts
  landed under a recreated copy of the remote's absolute path; and its `--itemize-changes` writes
  nine flag characters where GNU writes eleven, so reading the name at a fixed column took three
  characters off the front of every one. All three were found by running it, not by the tests.
- The workspace-emptiness probe quoted a `~/code/…` path whole, which made `~` a literal directory
  name, so every run thought the workspace was empty and re-seeded it. The `~`-aware shell quoting
  now lives in `runRemote.ts` and is shared with the stale-`.git` probe, which had the same bug.

## 0.2.9 — 2026-10-17

### Fixed
- **A run no longer starts against a tree that is still being copied.** bica waited sixty seconds for
  the first sync, said "continuing anyway", and ran the command regardless. On a repository whose
  first transfer takes longer than that — a shallow llvm-project, 180,633 files and 2.8GB — the
  command ran in a directory that was still empty: `ls` exited 1, a script exited 127, and both read
  as the command failing rather than as nothing having been copied. The session was then torn down,
  so the next attempt began again, hit the same minute, and failed the same way; no single-command
  run could ever succeed on that repository.
- No fixed budget is right here, because it scales with the tree and the link, so the wait is now
  about whether the sync is *moving*. Mutagen publishes how many files and bytes it has staged, and
  bica waits as long as that climbs, giving up only after a minute in which nothing changed at all —
  the stall the old timeout was reaching for, measured rather than guessed. Scanning counts as
  progress too: a very large tree scans for minutes before sending a byte.
- **A stalled sync exits 94 and runs nothing.** With 95, 96, 97 and 98: not a verdict on the code.
  The message says how far the copy got and that a second attempt sends only what is missing.

### Added
- **Progress while the first sync runs** (`Copying to the remote: 41,200/180,633 files (3.1GB)`),
  every ten seconds, on stderr and not suppressed when stdout is captured. An hour of silence is
  indistinguishable from a hang, which is what the sixty-second give-up was really about.

## 0.2.8 — 2026-10-17

### Fixed
- **A tunnel notices when its socket path stops leading to it.** A unix socket is a path, and a path
  is not owned: anything may unlink it and bind its own. When that happened the listener kept its
  socket and its descriptor and went on believing it was serving, while every client got
  `ECONNREFUSED` and `--list` still showed the tunnel up. One tunnel sat like that for two days — the
  process healthy, the last log line from an unrelated outage the day before, and the symptom
  reported, reasonably, as "it never retried after the host came back". It never retried because no
  request ever reached it. A tunnel now checks every thirty seconds that the path still names its own
  listener: a path replaced by a socket nothing serves is taken back, and a path something else is
  genuinely serving is left alone, with the tunnel standing down rather than fighting for it.
- **A forward that could not bind no longer blames the OpenSSH version.** bica printed "Stream-local
  forwarding needs OpenSSH 6.7 or later on both ends" whatever the cause — one line below ssh's own
  `connect to host 192.168.0.120 port 22: Operation timed out`, for two machines that had been
  forwarding that socket for two days. The message now quotes ssh and names the version only when ssh
  actually reported that unix-socket forwarding is unsupported, or when it said nothing at all.

## 0.2.7 — 2026-10-13

### Fixed
- **A `.git` left behind on the remote is no longer trusted in silence.** The sync ignores `.git`
  rather than deleting it, so one run with `git.sync` on leaves a repository in the remote workspace
  for good; later runs copy files in around it and leave its refs where that run left them. `git.sync`
  off was meant to mean "no repository there", and the existing hint is written for that — the command
  fails with git's own "not a repository" and bica says which switch to flip. A stale repository
  resolves every ref instead, so nothing fails: one run diffed a branch against an `origin/master` four
  days old, reported `Linting 405 changed file(s)` for a branch that changes 15, and exhausted node's
  heap on the rest, which read as the remote machine being short of memory. Its sibling
  `test:run:changed` would have reported a pass over the wrong tests.
- bica now asks the remote whether it has a repository when `git.sync` is off and the command resolves
  refs, and warns **before** the command runs — naming the branch that repository is on and its newest
  remote-tracking ref with that ref's date. Before the command, because the damaging case is the one
  that succeeds, and a warning printed after a run that passed is a warning nobody reads. The probe is
  one ssh round-trip and only happens on those runs.

## 0.2.6 — 2026-10-10

### Fixed
- **A tunnel whose link dies no longer leaves its clients in silence.** A dropped forward took ten
  and a half minutes to notice, during which a request in flight got neither an answer nor an error.
  Two changes: a forward now gives up after about a minute of unanswered keepalives rather than ten
  (`BICA_TUNNEL_DEAD_AFTER` raises it for a slower link), and when a forward dies bica ends the
  requests it was carrying, so a waiting client sees its connection close — an error it can report —
  instead of waiting on an socket whose other end is gone.
- The ten-minute figure was inherited from `bica run`, where it is right: a quiet stretch in the
  middle of a compile is ordinary. A forward carries requests someone is waiting on, and
  re-establishing one costs about a second, so the cheap mistake there is giving up too early.
- The unanswered-request warning is now said once per silent spell rather than once per tunnel. A
  detached tunnel runs for days, and one warning on its first morning used to buy silence for every
  incident after it. It also names both causes now, since a dead link is one of them.

## 0.2.5 — 2026-10-10

### Fixed
- **A dropped connection is no longer reported as a failing command.** ssh exits 255 both when the
  remote command does and when ssh gives up on the link, and it wrote its explanation into the same
  stream the command was using -- so a run that lost its connection mid-suite reported
  `pnpm-test-run=255` beside `pnpm-typecheck=0`, which reads as a test suite that failed oddly. bica
  now gives ssh its own verbose log (`ssh -v -E`), so ssh's account is separable from the command's,
  and reports a drop as **exit 95** with a line saying the result is unknown. 95 joins 96/97/98:
  none of them is a verdict on your code.
- The answer rests on two lines in that log rather than on the wording of the error, which turned
  out not to separate the cases: `Authenticated to …` means a session existed, and `Exit status N`
  means the command's own code came back. A drop is the first without the second. Matching ssh's
  error text was tried first and failed against a real severed link, whose message
  (`Connection closed by UNKNOWN port 65535`) is also what a refused handshake prints.
- A connection that was never established is still reported as 96, because the answer differs: fix
  your ssh, rather than re-run.
- Anything else ssh says on a failed run is now printed rather than lost to the new log file --
  except when the command reported its own exit code, where ssh has nothing to add.

## 0.2.4 — 2026-10-10

### Added
- **`bica tunnel --ready-when=<regex>`** — wait for the remote command to print a line matching the
  pattern before calling the tunnel up. For anything that binds its socket before it can answer, a
  model load being the usual reason: the kernel queues connections either way, so no probe can tell
  that server apart from a working one, and the server's own announcement is the only exact answer.
- Without that flag, bica says when a request goes twenty seconds without a reply, and names the flag.
  It is the proxy, so it sees the bytes; what it could not do was infer this from outside.

## 0.2.3 — 2026-10-09

### Fixed
- **A tunnel announced `Tunnel up` over a socket nothing was listening on.** Readiness was "the remote
  socket file exists", which is equally true of a server that died leaving the file behind — so after
  an on-demand restart bica reported a healthy tunnel and every request went unanswered. It now also
  asks the forward whether a connection is accepted, reading ssh's own `open failed` as the answer.
  A server that binds and then takes minutes to *accept* is still indistinguishable from a working
  one -- a listening socket queues connections in the kernel whether or not the application has got
  to them -- so that case has to be fixed in the server.

### Added
- Every `[bica]` line in a tunnel log carries the time. A report of the above had to say "the log has
  no timestamps, so I can't tell how long the restart took".

## 0.2.2 — 2026-10-09

### Added
- `bica init` now ignores `*.tsbuildinfo` alongside `dist`, and `bica doctor` warns when a config has
  one without the other. A composite build's record of what it produced has to come from the same
  side as the output itself; sent alone, it makes the remote skip rebuilds and typecheck against a
  stale `dist`, producing errors that exist on no machine.
- A run now says when it left processes running on the remote, and when the remote is labouring.
  `bica doctor` reports the load any time. Reported, never acted on: a command may background a
  server deliberately, and the gap was that nothing noticed when one misbehaved.

### Fixed
- **`bica tunnel --detach` returned before the tunnel could serve anything.** It waited for the child
  to write its record, which happens when the local socket is bound — before the remote command has
  started. With a server that takes ten seconds to load, `--detach` returned in under a second with
  the socket present and nothing behind it, and the next client failed. It now waits for the same
  moment the foreground form calls `Tunnel up`, and gives up early if the child dies rather than
  sitting out the whole budget.

## 0.2.1 — 2026-10-08

### Added
- A guard test that fails if any test file names a directory under the system temp rather than asking
  for a fresh one, and a CI job that runs the suite twice at once. Between them they catch fixtures
  shared between processes — the guard names the line, the job proves the property.

### Fixed
- **`git.sync` did nothing in a `git worktree`.** There `.git` is a one-line file naming a path inside
  the main clone, so the copy carried a path the remote does not have and every history-reading
  command failed with `not a git repository` — while git sync reported success. bica now copies the
  shared repository and the worktree's own state as one flattened repository on the remote.
- With `git.sync` on, a failing history command said nothing at all, leaving whoever had followed the
  previous hint with a bare `fatal: not a git repository`. It now says what bica copied.
- **Mutagen's progress no longer lands on stdout.** `Creating session…` and `Connecting to agent…`
  were passed through to bica's stdout, so `$(bica run git rev-parse HEAD)` captured the narration
  along with the value. Everything bica says about its own progress is on stderr; stdout carries the
  command and the exit-codes summary.
- A test that failed about once in three full-suite runs and never on its own: `workingTreeOid` seeds
  a throwaway index from the real one for speed, so `git add -A` uses git's size-and-timestamp quick
  check, and a same-length edit landing in the same second could be called unchanged. The test now
  advances the timestamp deliberately. Nothing a user does depends on that window — whether a local
  file moved while a run was out is decided by comparing content, not timestamps.
- An ordinary clone was briefly misdetected as a worktree on macOS, where `/tmp` and `$HOME` reach
  their contents through symlinks and git answers the two "where is the git dir" questions in
  different spellings. Paths are compared canonically.

## 0.2.0 — 2026-10-07

### Added
- **`bica doctor`** — checks Node, ssh, rsync and Mutagen here; the configuration; whether the host
  answers; the remote's login shell and toolchain, using the same PATH a run uses; and whether
  OpenSSH there is new enough for `bica tunnel`. Every check is independent, so a machine with three
  things wrong reports three. Exits non-zero when something would stop a run.
- `bica init` now ends by running those checks, so setup finishes with a verdict rather than a
  prompt.

### Changed
- **A run of several commands at once is coordinated here, not by a script sent to the remote.** Each
  command gets its own ssh connection into the one workspace, and its output is prefixed with the
  command's label and streamed as it arrives. **The `===== label =====` blocks are gone**; anything
  parsing them needs updating. The `[bica] exit codes: …` summary line is unchanged and still on
  stdout.
- The lease now records one remote process group per command, and treats a run as alive while any of
  them is. An older bica reads the first group only, and would judge such a run stale once that one
  command had finished — one more reason not to mix versions against one remote path.

### Fixed
- **Every run used to begin with a wall of `KEY=value` lines.** ssh joins its arguments with spaces
  and the remote's own login shell parses the result, so `zsh -lc <script>` ran `zsh -lc export` —
  taking only the first word — and then executed the rest of the script in the outer shell. The bare
  `export` listed every exported variable. bica's own help attributed this to the user's `.zprofile`;
  it was bica. The script is now passed as one quoted word, which also means the PATH preamble runs
  in the shell it was written for, and a missing login shell fails outright instead of running
  everything but its first line.

## 0.1.0 — 2026-10-06

First version intended for anyone other than its author.

### Added
- `bica tunnel`: run a long-lived process on the remote and forward its Unix socket to a local path,
  with `--restart=never|on-exit|on-demand`, `--detach`, `--list`, `--stop` and `--restart <socket>`.
- `bica --version`.
- `git.sync`, and a line naming it when a run fails on a command that reads git history.

### Changed
- **The install record moved to the remote** (`~/.bica/installs`). It describes one remote
  `node_modules`, which several checkouts can share, so keeping it per checkout meant one checkout
  could not see that another had reinstalled. Upgrading costs one reinstall per workspace; older
  versions keep their own local record and will disagree.
- **The default remote path now includes your username** (`~/code/<user>/<repo>`). Teammates sharing a
  remote login previously all defaulted to one workspace and overwrote each other. Existing configs
  with an explicit `remotePath` are untouched.
- Probes run under `sh` rather than the configured login shell, so a remote without `zsh` works.
- Tunnel readiness is POSIX `test -S` and no longer needs `python3` on the remote.

### Fixed
- A failed ssh connection reported itself as "the workspace is in use" with exit 98, telling the user
  to wait for a run that did not exist. It now exits 96 and quotes ssh.
- A missing login shell did not fail: ssh handed the script to the remote's own shell, which ran most
  of it without the PATH setup. It is now checked before the run.
- `bica tunnel --list` could signal unrelated processes, because the orphaned-ssh sweep matched
  command lines against the user-chosen remote socket path.
- Replies larger than one socket buffer were truncated at 16,384 bytes.
- `remotePath` is refused when it names a home or root directory, which the first sync would mirror
  into with deletions.
- An `sshHost` beginning with `-` is refused; ssh would read it as an option.
