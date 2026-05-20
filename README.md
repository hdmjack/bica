# bica

**Bica** is a small CLI for **remote dev workspaces**: file sync (`prepare` / `start` / `stop` / …), interactive `ssh`, and **argv-safe** remote commands (`bica run …`). It reads **`bica.yml`** at the **Git repository root** (legacy: **`bica-workspace.yml`**). SSH host / remote path can live in **`.bica/local.yml`** (gitignored) or **`BICA_*`** env — run **`bica init`** for an interactive setup.

This tree is designed to live in **its own repository**. The copy under `float-javascript/packages/bica` is wired in via `file:./packages/bica` so the monorepo can depend on it until you publish or subtree-split.

## `bica run`

Remote commands **must** include the `run` subcommand (e.g. **`bica run pnpm test`**). There is no shorthand like `bica pnpm test`.

Only the word `run` is interpreted locally. **Every token after `run` is argv on the remote** (POSIX-quoted, no shell injection). Globals `-y` / `--yes` and `--pm <id>` are parsed from the **whole** command line and are not sent to the remote — put them **before** `run` for clarity (e.g. `bica --yes run pnpm validate`).

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

### Return-flow (test snapshots back from remote)

Mutagen `one-way-replica` only pushes **local → remote**, so artifacts generated on the remote (Jest/Vitest snapshot files, screenshot diffs, etc.) never reach your laptop. **`bica run`** automatically `rsync`s a whitelist of patterns **remote → local** after the remote command exits (success or fail — failing tests still write snapshot diffs you want).

Defaults (used when `returnFlow:` is absent from `bica.yml`):

```yaml
returnFlow:
  paths:
    - "**/__snapshots__/**"
    - "**/*.snap"
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
