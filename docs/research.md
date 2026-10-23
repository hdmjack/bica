# bica research notes

Findings from building bica, kept because each one cost something to learn and the reasoning is not
recoverable from the code. Not needed to use bica — start with the README.

Findings from running bica against a real monorepo (~11k tracked files, 2.4GB working
tree, eight checkouts sharing one Mac mini). Recorded because most of them cost hours to
find and none are guessable from the code. Numbers are from a single machine pair on
2026-08-21; treat ratios as durable and absolute figures as indicative.

### The remote host indexes everything you rsync to it

**The single largest effect measured, and it is not in bica at all.** macOS Spotlight
indexes files as they land, so every `bica run` feeds an indexer that never catches up.
On a mini used for nothing but bica:

| | |
|---|---|
| load average, nobody working | **35** |
| concurrent `mdworker` processes | 16 |
| `node` / `pnpm` / `eslint` processes at that moment | **0** |
| `mds_stores` uptime, still not finished | 27 days |

`pnpm typecheck`, three alternating pairs, before and after `sudo mdutil -a -i off`:

| | remote | local (M1 Pro) |
|---|---|---|
| Spotlight **on** | 78.5s | 53.9s |
| Spotlight **off** | **18.0 – 18.6s** | 78.3 – 239.1s |

Every figure above is **end-to-end wall clock around the whole `bica run`, rsync
included**, on a clean tree already in sync. A checkout with more to transfer pays more
before the command starts — 48s was measured the same evening from a dirtier tree — so
quote which tree state you measured, or a reader will compare a clean-tree remote figure
against a local one and over-estimate the win.

The remote goes from 1.5× *slower* to 4–5× *faster*, and its variance collapses — remote
stayed within 0.6s across runs while the laptop swung by 160s under sustained load. **Turn
indexing off on any host you sync to.** `mdutil` operates on volumes, not directories, so
`mdutil -i off ~/code` fails with "invalid operation"; use `sudo mdutil -a -i off` plus
`sudo mdutil -a -X` to drop the existing index.

The corollary matters as much: **any measurement taken on a host with a background
indexer is void.** Several conclusions in this file were wrong the first time for exactly
that reason.

### File sync destroys mtime-keyed caches

A synced workspace breaks caches in two different ways, and it is worth keeping them apart
because only one of them actually bit.

**What bit: pushing the cache at all.** bica was syncing the local `.eslintcache` over the
remote's on every run, and the local copies were months stale, so the remote never got past
cold. Excluding the cache from the sync — it is per-side state, exactly like `dist` — was the
whole fix:

| `bica run`, remote | cold | warm |
|---|---|---|
| lint one large package | 122.3s | **9.9s** |
| lint all nine packages | 105.1s | **18.8s** |

Ten minutes to nineteen seconds, on the default cache strategy.

**What did not bite, but could:** `rsync` rewrites mtimes, and ESLint's default
`--cache-strategy metadata` keys on mtime + size. In practice `rsync -a` restores each file's
mtime from the sender, so identical content keeps an identical mtime and the cache survives —
the warm figures above are on the default strategy, across separate runs. The exposure is
latent rather than active: nothing guarantees mtime fidelity across filesystems or rsync
implementations, and if it slips the failure is silent and indistinguishable from a cold cache.
A content-hashing mode removes the dependency.

I originally wrote this up as "rsync destroys mtime-keyed caches, so you need content hashing".
That was the wrong diagnosis reached from the right observation — the cache was indeed always
cold, but because it was being overwritten, not because mtimes moved.

Generalises to anything that fingerprints by stat: build caches, test caches, incremental
compilers. If a tool has a content-hash mode, a synced workspace is where you want it.

### A git worktree is not a self-sufficient tree, and bica syncs that faithfully

A `git worktree` contains only *tracked* files. Anything generated and gitignored — and there is
usually more of it than you think — is simply absent, and the pinned push copies that absence to
the remote exactly as it copies everything else.

Measured on one package of a real monorepo: `ui/src/icons/essentials` holds **178 tracked files
and 362 on disk**. The ~184 difference is generated at postinstall and ignored by a local
`.gitignore` (`Icon*.tsx`). From a normal checkout they are on disk, so rsync sends them — rsync
does not consult `.gitignore`. From a worktree they never existed, so a remote typecheck reports
**375 `TS2307`s naming modules that really are missing**, on any branch, including the base.

