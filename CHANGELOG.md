# Changelog

Dates are the release date. bica keeps state on the remote that several versions can reach, so
entries note where a change affects what another version sees.

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
