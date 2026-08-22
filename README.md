# bica

**Bica** is a small CLI for **remote dev workspaces**: file sync (`prepare` / `start` / `stop` / …), interactive `ssh`, and **argv-safe** remote commands (`bica run …`). It reads **`bica.yml`** at the **Git repository root** (legacy: **`bica-workspace.yml`**). SSH host / remote path can live in **`.bica/local.yml`** (gitignored) or **`BICA_*`** env — run **`bica init`** for an interactive setup.

This tree is designed to live in **its own repository**. The copy under `float-javascript/packages/bica` is wired in via `file:./packages/bica` so the monorepo can depend on it until you publish or subtree-split.

## `bica run`

Remote commands **must** include the `run` subcommand (e.g. **`bica run pnpm test`**). There is no shorthand like `bica pnpm test`.

Only the word `run` is interpreted locally. **Every token after `run` is argv on the remote** (POSIX-quoted, no shell injection). Globals `-y` / `--yes`, `--pm <id>` and `--return-flow` are parsed from the **whole** command line and are not sent to the remote — put them **before** `run` for clarity (e.g. `bica --yes run pnpm validate`).

Several commands can run concurrently in one workspace — see [Running several commands at once](#running-several-commands-at-once).

## Install

The package is **`private: true`** until you cut a first release; flip that off in **`package.json`** when publishing.

```bash
npm install -g bica
# or: pnpm add -g bica
```

Until published, use **`pnpm link --global`** from this repo after `pnpm install`, or consume **`file:`** / **`git+https:`** from another project.

## Quick start (fresh repo)

1. **Prerequisites:** Node ≥ 22, Git, SSH, and a file-sync CLI on PATH (Bica prints install hints if it’s missing), repo cloned on the remote at `BICA_REMOTE_PATH` (default `~/code/<repo-basename>`).
2. At the **Git root**, run **`bica init`** (or add **`bica.yml`** yourself). Init uses the **[`prompts`](https://github.com/terkelg/prompts)** library so suggested SSH host and remote path appear **in the input field** for editing, not only in brackets after the question.
3. Set **`BICA_SSH_HOST`** / **`BICA_REMOTE_PATH`** or let **`bica init`** write **`.bica/local.yml`**.
4. Run **`bica prepare`** (writes the sync project file), then **`bica start`**, then e.g. **`bica run pnpm install`**.

Minimal **`bica.yml`** (simplified `sync:` — you set mode/ignore here; **`bica prepare`** injects **local** and **remote** paths into `.bica/project.yml`):

```yaml
bica:
  pluginMode: auto
  packageManagerPlugins:
    - pnpm
  credentialsPlugins:
    - npmrc
sync:
  mode: one-way-replica
  ignore:
    paths:
      - node_modules
      - .git
      - dist
```

Legacy shape (single named session under `sync:`) is still supported.

`bica prepare` writes your **local** repository root and **remote** `host:path` from env into `.bica/project.yml`.

### Sync ignores and TypeScript `dist/`

For **composite** / project-reference monorepos, dependents often typecheck against **`dist/*.d.ts`** from workspace packages. If Mutagen **syncs `dist/`** from your laptop while **`src/`** changes without a matching local rebuild, the remote can see **stale declarations** next to fresh source (missing exports, wrong property names, etc.). **`pnpm install` does not fix that.**

**Recommendation:** add **`dist`** to `sync.ignore.paths` (Mutagen treats it like gitignore: any directory named `dist` under the repo root). The **remote** **`pnpm typecheck`** / **`tsc --build`** then rebuilds `dist` from the synced source. **Tradeoff:** the remote no longer receives prebuilt emit from **local** via sync; anything that needs emit must **build on the remote** (normal for typecheck/CI-style commands).

After changing `ignore.paths`, **restart the sync session** (`bica stop` then `bica start`, or terminate/recreate the Mutagen project) so the new rules apply. If the **remote** already has bad `dist/` trees, remove them once there (or let the next full build overwrite them once `dist` is no longer synced from a stale **local** tree).

### Generated files the remote owns

The `dist` case above is one instance of a general trap, and the general form is worth stating
because it bites in a way that looks like a code error.

`one-way-replica` makes the remote an **exact mirror** of your machine. A file the remote generates
but your machine does not have is not "extra" — it is a difference, and the sync removes it. When the
generator is a `postinstall`, that means the install produces the files and the live session deletes
them again while your command runs.

It only bites when the files are missing *locally*, so a checkout where you have run the generator
yourself never sees it, and a fresh clone or a new `git worktree` sees it immediately. That asymmetry
is what makes it read as a code error rather than a sync one.

A real example from `float-javascript`: `ui/src/icons/essentials/.gitignore` ignores `Icon*.tsx`, and
`ui/package.json`'s `postinstall` generates exactly those. Point bica at a worktree that has never
installed locally and the remote typecheck fails with hundreds of `TS2307 Cannot find module
'@float/ui/icons/...'` — the modules were generated, then deleted.

The fix is the same as for `dist`: name the generated output in `sync.ignore.paths` so each side owns
its own copy.

**That protects copies that already exist. It does not create them.** On a workspace where the output
is simply absent — a fresh remote directory, or a local `git worktree` that never installed — nothing
puts it there: the install fingerprint keys on the lockfile, a worktree does not change the lockfile,
so the install never runs and `postinstall` never runs with it. Declare it instead, and bica does
both:

```yaml
generated:
  paths:
    - ui/src/icons/essentials/Icon*.tsx
    - "!ui/src/icons/essentials/IconSpinner*.tsx"   # committed, not generated
  command: pnpm --filter @float/ui run generate-icons:force
```

Before each run bica asks the remote whether those paths exist and, if any are missing, runs
`command` there to produce them. Declaring a path also excludes it from the sync, so you do not
write it twice.

Three things worth knowing:

- **`command` is not optional in practice.** Falling back to the package manager's install is a
  guess and usually a wrong one — `pnpm install` skips `postinstall` entirely when the lockfile is
  already satisfied, so the repair succeeds and generates nothing.
- **Negations are matched, not merely skipped.** A committed file that also matches the generated
  pattern would otherwise answer the question on behalf of every file that is genuinely missing.
- **A probe that cannot run reports nothing missing.** Forcing a repair because a connection blipped
  would be worse than the failure it prevents.

```yaml
sync:
  ignore:
    paths:
      - node_modules
      - .git
      - dist
      - ui/src/icons/essentials/Icon*.tsx   # generated by postinstall on each side
```

**The rule, precisely:** a file the remote produces and your machine does not have gets deleted. That is
the whole predicate — present remotely, absent locally — and such files belong in `sync.ignore.paths`
so each side owns its own copy.

`.gitignore` has nothing to do with it. **Neither the Mutagen session nor the pinned rsync reads
`.gitignore`**; both take their ignore list only from `sync.ignore.paths`. The icon failure is the proof:
those files *are* gitignored, and were deleted anyway. Gitignore is merely the usual *reason* a
generated file is absent locally — untracked, so a fresh clone lacks it — which is why
"gitignored and generated" is a useful smell rather than the mechanism.

The two neighbouring cases follow from the real predicate, not from the smell:

- **Generated but committed** — present locally, so it syncs and is never deleted. No action needed.
- **Gitignored but hand-written**, such as a `.env` — present locally, so it is pushed and the remote
  gets it. Leave it out of `sync.ignore.paths`, or the remote will never receive it at all.

Where `.gitignore` *does* apply is the content name. `bica` derives a run's tree OID with `git add -A`,
which honours it, so the name covers tracked and untracked-but-not-ignored files and excludes the rest.
The transport therefore ships bytes the name does not describe: two runs differing only in a gitignored
file share a content name, and a `.env` edited mid-transfer will not trip the moved-tree check.

Multi-command runs hit the same trap on a different schedule. They push
once with `rsync --delete` and then install, so files generated by *that* install survive the run — but
the next push deletes them, and if the install fingerprint says dependencies are current the install is
skipped and nothing puts them back. Same fix. bica now names the deleted files rather than doing it
silently.

### Return-flow (test snapshots back from remote)

Mutagen `one-way-replica` only pushes **local → remote**, so artifacts generated on the remote (Jest/Vitest snapshot files, screenshot diffs, etc.) never reach your laptop. **`bica run`** automatically `rsync`s a whitelist of patterns **remote → local** after the remote command exits (success or fail — failing tests still write snapshot diffs you want).

Defaults (used when `returnFlow:` is absent from `bica.yml`):

```yaml
returnFlow:
  paths:
    - "**/__snapshots__/**"
    - "**/*.snap"
    - "*.log"
```

Add your own patterns (gitignore-style globs):

```yaml
returnFlow:
  paths:
    - "**/__snapshots__/**"
    - "**/*.snap"
    - "**/*.png"            # visual snapshots
    - "test-results/**"     # Playwright traces
```

Set `paths: []` to disable. Whitelisted patterns are also auto-added to the forward session's `sync.ignore.paths`, so a stale local snapshot will not overwrite the fresh remote one. Disable per-run with `BICA_RETURN_FLOW=0`. Requires `rsync` on PATH; if missing, bica prints a warning and skips the pull.

### Git-dependent commands (`--changed`, `--since`)

`.git` is excluded from the Mutagen sync, so the remote clone's git history/HEAD/refs do **not** match local. Commands that resolve files from the commit graph — `vitest --changed origin/master`, `jest --changed`, `turbo --filter=...[ref]` — therefore find nothing on the remote.

Opt in with a top-level `git:` block:

```yaml
git:
  sync: true
```

When enabled, `bica run` does a one-shot `rsync -az --delete` of local `.git` → remote right before the command, mirroring history/HEAD/refs exactly. Keep `.git` in `sync.ignore.paths` (this is a one-shot rsync, not a continuous Mutagen watch — avoids `index.lock` churn). Toggle per-run with `BICA_GIT_SYNC=1`/`0`. Requires `rsync` on PATH; if missing, bica warns and skips.

## Running several commands at once

Separate commands with `--`. They run concurrently in one remote workspace, against one copy of the
files, and each one's output is printed under its own heading:

```bash
bica run pnpm lint -- pnpm typecheck -- pnpm test:run
```

```
===== pnpm-lint =====      <output>
===== pnpm-typecheck ===== <output>
===== pnpm-test-run =====  <output>
[bica] exit codes: pnpm-lint=0 pnpm-typecheck=1 pnpm-test-run=0
```

The run exits non-zero if any command failed, so a caller can branch on a single code rather than
parsing output.

**One workspace, not one per command.** Commands that read the same files do not need separate copies
of them. Measured on a real monorepo, three checks this way against one workspace each: **32 s vs
43 s**, a third of the disk, one tree sync instead of three, and one `dist` build instead of three
identical ones. The three tools write to disjoint places — eslint to `.eslintcache`, tsc to `dist/`,
vitest to `node_modules/.vite` — so they do not interfere.

This replaced an earlier design that gave each command its own remote workspace from a pool. That
bought nothing for same-content commands: they contend for the same remote CPU either way, so the only
effect was triplicating the sync, the disk and the build. Concurrency is bounded by the remote's cores,
not by bica.

### Two runs at once

The remote workspace is **leased** for the duration of a run. A second run refuses rather than syncing
over the first — including a run launched from a sibling clone that resolves to the same remote path,
which is the case a lock inside one checkout could never see.

A lease whose owner is gone is broken automatically, so a killed run costs the next one a round-trip
rather than the workspace.

### Exit codes

None of these are verdicts on your code:

| code | meaning |
| --- | --- |
| **98** | refused to start; the workspace is in use. Nothing ran. Wait, or use another checkout. |
| **97** | ran, but the workspace was taken part-way through, so the result was discarded. Re-run. |
| **96** | the remote workspace could not be entered. |

### What the run tells you

Every multi-command run states where it is running, on stderr, so it survives redirection to a log
file:

```
[bica] workspace mini:~/code/repo  run 40812
```

## Environment

| Variable | Purpose |
| --- | --- |
| `BICA_SSH_HOST` | SSH target (or TTY prompt) |
| `BICA_REMOTE_PATH` | Remote workspace path (default `~/code/<repo folder name>`) |
| `BICA_LOGIN_SHELL` | Remote shell for non-interactive commands (default `zsh`) |
| `BICA_LOGIN_FLAGS` | Flags for that shell (default `-lc` for zsh) |
| `BICA_DEBUG` | `1` = print remote script on stderr before `ssh` |
| `BICA_SYNC_FLUSH` | `1` = before `bica run`, run `mutagen sync flush` on the primary session so the **remote** finishes catching up to **local** (slower; use if you hit brief sync lag) |
| `BICA_RETURN_FLOW` | `0` = disable the post-`bica run` rsync that pulls whitelisted artifacts (snapshots, etc.) **remote → local** (see "Return-flow" above) |
| `BICA_GIT_SYNC` | `1`/`0` = enable/disable the pre-`bica run` rsync of `.git` **local → remote** (overrides `git.sync` in `bica.yml`; see "Git-dependent commands" above) |
| `BICA_PLUGIN_MODE` | `auto` \| `explicit` |
| `BICA_PACKAGE_MANAGER_PLUGINS` | Comma-separated ids |
| `BICA_CREDENTIALS_PLUGINS` | Comma-separated ids |

## Research notes

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

## Developing bica itself

- **`pnpm build`** / **`bica build`** — **typecheck only** (`tsc --noEmit`), exits when done.
- **`pnpm dev`** / **`bica dev`** — typecheck, **`pnpm link --global`**, PATH hint, then **`tsx watch`** on the CLI (default re-run is silent; use **`pnpm dev -- help`** to print help on each save). **Ctrl+C** exits.

```bash
cd /path/to/bica
pnpm build
pnpm dev
# optional args after -- for the watched CLI:
pnpm dev -- plugins list
```

From the Float monorepo: **`pnpm bica:build`** (typecheck), **`pnpm bica:dev`** (maintainer watch loop).

## Splitting from a monorepo

To move this folder to a dedicated repo: copy **`packages/bica`** (this package root), run **`pnpm install`** there, fix **`repository`** / **`homepage`** in **`package.json`** if URLs differ, then in the monorepo replace the vendored path with **`"bica": "git+https://github.com/org/bica.git#semver:…"`** or a registry version.

## float-javascript (vendored copy)

In the Float monorepo, **`bica`** is **`file:./packages/bica`** on the root package and **`packages/bica`** is listed in **`pnpm-workspace.yaml`** so its dependencies (e.g. **chalk**) link correctly. Use **`pnpm bica`** / **`pnpm remote`** from the monorepo root — those scripts invoke the **`bica`** binary from `node_modules`. **`pnpm bica:build`** typechecks bica; **`pnpm bica:dev`** runs the maintainer watch loop.