**The install preflight does not cover this.** It fingerprints the lockfile and installs when the
workspace is cold or the lockfile drifted. In a worktree the lockfile is unchanged, so nothing
triggers and postinstall never runs.

Run `pnpm install` once in the worktree, or use a normal checkout.

This surfaces as more than one symptom, which is why it took two people to pin down: the same root
also produced runs from a worktree that died with **no command output at all**, filed separately as
"bica cannot run from a worktree". Whoever hit one had no way to connect it to the other.

The diagnostic tell that generalises: **re-run against the base branch's content in the same tree.**
If the errors survive reverting your own work, they are about the environment, not the change. And
prefer `rsync -an -i --ignore-times` when testing whether a filter excludes something — a plain dry
run reporting zero changes cannot tell "excluded" from "in scope and already current".

### Tree size is a bad predictor of sync cost

Excluding ~2GB of generated and vendored trees cut the push scope hard:

| | files scanned | bytes in scope |
|---|---|---|
| before | 76,790 | 2,100 MB |
| after | 14,367 | 125 MB |

Wall-clock saving in steady state: **0.83s** (6.45s → 5.62s, mean of four alternating
pairs). rsync only transfers what changed, and stat-ing 62,000 unchanged files is cheap.
The exclusions are still worth having — first push to a fresh workspace, disk on the
remote, and above all *less for the indexer to chew on* — but not for the reason that
looks obvious.

### One workspace beats one workspace per command

Running three commands as background processes in a single remote workspace, against one
copy of the files, uses a third of the disk and builds `dist` once instead of three
identical times. Commands that only read the same files do not need separate copies of
them. This is why bica has no lanes.

**The timing that originally justified this — 32s against 43s for a workspace each — should
not be trusted.** It was measured before indexing was disabled, and three workspaces means
three copies of the tree for the indexer to walk rather than one, so the storm penalised
the multi-workspace arm specifically rather than both evenly. The conclusion stands on the
disk and single-`dist` arguments, which are structural and need no measurement; the ratio
does not. Re-measuring is not straightforward either, since lanes are gone and "a workspace
each" is no longer something bica can do — the comparison would have to be rebuilt by hand.
Kept here as a worked example of the trap at the top of this section: a number taken on a
noisy host is not merely imprecise, it can be biased toward the arm that touches more
files.

Concurrency is bounded by the remote's CPU, not by bica: **1.33× on a quiet host, 0.94× on
a busy one.** Fan out when commands are long; for short ones the transfer dominates.

### Wrapping commands in `sh -c` defeats three mechanisms at once

`bica run sh -c 'pnpm lint; pnpm typecheck'` looks equivalent to the `--` form. It is not:

1. **Serial**, not concurrent.
2. **No install preflight.** Package-manager plugins match on each command's `argv[0]`.
   With `sh` there, nothing matches, so the remote `node_modules` is never checked and a
   stale workspace fails with a confusing missing-module error instead of installing.
3. **`PIPESTATUS` does not survive it**, so the usual way to keep a filtered command's exit
   code reports the filter's status instead — observed reporting a failing test run as
   exit 0.

The `--` form gives each command its own heading and a `[bica] exit codes:` summary line
derived from the same statuses the run exits on. Read that line; do not grep output.

### `--delete` with an include-directories rule is noisy but not dangerous

Return-flow needs `--filter=+ */` so rsync can descend looking for whitelist matches. That
also puts every directory into `--delete` scope, so rsync tries to remove each receiver-side
directory the sender lacks and fails on any holding protected files: **8,703 "not empty,
cannot delete" warnings** against **7 actual deletions**. The trailing `--filter=- *` does
correctly protect every non-matching file, so nothing tracked is at risk — the fault is
diagnostic noise, not data loss. Verify the claim with `--dry-run -i` and count
`*deleting` lines rather than reasoning about filter precedence.

**Two separate things got conflated on the way to this, worth keeping apart.** The warning
flood above is real, reproducible, and constant. The `rsync exited 20` failures that first
drew attention to it are *not* the same fault: they were intermittent while the filter set
was fixed, which a filter bug cannot be. The likelier cause is the indexer above — "not
empty, cannot delete" on a directory rsync has just emptied is what you see when another
process is holding files open in it, and the paths named were all directories Spotlight
would traverse. A constant flood and an intermittent failure sharing a symptom string is
how one became evidence for the other.

