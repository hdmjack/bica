# bica

**Bica** is a small CLI for **remote dev workspaces**: file sync (`prepare` / `start` / `stop` / …), interactive `ssh`, and **argv-safe** remote commands (`bica run …`). It reads **`bica.yml`** at the **Git repository root** (legacy: **`bica-workspace.yml`**). SSH host / remote path can live in **`.bica/local.yml`** (gitignored) or **`BICA_*`** env — run **`bica init`** for an interactive setup.

This tree is designed to live in **its own repository**. The copy under `float-javascript/packages/bica` is wired in via `file:./packages/bica` so the monorepo can depend on it until you publish or subtree-split.

## `bica run`

Remote commands **must** include the `run` subcommand (e.g. **`bica run pnpm test`**). There is no shorthand like `bica pnpm test`.

Only the word `run` is interpreted locally. **Every token after `run` is argv on the remote** (POSIX-quoted, no shell injection). Globals `-y` / `--yes`, `--pm <id>`, `--ref <rev>` and `--return-flow` are parsed from the **whole** command line and are not sent to the remote — put them **before** `run` for clarity (e.g. `bica --yes run pnpm validate`).

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

Pinned runs (`--ref`, or several commands at once) hit the same trap on a different schedule. They push
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
bica --yes run pnpm lint -- pnpm typecheck -- pnpm test:run
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

### Verifying a branch without checking it out

```bash
bica --yes run --ref feat/my-branch pnpm validate
```

`--ref` runs a branch, tag or commit's **committed** content via a throwaway `git worktree`. No
checkout happens, so your local tree is untouched and git can be on any branch — or mid-rebase — while
it runs. This is what makes verifying a stacked chain practical: the work stops being blocking, even
though it still takes as long.

Uncommitted work is not included, which is the right semantics for verifying a branch and the wrong
one for "run what I have open". For that, use a plain `bica run`.

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

Every pinned run states what it is about to do, on stderr, so it survives redirection to a log file:

```
[bica] workspace mini:~/code/repo  content feat/my-branch (a1b2c3d4e5f6)  run 40812
```

The content name is a git tree OID, so it can be compared against what you meant to verify. It covers
tracked and untracked-but-not-ignored files; changes to gitignored files do not alter it, though the
sync still ships them.

## Environment

| Variable | Purpose |
| --- | --- |
| `BICA_SSH_HOST` | SSH target (or TTY prompt) |
| `BICA_ASSUME_YES` | `1`/`0` = auto-confirm `bica run` prompts (overrides `run.assumeYes`) |
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
