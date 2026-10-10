# Changelog

Dates are the release date. bica keeps state on the remote that several versions can reach, so
entries note where a change affects what another version sees.

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
