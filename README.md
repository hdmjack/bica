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

Minimal **`bica.yml`** (simplified `sync:` — `alpha` / `beta` are filled by `prepare`):

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
```

Legacy shape (single named session under `sync:`) is still supported.

`bica prepare` overwrites `alpha` / `beta` with your local tree and `host:path` from env.

## Environment

| Variable | Purpose |
| --- | --- |
| `BICA_SSH_HOST` | SSH target (or TTY prompt) |
| `BICA_REMOTE_PATH` | Remote workspace path (default `~/code/<repo folder name>`) |
| `BICA_LOGIN_SHELL` | Remote shell for non-interactive commands (default `zsh`) |
| `BICA_LOGIN_FLAGS` | Flags for that shell (default `-lc` for zsh) |
| `BICA_DEBUG` | `1` = print remote script on stderr before `ssh` |
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