### Type-aware linting is fixed cost, and does not parallelise

`typescript-eslint` with `projectService` builds a whole TypeScript program before
evaluating any rule. On a 4,941-file package:

| files linted | time |
|---|---|
| 15 | 23.6s |
| 175 | 24.3s |
| 1,485 | 65.4s |
| 1,485, `--concurrency=auto` | **>10 min (timed out)** |
| 1,485, warm cache | **4.1s** |

The marginal file is nearly free; cost tracks the *program closure*. So scoping a lint to
changed files still pays the full floor, and a per-package recursive lint pays that floor
once per package. **ESLint's `--concurrency` is actively harmful here** — each worker
builds its own program, multiplying the dominant cost instead of dividing it. A warm cache
skips program construction entirely, which is why the cache is the whole game.

### A check must distinguish "nothing to do" from "could not run"

The single most repeated failure across this work, in five different mechanisms, was a check that
reported success while doing nothing. Each was believed at the time.

| what happened | what it printed | what it meant |
|---|---|---|
| Probe aborted under `zsh` on an unmatched glob | nothing missing | could not run |
| Icon generator hashed inputs only, outputs deleted | `Icons up to date, skipping generation.` | outputs absent |
| Cleanup test asserted the wrong directory | pass | trap never exercised |
| `rsync --dry-run` on a tree already in sync | 0 changes | not proof of exclusion |
| Committed file matched the generated pattern | declaration satisfied | 346 files still missing |

They share a shape: **an empty result is ambiguous between "the condition is met" and "I never
looked", and the two are indistinguishable at the point of reading.** A negative result licenses far
less than it appears to, and it is exactly the result nobody investigates, because it looks like the
good news.

**It was only visible in aggregate.** No single session that hit this had more than two instances,
and two looks like a local quirk rather than a pattern. It became legible because eight sessions
reported into one place on one night, and the tally reached seven. Worth knowing when deciding
whether this class of bug is rare: the evidence for it is distributed by construction, since each
instance is a different mechanism and only the shape repeats.

The consequence is a practice rather than an opinion: **report a suspected instance even when it
looks like a one-off**, because the count that matters is not the one you can see. Without that the
observation is true and inert — everyone correctly judges their own two instances as noise, and
nobody ever reaches seven.

The defences that actually worked here, in rough order of value:

- **Mutate the thing the check exists to catch, and watch it fail.** The cleanup test survived
  deleting the trap twice — once in its original form, once in my replacement. Nothing else would
  have revealed either.
- **Run it where it will run.** The probe passed under `/bin/sh` throughout and failed under the
  `zsh` the remote actually uses. A test on the wrong shell is a test of the wrong program.
- **Force the work rather than accepting a fast pass.** `rsync -an -i --ignore-times` lists what a
  plain dry run omits, because "already current" and "excluded" print identically.
- **Check the positive case too.** Every one of these was caught by asking "would this have said
  anything different if the answer were the other way?"

### The lease's liveness oracle was the wrong process

The lease decides whether a claim is stale by asking whether its owner still exists. For a long time
the owner it asked about was the **client** pid — but the process that reads and writes the remote
workspace is the **remote** shell, whose lifetime follows the ssh connection rather than the client's.
Those two can diverge, and while they are diverged a second run judges the claim stale, breaks it, and
rsyncs into a workspace where the first run's command is still executing. That is the precise
collision the lease was built to prevent.

Reaching the diverged state takes nothing exotic: any interruption that takes the client without
taking the ssh, which includes every obvious `pkill` pattern. Reproduced by starting a long run,
killing only the node client, and watching a second `bica run` acquire the workspace and exit **0**
while the first command's remote pids were still alive on both sides of it.

The fix records the remote shell's pid into the claim (`rpid=N`) as its first act, and consults it
when the client looks dead. The order matters for cost as much as for correctness: the local answer
is free, so the ssh probe only happens for a claim that would otherwise have been broken. Cross-host
claims are still never judged — refusing costs a re-run, guessing costs a wrong answer.

**The probe asks about the process group, not the pid.** The first version asked `kill -0 <shell>`,
and killing that shell left its `sleep` running in the workspace — the same wrong-subject mistake one
level down, and it would have reported the workspace free with a process still sitting in it. sshd
gives the command its own session, so the shell leads the group and every descendant joins it; one
`ps -A -o pgid=` question covers the whole job. For the same reason the kill the exit-98 message
offers is `kill -TERM -<pgid>`, signalling the group.

