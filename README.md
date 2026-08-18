# bica

**Bica** is a small CLI for **remote dev workspaces**: file sync (`prepare` / `start` / `stop` / …), interactive `ssh`, and **argv-safe** remote commands (`bica run …`). It reads **`bica.yml`** at the **Git repository root** (legacy: **`bica-workspace.yml`**). SSH host / remote path can live in **`.bica/local.yml`** (gitignored) or **`BICA_*`** env — run **`bica init`** for an interactive setup.

This tree is designed to live in **its own repository**. The copy under `float-javascript/packages/bica` is wired in via `file:./packages/bica` so the monorepo can depend on it until you publish or subtree-split.

## `bica run`

Remote commands **must** include the `run` subcommand (e.g. **`bica run pnpm test`**). There is no shorthand like `bica pnpm test`.

Only the word `run` is interpreted locally. **Every token after `run` is argv on the remote** (POSIX-quoted, no shell injection). Globals `-y` / `--yes`, `--pm <id>`, `--lane <id|auto>`, `--lanes <N>`, `--ref <rev>` and `--return-flow` are parsed from the **whole** command line and are not sent to the remote — put them **before** `run` for clarity (e.g. `bica --yes run pnpm validate`).

Several `bica run` invocations from one checkout can execute concurrently, each in its own remote workspace — see [Parallel runs (lanes)](#parallel-runs-lanes).

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

```yaml
sync:
  ignore:
    paths:
      - node_modules
      - .git
      - dist
      - ui/src/icons/essentials/Icon*.tsx   # generated by postinstall on each side
```

**Rule of thumb:** if something is gitignored *and* produced by a build or install step, it belongs in
`sync.ignore.paths`. Gitignored-and-generated is the combination that matters; gitignored-and-hand-written
(a `.env`) must keep syncing, or the remote will not have it at all.

Lane runs hit the same trap on a different schedule. A lane pushes once with `rsync --delete` and then
installs, so files generated by *that* install survive the run — but the next run's push deletes them,
and if the install fingerprint says dependencies are current the install is skipped and nothing puts
them back. Same fix.

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

## Parallel runs (lanes)

A single `bica run` owns the whole remote workspace: `remotePath` names one directory, and the run's
sync session is keyed to the repository, so a second concurrent invocation would sync a different
working tree into the same directory *and* terminate the first one's session. Verifying a stacked
branch chain one branch at a time is therefore serial, and a chain long enough makes a full sweep
expensive enough to skip — which is how real failures reach CI unverified.

A **lane** is a reusable remote workspace with its own directory, session name, dependency install and
run lock. Several `bica run` invocations from one checkout can hold different lanes at once.

```bash
bica lanes prepare --lanes 4          # one-time: sync + install in each lane

for b in feat/a feat/b feat/c feat/d; do
  bica --yes run --lane auto --ref "$b" pnpm validate > "verify-$b.log" 2>&1 &
done
wait
```

`--lane auto` takes the first free lane; `--lane <id>` takes a named one and errors if a run holds
it. Pool size comes from `--lanes N`, `BICA_LANES`, or `parallel.lanes` in `bica.yml` (default 4).

### Making it the default

Typing `--lane auto --yes` every time gets old. Put the defaults in `bica.yml`:

```yaml
run:
  lane: auto        # a lane id, `auto`, or `none`/`false` for the default workspace
  assumeYes: true   # auto-confirm the prompts a run needs
```

Then `bica run pnpm lint` is enough. Override per invocation with `--lane <id>`, `--lane none`,
`BICA_LANE`, or `BICA_ASSUME_YES=0`. Flag beats env beats YAML, as everywhere else in bica.

Two things worth knowing before you turn `lane: auto` on:

- **`assumeYes` never authorises `bica lanes clean`.** That confirmation guards a recursive delete of
  remote directories, so it always wants an explicit `-y` on the command line. A setting meant to save
  typing on everyday runs must not quietly consent to deleting things.
- **`bica start` / `stop` / `monitor` act on the default workspace**, which lane runs do not use. A
  long-lived session you started will sit there unused rather than being killed by the next run.

Return-flow still works for ordinary single runs. A lane run pulls artifacts back when it is the only
run in flight — the normal case — and skips only when other runs are live, since several would each
overwrite the last. `--return-flow` forces it. (Two runs starting in the same instant can both decide
they are alone; the window is milliseconds and the outcome is the same last-writer-wins you get from
two sequential runs.)

### Why lanes are reused rather than created per run

The sync ignores `node_modules`, so a brand-new remote workspace has no dependencies and must install
before it can run anything. Paying that per run would dwarf the time parallelism saves. Lanes are a
small pool of long-lived workspaces instead, so the install is once per lane — `bica lanes prepare`
gets it out of the way up front, and `bica lanes list` shows which lanes are warm:

```
pool size: 4
base workspace: devbox:~/code/float-javascript

  1        free  warm
           devbox:~/code/float-javascript-lane-1
  2        busy  warm
           devbox:~/code/float-javascript-lane-2
           held by pid 40812 (since 2026-08-17T11:04:09.221Z): bica run --lane auto --ref feat/b …
```

`bica lanes clean` removes the remote lane workspaces (after confirming). It can only ever target
paths ending in `-lane-<id>`, never the base workspace.

### Disk cost — don't measure it with `du`

A lane holds a full `node_modules`, so lanes look alarmingly expensive: `du -sh` reports ~1.8G per
lane, and `du -shc` across four lanes reports 7.7G as though nothing were shared. **Both numbers are
wrong.**

On APFS, pnpm's default `packageImportMethod: auto` resolves to `clone` — copy-on-write via
`clonefile`. Cloned files get their own inode with `nlink=1`, so `du` neither recognises them as shared
nor dedupes them the way it dedupes hardlinks; it counts every cloned block in full, once per lane.
Checking physical extents (`F_LOG2PHYS_EXT`) shows the store and all four lanes pointing at the
*same* device offsets. An exhaustive walk of one lane's 156,817 files found 99.8% of its 1.35 GiB
clone-shared, with 2.6 MiB genuinely unique (its `.modules.yaml`, `.pnpm/lock.yaml`, and a few patched
packages).

The real cost of a lane is that 2.6 MiB plus APFS metadata for ~197k filesystem objects — expect
low hundreds of MB, not ~2G. Measure it at the container level, where allocated blocks are counted
once:

```bash
diskutil info /System/Volumes/Data | grep 'Container Free Space'   # before and after
```

Two consequences:

- Don't size the pool around `du` output. If lanes appear to be consuming tens of gigabytes, check
  container free space before believing it. `bica lanes list` shows which lanes exist; `bica lanes
  clean` reclaims them.
- Don't force `packageImportMethod: hardlink` to "fix" this. Hardlinks make the store and the lane the
  same inode, so anything that writes in place — a patch, a postinstall, a build — corrupts the shared
  store. Clone is both safer and already what you get.

If lane install *time* becomes the problem, pnpm's `enableGlobalVirtualStore` is the feature aimed at
exactly this (its own docs recommend it for parallel checkouts and multi-agent development). It is
experimental, with known ESM `NODE_PATH` and TypeScript inference edge cases, so treat it as an
optimisation to try rather than a default.

### `--ref`: what a sweep actually needs

One checkout holds one branch, so a sweep cannot pin thirteen branches from the working tree — and a
`git checkout` landing while another lane is still syncing leaves that lane holding a mix of two
branches. `--ref <branch|tag|commit>` reads the content out of the object database via a throwaway
`git worktree`, so **no checkout happens at all**: local git can sit on any branch, or mid-rebase,
while every lane runs. Uncommitted work is not part of a `--ref` run; that is the right semantics for
verifying a branch chain and the wrong one for "run what I have open".

With `git.sync` on, a `--ref` run also repoints the lane's remote `HEAD` at the pinned ref, so
`vitest --changed`-style commands resolve the branch being verified rather than whatever is checked
out locally.

### What a lane run does differently

- **One rsync instead of a live session.** A lane pins its content at the start rather than
  continuously following the checkout, which is what makes concurrency safe. The trade: edits made
  after a lane run starts are not picked up by it. Interactive development keeps using the default
  (no `--lane`) run, which is unchanged — live Mutagen session, return-flow on, same behaviour as
  before lanes existed.
- **Every run names the content it verified.** A git tree OID, taken from the ref for `--ref` runs and
  from a throwaway index (`git write-tree`, so your real index and HEAD are untouched) otherwise. The
  name is printed, so a caller can compare what was verified against what they meant to verify.
- **Live-tree runs abort if the tree moves.** Without `--ref`, bica compares that OID either side of
  the transfer and refuses if it changed, naming both values. There is no retry: you want to know your
  tree is moving under you, not have bica quietly try again. Caveat: `git add -A` respects
  `.gitignore`, so the OID names *tracked* content — rsync still ships ignored files, but changes to
  them do not alter the name.
- **The remote refuses to report a stolen result.** The run writes its name into `.bica-run` in the
  workspace and re-checks it after the command. If another run replaced the workspace mid-command, the
  result is discarded with **exit 97** rather than reported. This is what keeps the lane lock out of
  the correctness story: a lock failure costs a re-run, not a wrong answer.
- **Return-flow follows whether you are alone.** It mirrors remote artifacts into the local tree with
  `--delete`, so it describes exactly one branch. One run at a time pulls as usual; with other runs in
  flight it skips, because each would overwrite the last. `--return-flow` forces it, and pulls are
  serialised so two lanes cannot rsync into the same tree at once.
- **Sibling sessions are left alone.** `bica run` still clears stale sync sessions before starting,
  but only those pointed at *its own* remote workspace. A session for this checkout pointed somewhere
  that is neither this workspace nor a lane (typically a leftover from an earlier `remotePath`) is
  reported rather than terminated.

### Plugin concurrency

Remote installs are serialised across lanes: each lane installs into its own workspace, but they
share one content-addressed store on the host. `bica lanes prepare` avoids the situation entirely;
the lock covers a cold lane installed mid-sweep. Nothing else needs serialising — credentials plugins
run only under `bica credentials sync`, never as part of `bica run`, and remote-shell plugins only
build a shell string.

### Two concurrent default runs

The default workspace is locked too. A second `bica run` without `--lane` fails immediately, naming
the process that holds it, rather than silently executing against another run's files.

### Verifying it

`scripts/verify-parallel.sh` checks isolation rather than mere concurrency: a known-green and
known-red ref run at once must each report their own outcome; the lanes' remote `HEAD`s must differ
afterwards; two runs told to share a lane must have exactly one refused; a run raced against a
churning tree must fail loudly; and a sweep must beat the serial equivalent.

```bash
scripts/verify-parallel.sh --green main --red feat/known-broken \
  --sweep feat/a,feat/b,feat/c,feat/d -- pnpm validate
```

## Environment

| Variable | Purpose |
| --- | --- |
| `BICA_SSH_HOST` | SSH target (or TTY prompt) |
| `BICA_LANES` | Lane pool size for `--lane auto` (overrides `parallel.lanes`; default 4) |
| `BICA_LANE` | Default lane for `bica run`: `<id>` \| `auto` \| `none` (overrides `run.lane`) |
| `BICA_ASSUME_YES` | `1`/`0` = auto-confirm `bica run` prompts (overrides `run.assumeYes`; never applies to `lanes clean`) |
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