Two things generalise from it:

- **A liveness check is only as good as its choice of subject.** The client pid answered "is the
  local process alive" perfectly. The question the lease needed answered was "is anything still
  touching this directory", and nothing in the code marked the substitution — the pid field was
  documented as "the liveness oracle" without saying an oracle for *what*.
- **Probe a remote process with a pattern that cannot match the probe itself.** `pgrep -f "_bica_dir"`
  matches the shell running it, so it reports the same count whether or not a run is live; the tell is
  a constant number of matches whose pids change every invocation. Use the bracket trick
  (`pgrep -f "[M]anagePeople"`). An earlier pass of this investigation drew the opposite conclusion
  from exactly that. This is [the empty-result trap](#a-check-must-distinguish-nothing-to-do-from-could-not-run)
  in its positive form: a result that looks like evidence and is an artifact of the measurement.

The single-command path had also never been given the lease at all — it passed no run id to the
remote script, so it had neither the pid publication nor the end-of-run "did someone take this
workspace" check that the multi-command path has had all along. It is the common path.

### Correct refusals still need an exit

The liveness fix above made the lease honour an orphaned run instead of trampling it. That is right,
and it converted a silent corruption into a visible block — but for a while it was a block with no
exit. An incident a day later: an agent's shell tool killed a `bica run` at its two-minute timeout,
the remote suite carried on for six more minutes, and every run in between was refused. The refusal
named both pids and offered `ssh <host> kill -TERM -<pgid>`, which the sandboxed caller could not
execute. It waited.

Two things were wrong, and only one of them was the missing command:

- **The remedy a message offers has to be runnable by whoever reads it.** A negative pid asks the
  reader to know about process groups, and `ssh` is frequently not available to an automated caller.
  `bica cancel` is now the offer; the raw form stays as a parenthetical.
- **A signal handler cannot run behind `spawnSync`.** The obvious fix — handle `SIGTERM`, tear down,
  exit — was unimplementable as written, because the run was a blocking `spawnSync` that pins the
  event loop for its whole duration. A handler registered against it would not fire until the remote
  command had already finished, so the caller's timeout would appear to do nothing and then be
  honoured minutes late. That is worse than the instant death it replaced, and it would have tested
  green in any test that did not actually signal a live run. The ssh child had to become async first.

The teardown reaches the remote by killing the local `ssh`: the connection drops, sshd hangs up the
session, and the remote process group gets `SIGHUP`. (Corrected 2026-10-22: without a PTY it does
not. The command only learns by writing to a closed pipe, so a quiet one carries on — see "A dropped
link is reset, not timed out" below.) That chain is the reason an orphaned `ssh` is so
damaging in the first place — it is the only way the remote ever learns its caller is gone.

### Measurement traps hit in the course of the above

- **A tool timeout is not a completion.** `>10 min` above is a kill, not a number.
- **`du` cannot see APFS block sharing.** Cloned `node_modules` read as 1.9GB per workspace
  and were ~440MB; measure with `diskutil` container free space instead.
- **A harness that greps prose couples the test to the wording.** Two live checks silently
  went inconclusive that way; assert on exit codes.
- **Guidance loaded into an agent's context does not update when the file does**, and a
  system-delivered excerpt is worse than a file you read yourself, because it carries
  authority and leaves no mark saying it aged. When a tool's behaviour is in question, read
  it from disk.

### git's quick check can miss an edit, and so can rsync's

Both compare size and modification time before deciding a file is unchanged, and both were caught
doing it within one week.

`workingTreeOid` seeds a throwaway index from the repository's real one, for speed: `git add -A` then
re-hashes only what the stat information says moved. The cost is that an edit landing in the same
second the index was written, replacing content of the same length, can be called unchanged. It made
one test fail about once in three full-suite runs and never on its own. The test now advances the
file's timestamp deliberately, which is what an edit a moment later does anyway.

The same trap, in rsync, cost rather more. Syncing a worktree's git state copies the shared repository
first and then the worktree's own state over the top, and `HEAD` is the file that decides which commit
the remote is on. `ref: refs/heads/main` and `ref: refs/heads/side` are the same length, and a worktree
created in the same second as its clone shares a timestamp — so rsync skipped precisely the file that
mattered, and the remote reported the main clone's HEAD while appearing to succeed. That copy is now
forced with `--ignore-times`.

**What follows from both:** a size-and-timestamp comparison is an optimisation, and it is wrong exactly
when two versions of a file are the same length and written close together — which is the normal shape
of a one-character edit, and of a branch name swap. Where the answer decides something (which commit
was verified, which file lands on top), compare content or force the transfer. bica's write-back guard
already does the stronger thing: whether a local file moved while a run was out is a blob comparison
against the pushed tree, not a timestamp heuristic, which is why a missed stat never costs anyone their
work.

### A dropped link is reset, not timed out, and a lease must not outlive a boot

Findings of 2026-10-22, from three reports of `--also` runs exiting 95 against a Mac mini running
runs for six checkouts at once.

**The drops were not keepalive timeouts, so keepalive settings cannot fix them.** bica already passes
`ServerAliveInterval=30` × `ServerAliveCountMax=20`, ten minutes of tolerated silence, and the drops
came at 183s and 188s. ssh says `Timeout, server … not responding` when keepalives run out; these
said `client_loop: send disconnect: Broken pipe`, and the first was preceded by `Read from remote
host …: Connection reset by peer`. A reset means the remote's TCP state for the connection was gone:
it had output in flight it could not deliver, gave up retransmitting, and answered the next packet
with RST. A connection with nothing in flight at that moment survives, which is why one command of a
run drops while its neighbour carries on.

**The cause was the remote's link under load.** The mini was on Wi-Fi (`en1`, Ethernet inactive)
with a healthy signal (−55 dBm / −93 dBm, MCS 9). Measured from the client while it ran at load 30–40
on 10 cores:

| target | loss | RTT max |
| --- | --- | --- |
| router, same client | 0% | 47 ms |
| mini, sample 1 | 65% | 85 ms |
| mini, sample 2 | 0% | 2867 ms |

Later the same day, at load 70–110, port 22 stopped answering SYNs at all (not refused; dropped)
while the host still answered ping, and it took a hard reboot to recover.

**`bica run` needed the tunnel's watchdog after all.** The assumption that test suites print
constantly and so die of `SIGPIPE` was wrong for a typecheck, which is silent until it ends: one
dropped run left 25 processes behind, one holding a port the next run needed. Two things were wrong
with the watchdog itself once it was run for real rather than read:

- It killed the pid it started, which for `pnpm <script>` is pnpm, and the node processes under it
  carried on. It signals the process group now.
- It read stdin from a background job. `sh` and `bash` give a background job `/dev/null` when job
  control is off, so the watchdog read EOF at once and killed a healthy command; only zsh, the
  default remote shell, leaves stdin alone. It reads a copy taken on fd 3 now, and its tests run
  under all three shells.

**A claim taken before the remote booted is void, and pid checks cannot tell.** The reboot left seven
claims, their clients dead. One named process groups 798–801 while the freshly booted mini was at pid
539 and climbing: once a long-lived process drew one of those numbers, the claim would have read as
alive, refusing every run with 98, and `bica cancel` would have sent `SIGTERM` to that stranger.
The claim's `t=` stamp and the remote's boot time are both on the remote's clock, so comparing them
needs no cross-machine trust. A 30-second margin sits on the side of honouring, because the boot time
is derived from the clock and moves if the clock is stepped soon after boot.

**Addendum, same day: the watchdog shared more than the pipe.** 0.8.2's watchdog read a copy of the
connection's stdin on fd 3, and the command kept the original as its own stdin. A `dup` shares the
open file description, and with it the `O_NONBLOCK` flag, which Node sets on a pipe it reads. A `cat`
blocked in `read` before that happens is unaffected; one that reaches `read` after gets `EAGAIN`,
exits 1, and the watchdog killed the command. Reproduced locally with a background `node` reading
stdin and a `cat <&3` started a second later: `cat: stdin: Resource temporarily unavailable` after
1s, under zsh, bash and sh. On an idle remote `cat` wins the race; at load 37 it lost, and a test run
was killed four seconds in. It looked like a connection fault rather than a kill because ssh logs
`Exit status -1` for a command that died of a signal, and the classifier's `Exit status ` prefix
match read that as the command answering for itself.

