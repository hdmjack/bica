# bica

### Run your commands on a machine that isn't your laptop.

[![license MIT](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#requirements)
[![latest tag](https://img.shields.io/github/v/tag/hdmjack/bica?style=flat-square&label=latest&color=5c4ee5)](CHANGELOG.md)

[Install](#install) · [Quick start](#quick-start) · [`bica doctor`](#when-something-is-wrong-bica-doctor) · [Troubleshooting](#troubleshooting) · [Compiled projects](#builds-that-are-not-a-package-manager) · [Long builds](#runs-that-outlast-the-caller) · [`bica tunnel`](#bica-tunnel--a-process-that-stays-reachable-at-a-local-path)

```bash
bica run pnpm test          # on the remote, against this exact tree
```

**bica** mirrors the repository to a machine you can already `ssh` into, runs the command there, and
streams the output back. A test suite that takes your laptop's fans to maximum runs on the big
machine under your desk instead, and you keep typing.

```
  your laptop                                    the remote
 ┌───────────────┐                              ┌───────────────┐
 │ your checkout │ ──── sync (rsync/mutagen) ─► │ workspace     │
 │               │                              │  + build/     │
 │ output        │ ◄──── streamed, live ─────── │    it owns    │
 │ artifacts     │ ◄──── pulled when done ───── │               │
 └───────────────┘                              └───────────────┘
            the workspace is leased for the whole run
```

Configuration lives in `bica.yml` at the repository root (shared) and `.bica/local.yml` (yours,
gitignored). Run `bica init` to create both. Background and measurements are in
[docs/research.md](docs/research.md).

<details>
<summary><strong>All sections</strong></summary>

[What it is, and what it is not](#what-it-is-and-what-it-is-not) ·
[Requirements](#requirements) ·
[Install](#install) ·
[Quick start](#quick-start) ·
[`bica doctor`](#when-something-is-wrong-bica-doctor) ·
[Sharing a remote machine](#sharing-a-remote-machine) ·
[`bica run`](#bica-run) ·
[Troubleshooting](#troubleshooting) ·
[Platform support](#platform-support) ·
[Rust checkouts](#rust-checkouts) ·
[One remote build tree](#several-checkouts-one-remote-build-tree) ·
[Builds that are not a package manager](#builds-that-are-not-a-package-manager) ·
[Timestamps and stale objects](#timestamps-and-the-object-that-is-newer-than-its-source) ·
[Runs that outlast the caller](#runs-that-outlast-the-caller) ·
[Outputs from a tree the remote owns](#outputs-from-a-tree-the-remote-owns) ·
[Several commands at once](#running-several-commands-at-once) ·
[`bica tunnel`](#bica-tunnel--a-process-that-stays-reachable-at-a-local-path) ·
[Environment](#environment) ·
[Developing bica itself](#developing-bica-itself)

</details>

## What it is, and what it is not

bica runs your commands on another machine as if they were local. It mirrors the repository to a
remote workspace, runs the command there, and brings back the output — so a long test run uses that
machine's CPU and memory rather than your laptop's.

It does **not** provision anything: you supply a machine you can already `ssh` into, with your
toolchain on it. It does not sync back by default (the remote is a mirror of your tree, not a second
copy you edit). It is not a deployment tool.

## Requirements

**On your machine:** Node 22 or newer, `pnpm`, `git`, `ssh`, `rsync`, and
[Mutagen](https://mutagen.io) (`brew install mutagen-io/mutagen/mutagen`, or the release binaries on
Linux).

**On the remote:** an account you can reach with `ssh <host>` without typing a password, the
toolchain your commands need (Node, pnpm, cargo — whatever you intend to run), and OpenSSH 6.7 or
newer if you want `bica tunnel`. bica creates the workspace directory itself; you do not clone
anything there.

**Platforms:** macOS and Linux, on both ends. On Windows, use WSL2 and keep the clone inside the
Linux filesystem — bica depends on Unix sockets, POSIX signals and rsync path syntax, none of which
behave on native Windows. See [Platform support](#platform-support).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/hdmjack/bica/main/install.sh | bash
```

Or, if you would rather not pipe a script into a shell — a reasonable preference — do what it does:

```bash
pnpm add -g hdmjack/bica
```

That is the whole install: it brings its own dependencies and needs no build step. Check it with
`bica --version`. Pin a version with `pnpm add -g hdmjack/bica#v0.1.0` (or `install.sh --version
v0.1.0`), and update with the same command naming a later tag.

The script adds the preflight the bare command has no room for: it checks Node is new enough before
installing rather than letting tsx fail later with an error that names a file in `node_modules` and
says nothing about versions, names both ways to get `pnpm` if it is missing, and warns before
replacing a `bica` that currently runs from a local checkout. `--dry-run` prints what it would do.
It is also written so that a download cut off part-way through refuses to run at all, which an
ordinary script does not — see the comment at the top of
[`install.sh`](install.sh) for why that takes a brace group.

pnpm prints `dependencies have build scripts that were ignored: esbuild` and that is expected —
esbuild arrives through tsx, ships a prebuilt binary for your platform, and has nothing to build.

`bica --version` tells you what you have, and the [CHANGELOG](CHANGELOG.md) says what changed — worth
reading before updating, because two entries so far change what an *older* bica sees on a shared
remote.

**Working on bica itself** wants a clone instead:

```bash
git clone git@github.com:hdmjack/bica.git && cd bica && pnpm install && pnpm link --global
```

## Quick start

From the root of the repository you want to run commands for:

```bash
bica init          # asks for the ssh host and remote path, writes bica.yml and .bica/local.yml
bica run pnpm install
bica run pnpm test
```

That is the whole loop. `bica run` syncs the tree and runs the command; there is no separate sync
step to remember.

`bica init` writes two files. **`bica.yml`** is the repository's own configuration — what to ignore
when syncing, which plugins to use — and belongs in version control, so everyone working on the repo
shares it. **`.bica/local.yml`** holds your ssh host and remote path, which are yours alone, and must
stay out of version control; init adds `.bica/` to the repository's `.gitignore` for you.

Minimal `bica.yml`:

```yaml
bica:
  pluginMode: auto
sync:
  mode: one-way-replica
  ignore:
    paths:
      - node_modules
      - .git
      - dist
```

## When something is wrong: `bica doctor`

```bash
bica doctor
```

It checks what bica needs at both ends — Node, ssh, rsync and Mutagen here; the configuration; whether
the host answers; the login shell; the toolchain on the remote, using the same PATH a run uses; and
whether OpenSSH there is new enough for `bica tunnel` — and prints a line for each with what to do
about anything missing. Every check is independent, so a machine with three things wrong reports three
things rather than the first one.

It exits non-zero when something would stop a run, so it is also the thing to put in a setup script.

## Sharing a remote machine

bica assumes **one remote workspace directory per person**. The default remote path includes your
username (`~/code/<user>/<repo>`) for exactly this reason: two people pointing at the same directory
do not merely queue up behind each other, they overwrite each other's trees and reinstall from each
other's lockfiles.

Separate Unix accounts on the remote are better still, and are the only arrangement in which
`bica tunnel`'s sockets, the credentials sync and `bica cancel` are properly isolated. A single
shared login is not recommended.

The remote workspace is **leased** for the duration of a run: a second run against the same workspace
refuses with exit 98 rather than syncing over the first. That is per workspace directory, so with one
directory each you will never see it.

## `bica run`

Remote commands **must** include the `run` subcommand (e.g. **`bica run pnpm test`**). There is no
shorthand like `bica pnpm test`.

Only the word `run` is interpreted locally. **Every token after `run` is argv on the remote**
(POSIX-quoted, no shell injection). Globals `-y` / `--yes`, `--pm <id>`, `--return-flow` and
`--write-back` are parsed from the **whole** command line and are not sent to the remote — put them
**before** `run` for clarity (e.g. `bica --yes run pnpm validate`).

Several commands can run concurrently in one workspace — see
[Running several commands at once](#running-several-commands-at-once).

## Troubleshooting

**`Could not reach <host> over ssh … nothing ran` (exit 96).** bica never reached the remote. Check
`ssh <host>` works from the same shell. The line below it is ssh's own explanation.

**`<host> has no \`zsh\`` (exit 96).** bica runs your commands under a login shell, `zsh` by default,
because that is where version managers put your toolchain on PATH. On a remote without it, set
`BICA_LOGIN_SHELL=bash`.

**`This remote workspace is in use …` (exit 98).** Another run holds the lease — genuinely, since
this message is no longer used for connection failures. Either wait, or see who holds it and end it
with `bica cancel`. If you share a remote path with someone else, stop: give each person their own.

**`Another run replaced this workspace's contents …` (exit 97).** Your command ran, but another run
took the workspace part-way through, so the result describes a mixture of two trees and is discarded.
Re-run it. Nothing here is a verdict on your code.

**`the connection to <host> dropped part-way through` (exit 95).** ssh lost the session while your
command was running, so nobody knows how it ended — bica says so rather than reporting ssh's own
255 as the command's result. Re-run it. If a run left something going on the remote, the line below
names it. Frequent drops on a long run usually mean the link sleeps: `ServerAliveInterval` is
already set, and `BICA_SSH_OPTS` can raise `ServerAliveCountMax` further.

**A tunnel goes quiet and then recovers.** A forward gives up after about a minute of unanswered
keepalives, logs the drop, and re-establishes itself; requests that were in flight are ended so the
client gets an error rather than waiting on a socket whose other end is gone. If your link stalls
for longer than that legitimately, raise `BICA_TUNNEL_DEAD_AFTER`.

**The first sync of an empty workspace is seeded in one transfer.** Mutagen is a good incremental
mirror and a slow first copy — it stages a 180,000-file tree a file at a time, each with its own
round trip. When the remote workspace is empty, bica fills it with one `rsync` first and lets Mutagen
take over from there. Only when it is *empty*: a workspace with files in it raises questions about
which side is newer that are Mutagen's to answer, and an empty one cannot lose anything. The seed
honours `sync.ignore.paths`, so it never pushes a local `node_modules` over the remote's or invents a
`build/` the remote owns. A seed that fails is not fatal — the run goes on, more slowly, as it did
before.

**A first sync of a large repository takes a long time.** That is expected, and bica now waits for
it rather than giving up on a clock. It reports where it has got to every ten seconds
(`Copying to the remote: 41,200/180,633 files`), and the wait ends only when the sync stops making
any progress at all for a minute — at which point it says so and exits **94** without running the
command, because a command run against a half-copied tree reports its own exit code as if it had
seen the files. bica used to wait sixty seconds and then run anyway.

**Every request to a tunnel is refused, and its log says nothing.** A unix socket is a path, and a
path is not owned: anything may unlink it and bind its own there. When that happens the tunnel keeps
its socket and its descriptor but no longer has the name, so clients get `ECONNREFUSED` while
`--list` still shows the tunnel up and its log stays on whatever it last said. A tunnel now checks
every thirty seconds that its path still leads to it. If the path was replaced by a socket nothing
is serving, it says so and takes the name back; if something else is genuinely serving there, it
says so and stops rather than fighting over the path.

**A tunnel says it could not bind the forward.** The message quotes ssh. A connect timeout or a
refused connection means the host was unreachable and nothing was forwarded — the next client tries
again. Only when ssh reports that unix-socket forwarding is unsupported does the OpenSSH version
matter; that needs 6.7 or later on both ends.

**A command cannot find a module it should have.** The remote installs when your lockfile differs
from what that workspace last installed. If you suspect the record is wrong, `bica run pnpm install`
forces it.

**Before anything else, run `bica doctor`** — most first-run trouble is one of the things it checks.

**Reporting a problem:** include `bica doctor` output, the exit code, the `[bica]` lines, and the
output of `BICA_DEBUG=1 bica run <your command>`, which prints the script bica sent to the remote.

## Platform support

| | Supported |
| --- | --- |
| macOS, local and remote | Yes — the primary development platform |
| Linux, local and remote | Yes. Set `BICA_LOGIN_SHELL=bash` if the remote has no zsh |
| Windows, native | **No.** rsync misreads `C:\` as a hostname, Unix-socket tunnels cannot bind, and signal-based teardown leaves leases and sockets behind |
| Windows, via WSL2 | Yes, as Linux. Keep the clone inside the Linux filesystem rather than `/mnt/c`, or sync is slow and file watching unreliable. `bica tunnel` sockets are reachable from WSL-side clients only |


`bica prepare` writes your **local** repository root and **remote** `host:path` from env into `.bica/project.yml`.

### Sync ignores and TypeScript `dist/`

For **composite** / project-reference monorepos, dependents often typecheck against **`dist/*.d.ts`** from workspace packages. If Mutagen **syncs `dist/`** from your laptop while **`src/`** changes without a matching local rebuild, the remote can see **stale declarations** next to fresh source (missing exports, wrong property names, etc.). **`pnpm install` does not fix that.**

**Also ignore `*.tsbuildinfo`.** A composite build writes `dist` and a record of what is in it, and
`tsc --build` reads that record to decide which packages are already current. Ignoring `dist` alone
sends the record while withholding what it describes, so the remote skips rebuilding packages it has
been told are current and typechecks consumers against whatever `dist` the last branch left there —
several dozen type errors in a package that compiles cleanly locally and in CI, sticky until a forced
rebuild.

Since 0.8.7 bica adds `*.tsbuildinfo` itself when `dist` is ignored and bica.yml says nothing about
tsbuildinfo, the way it adds `target` for a Rust repository; a config that mentions it, to ignore it
or with `!` to send it, is left as written. `bica doctor` suggests writing the line into bica.yml
anyway, so a teammate on an older bica gets the same behaviour.

A workspace that has already run without it holds `*.tsbuildinfo` files copied from a laptop, and an
ignored file is no longer deleted by the sync, so remove them once on the remote:
`find <workspace> -name node_modules -prune -o -name '*.tsbuildinfo' -print -delete`. The next
`tsc --build` there rebuilds once and writes records that match its own `dist`.

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

A real example: a package whose `.gitignore` ignores generated `Icon*.tsx`, and
`ui/package.json`'s `postinstall` generates exactly those. Point bica at a worktree that has never
installed locally and the remote typecheck fails with hundreds of `TS2307 Cannot find module
'@acme/ui/icons/...'` — the modules were generated, then deleted.

The fix is the same as for `dist`: name the generated output in `sync.ignore.paths` so each side owns
its own copy.

**That protects copies that already exist. It does not create them.** On a workspace where the output
is simply absent — a fresh remote directory, or a local `git worktree` that never installed — nothing
puts it there: the install record keys on the lockfile, a worktree does not change the lockfile,
so the install never runs and `postinstall` never runs with it. Declare it instead, and bica does
both:

```yaml
generated:
  paths:
    - ui/src/icons/essentials/Icon*.tsx
    - "!ui/src/icons/essentials/IconSpinner*.tsx"   # committed, not generated
  command: pnpm --filter @acme/ui run generate-icons:force
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

**Presence is not freshness.** A pattern like `Icon*.tsx` is satisfied by last week's icons, so an SVG
added on master — with no lockfile change — leaves the remote one component short and the probe
content. Name what the output is made from, and bica reruns `command` whenever those files differ
from what the remote last generated from:

```yaml
generated:
  paths:
    - ui/src/icons/essentials/Icon*.tsx
  inputs:
    - ui/src/icons/essentials/assets/*.svg
  command: pnpm --filter @acme/ui run generate-icons
```

`inputs` are git pathspec globs (`*` stays within a directory, `**` crosses them; `!` excludes),
listed from the local tree, untracked files included. They sync as usual. The digest of what was
last generated from lives on the remote beside the install records, so checkouts sharing a workspace
see each other's generations. The first run after adding `inputs` regenerates once, having no record.

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

### The install record lives on the remote

Before a run, bica compares the local lockfile against what the remote workspace last installed, and
installs when they differ. That record is kept **on the remote**, in `~/.bica/installs`, beside the
workspace leases and deliberately outside any synced tree.

It used to live in the local checkout, and that was wrong in a way that only shows up with sibling
worktrees. The record describes one remote `node_modules`, and several checkouts can share one remote
path — which is the normal arrangement when you keep worktrees for different branches. So:

1. Checkout A adds a dev dependency, runs, and bica installs it.
2. Checkout B, pointing at the same remote path with a lockfile that lacks it, runs anything. bica
   reinstalls from B's lockfile, and the dependency is pruned.
3. Checkout A runs again. Its own lockfile has not changed and its own record still matches it, so
   bica skips the install — and the command fails on a module that is no longer there.

Nothing in that sequence is wrong except where the record was kept. On the remote, the record answers
the question actually being asked: what is in *that* `node_modules`. A record is cleared when the
workspace directory is created, since a new directory has installed nothing whatever any record says.

**Upgrading costs one reinstall per workspace.** The old local records are ignored rather than
migrated: believing one would mean assuming the remote still matches it, which is the assumption that
failed. The first run after upgrading reports `No remote install recorded yet` and installs.

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

### Commands that write files (`--write-back`)

The remote gets a *copy* of your tree, so a command that edits files edits the copy. Its output comes
back; its edits do not. `pnpm format` is the case that bites: it prints every path with a duration,
exits 0, and leaves your tree exactly as it was — indistinguishable from having worked, until CI's
lint job fails on Prettier violations in files you believed you had formatted.

**Every run now says what it wrote.** After the command, bica asks the remote which files changed
since the run started and names them:

```
[bica] This command wrote 12 files on the remote. They stay there — your local tree is unchanged:
    apps/web/src/App.tsx
    apps/web/src/routes/index.tsx
    …and 10 more
    Re-run with --write-back to copy them home, or run the command locally.
```

**`--write-back` copies them home too:**

```bash
bica run --write-back pnpm format
```

Only the files the run actually changed are transferred — the list is enumerated, not pattern-matched,
so nothing can match more than was asked for, and there is no `--delete`.

Three things bound what can land in your tree:

- **Files git ignores are dropped.** `node_modules`, `dist` and the rest are ignored for the repo's own
  reasons, so the list of things that must never cross the wire is maintained by the repo rather than
  by bica. Trees in `sync.ignore.paths`, plus `.git` and `.bica`, are pruned before the walk even
  reaches them.
- **A file you edited locally while the run was out is never overwritten.** The push names the exact
  content it shipped (a git tree OID), so bica can tell an untouched file from one you have since
  typed in. Files that moved are named and left alone:

  ```
  [bica] Left 1 file(s) alone: you changed them locally while the run was out, so the remote version
      would overwrite your edits:
        apps/web/src/App.tsx
  ```

  This is what makes it safe to leave a run going in the background and keep working. If bica cannot
  establish a baseline — git could not name the tree — it refuses every file rather than guessing.
- **A discarded run writes nothing back.** After exit 97 (the workspace was taken part-way through)
  the remote files describe a mixture of two trees, so none of them are copied home.

`--write-back` implies a pinned run, even for a single command. A live Mutagen session is
`one-way-replica`: it exists to make the remote an exact copy of local, so it reverts remote-side
writes as it notices them. Pinning is what holds those writes still long enough to bring them back —
it is the mechanism, not a preference. (Detection still runs on the live path, because a reverted write
moves the file's mtime, so bica can still tell you it happened.)

Disable both the detection and the copy with `BICA_WRITE_BACK=0`.

#### Why not simply mirror everything back

Return-flow answers "which paths does the remote own" with a whitelist, and the obvious extension is to
invert it into a denylist and mirror everything else back. That is the wrong axis, for three reasons
that are properties of the whitelist rather than of the patterns in it:

- **The whitelist is what makes `--delete` safe.** Return-flow's trailing `- *` protects every
  non-matching local file from deletion, which is how an obsolete snapshot can be pruned without
  endangering anything else. A denylist plus `--delete` means "remove any local file the remote does not
  have" — and the remote deliberately does not have plenty: gitignored files, your `.env`, everything in
  `sync.ignore.paths`.
- **They fail in opposite directions.** A missing whitelist entry means a snapshot does not come back,
  which shows up as a test diff you notice. A missing denylist entry means the remote's `node_modules`,
  `.next` or `target` crosses the wire into your tree — unbounded, and growing with every ecosystem bica
  supports.
- **A whitelisted path is also removed from the forward sync**, which is how "the remote owns this file"
  is expressed. A denylist names everything, so it cannot make that claim about anything.

Deciding by *what the run changed* is bounded by what actually happened rather than by a pattern
someone guessed at, and detecting the change is the same work as reporting it — which is why the report
is on by default and the copy home is opt-in.

### Git-dependent commands (`--changed`, `--since`)

`.git` is excluded from the Mutagen watch, because a continuous watch fights the local index over
`index.lock`. So before each run bica does a one-shot `rsync -az --delete` of local `.git` → remote,
mirroring history, HEAD and refs exactly. Commands that resolve files from the commit graph —
`vitest --changed origin/master`, `jest --changed`, `turbo --filter=...[ref]`, a `:changed` script —
then resolve the same refs they do locally.

**On by default since 0.8.0.** It used to be opt-in, on the reasoning that `.git` is a lot of bytes
nobody asked for. Measured, it is not: a repository's history is a few large packfiles, so rsync has
almost nothing to walk.

| | `.git` | working tree |
|---|---|---|
| files | 1,953 | 181,755 |
| first sync | 21s | 101s scanning, then the transfer |
| every run after | 0.4s, zero bytes | — |

Against that 0.4s, every checkout used to discover the setting by watching a `:changed` script fail
inside its own tooling, several lines into a stack trace. It was reported twice, once as a defect in
the sync.

Turn it off for a repository whose history really is too large to mirror, or a workspace that has no
use for it:

```yaml
git:
  sync: false
```

The one cost worth knowing: `git gc` or an auto-repack rewrites the packfiles, so the run after one
pays the first-sync price again.

**A `git worktree` works too, as one flattened repository.** In a worktree `.git` is a one-line file
naming an absolute path inside the main clone, and the data is split between that clone's shared
`.git` and a per-worktree directory under it. Copying "`.git`" from there copied a path the remote does
not have, and every history command failed with `not a git repository` — with git sync switched on,
reporting success. bica now copies the shared repository and then this worktree's own state over the
top, so the remote holds an ordinary repository sitting on the worktree's commit. The second copy is
forced rather than compared by size and timestamp, because `HEAD` is the file that decides which
commit the remote is on and two branch names of equal length in a worktree created in the same second
as its clone compare as identical. Keep `.git` in `sync.ignore.paths` (this is a one-shot rsync, not a continuous Mutagen watch — avoids `index.lock` churn). Toggle per-run with `BICA_GIT_SYNC=1`/`0`. Requires `rsync` on PATH; if missing, bica warns and skips.

**When it is off, bica says so before the run, not after.** git's own error is "not a git repository",
printed by the tool that shelled out to it and usually several lines into that tool's output — which
reads as a broken checkout rather than a setting somebody turned off. So when `git.sync` is off and a
command resolves refs (`git …`, `--changed`, `--since`, `--changed-since`, a `--filter=...[ref]`, or a
script name ending in `:changed`), bica says so before the command starts, where none of that output
exists yet, and again after it if the run failed. Every line of it is prefixed `[bica]`: the note used
to prefix only its first line, so the line saying what to change rendered as bare text under the
failing tool's output and was read as the tool's own. It stays quiet otherwise — a note about
repository metadata under every failing test run would train you to skip the whole channel.

**A `.git` left behind by an earlier synced run is warned about before the command starts.** The sync
ignores `.git` rather than deleting it, so one run with `git.sync` on leaves a repository in the remote
workspace permanently; later runs copy new files in around it and leave its refs where that run left
them. That is worse than having none. With no repository the command fails and the failure is read;
with a stale one every ref still resolves, so `--changed` diffs against whatever `origin/master` was
days ago and the command reports a confident answer about a selection nobody asked for — one such run
reported `Linting 405 changed file(s) against origin/master` for a branch that changes 15, then
exhausted node's heap on the other 390, which read as a memory problem on the remote machine. So when
`git.sync` is off and the command resolves refs, bica asks the remote whether it has a repository and,
if it does, names the branch it is on and its newest remote-tracking ref with that ref's date before
running anything. Turn `git.sync` on, or delete the remote `.git` to get the loud failure back. The
probe costs an ssh round-trip and only happens for those runs.

## Rust checkouts

Three things are handled for you.

**`target/` is treated as the remote's.** It is gitignored, so a local checkout usually has none, and
a mirror that deletes what the local side lacks would remove it between runs — making every build a
clean build. For a repository with a `Cargo.toml` or `Cargo.lock`, bica adds `target` to the ignore
list on your behalf. A repository that already mentions `target` is left exactly as written.

**Submodules reach the remote when `git.sync` is on.** The sync ignores `.git` at every level, so a
submodule's own `.git` — a one-line file pointing into the parent's `.git/modules` — never travelled,
while the modules directory it names did, since that lives inside the parent `.git`. The remote ended
up with all the data and nothing addressing it, and `git submodule status` called every submodule
uninitialised, which is what rustc's bootstrap reads. bica now writes those pointers back after the
`.git` copy and says how many.

**A pinned toolchain is checked, not assumed.** rustup reads `rust-toolchain.toml` and installs what
it names — true for a channel or a version, false for `rustup toolchain link blackfin
build/host/stage1`, which exists only where it was run. `bica doctor` checks the remote has it and
says how to link it there when it does not.

One thing worth knowing rather than fixing: the cargo plugin's install preflight is `cargo fetch
--locked`, which populates the registry cache and does not touch the rustup sysroot — so it does not
fight `-Zbuild-std`, which builds into that sysroot.

## Several checkouts, one remote build tree

Sibling worktrees of one fork can share a build directory on the remote, so switching branches stays
incremental. The lease already stops two of them using it at once; what was missing was a way to say
where it is. In `.bica/local.yml`, which is per-machine and gitignored:

```yaml
buildDir: ~/code/llvm-blackfin/build
```

Every remote command then gets it as `$BICA_BUILD_DIR`, so `cmake -B "$BICA_BUILD_DIR"` or
`CARGO_TARGET_DIR="$BICA_BUILD_DIR"` needs no wrapper script.

## Builds that are not a package manager

Two things a cmake, ninja or `./x build` project needs that a Node repo does not.

```yaml
toolchain: [cmake, ninja, ccache, cargo, rustup]
env: [RUSTFLAGS, CARGO_TARGET_DIR]
```

`toolchain:` names what the remote must have on PATH, and `bica doctor` checks it there using the
same PATH a run gets — so a missing `ninja` is one line before you start rather than exit 127 forty
minutes into a build, under a command that looks like it failed.

`env:` names local environment variables to forward to every remote command. ssh forwards nothing by
default, so without this a `RUSTFLAGS` set for the occasion is simply absent on the other side and
the build quietly uses different settings. By name and never wholesale: copying the environment
across would carry credentials, `PATH` and `HOME` into a remote login shell. A declared variable that
is not set locally stays unset remotely rather than becoming empty, and the variables that describe
this machine are refused with a line saying so.

`bica doctor` also states whether an install preflight applies here at all. It matches on the first
word of the command, so a script entry point like `./x build` gets none — correct, and previously
something you had to work out from its absence.

## Timestamps, and the object that is newer than its source

A pinned sync is `rsync -a`, which preserves each file's local mtime. That is right for a tree
nobody is building, and wrong the moment the remote owns a build directory: a file edited at 23:40
while a long build is running arrives on the remote still stamped 23:40, and the object that build
compiled at 23:51 from the *previous* copy is newer than it. ninja, make and cargo's mtime
fingerprinting all compare exactly those two numbers, so they skip the file — not once, but on every
run after it. The build then reports success over an artifact that does not contain the edit.

A pinned run — `--detach`, `--write-back`, `--ref` — stamps the files it delivered with the remote's
own clock, so they are newer than every object in the tree. Only those files: touching anything else
would rebuild work that is still good. Only files whose content changed, too, because stamping
breaks rsync's quick check and a file re-sent purely because bica stamped it must not be stamped
again — otherwise every stamped file rebuilds on every run for ever. The repair settles after one
extra transfer.

An ordinary `bica run` uses the live session, which does not have this problem and needs no repair.
It propagates content rather than timestamps, so a file it delivers carries the remote's own clock
and is already newer than everything built before it — the state the pinned path has to be repaired
into. Measured: a local file stamped 1 January 2025 arrives on the remote stamped with the time of
the transfer, and so does a newly created one.

What the live session does have is the hazard the pinned sync exists to remove. It is designed to go
on pushing while your command runs, so an edit made mid-build lands behind a build that has already
read the files around it, and the artifact is assembled from two versions of the tree. No timestamp
reveals that. For a project with `artifacts:`, `toolchain:`, `buildDir:` or a Rust `target/`, bica
says so on every live run, and `--detach` or `--write-back` pins the tree for the duration.

One known limit: an edit that leaves the file's exact size unchanged looks the same to rsync as
bica's own stamp, so one made to a file stamped on the immediately preceding run is skipped. If a
build ever skips something it should have rebuilt, `touch` the file and run again.

## Runs that outlast the caller

An agent's tool call times out after ten minutes, a CI step often sooner, and bica ends a remote
command when its connection goes — which is right for an ordinary run and makes a 50-minute build
impossible to start from such a caller at all.

```bash
bica run --detach ninja -C build clang   # prints a run id and returns
bica runs                                # what is going, and for how long
bica logs <run-id> --follow              # output as it arrives; closing this does not stop the run
bica wait <run-id>                       # blocks, exits with the command's code, brings artifacts home
```

The command runs on the remote under `nohup`, with its output going to a file there, so nothing local
is holding it up — a dropped link no longer costs an hour of compilation. The tree is pushed once and
then left alone, because a live session would go on mirroring your edits into a workspace that is
being compiled.

The workspace stays leased for the whole run, so a second `bica run` meets 98 rather than syncing over
a build. `bica wait` is what gives it back, along with the exit code and the artifacts; run it before
starting anything else in that workspace, since a later run will break a lease whose command has
finished and that takes the recorded exit code with it. If that happens, `bica wait` says so rather
than reporting somebody else's result.

## Outputs from a tree the remote owns

A build directory has to live on the remote and survive every run: it is gigabytes, it is what makes
the next build incremental, and the local side has no copy, so a mirror with `--delete` removes it as
fast as the build writes it. The way to keep it is `sync.ignore.paths`, and that is also what puts it
out of return-flow's reach — return-flow folds those paths into its own excludes precisely because
they name trees each side owns alone. So the binaries worth having end up in the one place
return-flow is forbidden to look.

`artifacts:` is the explicit exception: a short list of named outputs copied remote → local after the
run, with no mirroring and no `--delete` in either direction.

```yaml
sync:
  ignore:
    paths: [build]
artifacts:
  - build/bin/llc
  - build/bin/clang    # a symlink to clang-23; the local copy is the real binary
  - build/host/stage1/ # a trailing slash means a tree
```

Named one at a time on purpose — a whitelist of specific outputs cannot wander into a 20GB build tree
the way a glob can. Symlinks are followed, so what lands locally is the file and not a link to a path
this machine has not got. Only what changed is transferred, so a run that rebuilt nothing moves
nothing and says so. Each pull is reported the way `--write-back` reports what it wrote, a single
binary by name and a tree by file count. This happens on pinned runs too, without `--return-flow`:
that flag guards a pattern-matched pull into the working tree, and someone who wrote `build/bin/llc`
wants `build/bin/llc`.

An artifact that is not under something the sync leaves alone is named before the run, because the
mirror would delete it and the pull afterwards would find nothing and say nothing.

A copy that fails — the link dropping mid-transfer, say — is named as a warning along with the
stale local path, and a run whose command passed exits **93** for it rather than 0, since 0 is what
a caller reads as "the new binary is here". A command that failed keeps its own code. An artifact
the remote has not got at all is not a failure: running something other than the build that makes
it is the usual reason.

## Running several commands at once

Separate commands with `--also`. They run concurrently in one remote workspace, against one copy of
the files, each with its own connection, and their output is labelled and streamed as it arrives:

```bash
bica run pnpm lint --also pnpm typecheck --also pnpm test:run
```

`--` is not the separator, and used to be. It is how a runner is told that the rest of the line
belongs to the program it runs — `cargo run -p x -- 1 1024`, `pnpm test -- --coverage` — and bica
read those as two commands, ran the first without its arguments and the remainder as a program. One
report arrived after it exited 0, because the binary's defaults happened to be the values that had
been dropped. `--` now passes straight through. For one release, a `--` whose next word names a
program is refused rather than reinterpreted, so a line written for the old meaning cannot quietly
become one long command.

```
[bica] Running 3 commands at once: pnpm-lint, pnpm-typecheck, pnpm-test-run
[pnpm-lint] …
[pnpm-test-run] …
[bica] pnpm-lint finished (exit 0) after 12s
[pnpm-typecheck] …
[bica] pnpm-typecheck finished (exit 1) after 48s
[bica] pnpm-test-run finished (exit 0) after 115s

[bica] exit codes: pnpm-lint=0 pnpm-typecheck=1 pnpm-test-run=0
```

The run exits non-zero if any command failed, so a caller can branch on a single code rather than
parsing output. The `[bica] exit codes:` line goes to stdout and is the machine-readable part;
everything labelled `[bica]` beside it is progress on stderr.

**Output arrives live, which it did not always.** Until 0.2.0 the commands were run by a shell script
generated for the remote, which captured each one to a file and replayed them in order once the
slowest had finished. A run therefore printed nothing at all until it was over: a three-command run
that hung was indistinguishable from one that had never started, and was reported as exactly that
after two silent hours. Coordinating from this side instead means a wedged command is visible within
seconds, and named.

**One workspace, not one per command.** Commands that read the same files do not need separate copies
of them. Measured on a real monorepo, three checks this way against one workspace each: **32 s vs
43 s**, a third of the disk, one tree sync instead of three, and one `dist` build instead of three
identical ones. The three tools write to disjoint places — eslint to `.eslintcache`, tsc to `dist/`,
vitest to `node_modules/.vite` — so they do not interfere.

This replaced an earlier design that gave each command its own remote workspace from a pool. That
bought nothing for same-content commands: they contend for the same remote CPU either way, so the only
effect was triplicating the sync, the disk and the build. Concurrency is bounded by the remote's cores,
not by bica. One connection per command is a different matter from one workspace per command: the
connections are cheap and are what keeps the three output streams apart.

### What a run leaves behind

After a leased run, bica asks whether anything is still running in the process groups that run owned,
and names it if so:

```
[bica] This run left 1 process running on mini: 68622 python clauses.py --socket …
```

It reports and does nothing else. A command may background a server deliberately — a parser keeping a
language model warm between runs is the case this was written against, and killing it would be the
bug. What was missing was anyone noticing when such a server stops behaving: three of them once span
at full CPU for seven days, found when the machine got loud enough to mention. Ten minutes of a broken
idle-timeout is nothing; seven days of three cores is not.

The same line mentions the remote's load when it is above one core's worth per core, and
`bica doctor` reports it any time. There is no background watcher and nothing polls: the moment worth
telling somebody their remote is labouring is when they are about to use it.

### Two runs at once

The remote workspace is **leased** for the duration of a run. A second run refuses rather than syncing
over the first — including a run launched from a sibling clone that resolves to the same remote path,
which is the case a lock inside one checkout could never see.

A lease whose owner is gone is broken automatically, so a killed run costs the next one a round-trip
rather than the workspace. "Gone" means both halves of the run: the local client *and* the remote
shell executing the command, whose pid the run script publishes into the claim. They have different
lifetimes — the remote one follows the ssh connection — and testing only the client is how a lease
gets broken over a run that is still executing. See
[The lease's liveness oracle was the wrong process](docs/research.md#the-leases-liveness-oracle-was-the-wrong-process).

A lease taken before the remote last booted is broken outright, whoever holds it. Nothing it recorded
survived the restart, and its process numbers are reissued from the bottom, so checking them would
find whatever unrelated process drew one. `bica cancel` clears such a lease without signalling
anything, for the same reason.

**A run killed by `SIGTERM` or `SIGHUP` tears itself down** — it ends the remote command and releases
the workspace on the way out — so a caller with a command timeout (a CI step, an agent's shell tool)
no longer leaves an orphan holding the lease. `SIGKILL` cannot do that, because no handler runs.

**The refusal says what it is waiting on.** `in use by run 57074 ... for 1m running \`sleep 200\``.
The age is the difference between two readings of the *remote's* clock — the claim is stamped there
and the refusal asks for the time in the same round-trip — so it never folds clock skew between two
machines into a number presented as elapsed time. The command sits in a sidecar next to the claim,
because the claim itself is one space-delimited line read with `cut` and a command contains spaces.

**`bica cancel`** ends the run holding this workspace and drops its lease, for that case. It refuses
when the holder's client is still alive, or when the run belongs to another machine; `--force`
overrides both. Forcing a live local run signals its *client* and lets it unwind itself, rather than
clearing the claim out from under it.

**`pkill` cannot stop a run.** The process tree is `zsh` → `bica.cjs` → `tsx cli.ts` → `node` → `ssh`,
and a pattern matching `bica.cjs run` or `cli.ts run` leaves the `ssh` — and so the remote command —
running. `bica cancel` or a plain `SIGTERM` to the client is the way; a pattern-matched kill is not.

### Exit codes

None of these are verdicts on your code:

| code | meaning |
| --- | --- |
| **98** | refused to start; the workspace is in use. Nothing ran. Wait, use another checkout, or `bica cancel`. |
| **97** | ran, but the workspace was taken part-way through, so the result was discarded. Re-run. |
| **96** | the remote workspace could not be entered. |
| **94** | the files never got to the remote: the sync stopped making progress, so nothing ran |
| **95** | the command's result never came back: its connection dropped part-way through, or something on the remote killed it with a signal. The remote ends a command whose connection closes; if anything is still running there, the workspace stays leased until it stops, and `bica cancel` ends it. Re-run. |
| **93** | the command passed, but an `artifacts:` entry could not be brought home, so the local copy is stale. Re-run. A failing command keeps its own code. |

### What the run tells you

Every multi-command run states where it is running, on stderr, so it survives redirection to a log
file:

```
[bica] workspace mini:~/code/repo  run 40812
```

## `bica tunnel` — a process that stays, reachable at a local path

`bica run` is for commands that finish. `bica tunnel` is for the ones that stay: it starts a process on
the remote, waits for the Unix socket that process creates, and forwards that socket to a path on your
laptop.

```bash
bica tunnel --local=/tmp/parser.sock --remote=/tmp/parser.sock -- ./serve-parser --socket /tmp/parser.sock
```

Everything before `--` is bica's; everything after is argv on the remote, run in the workspace under the
same login preamble `bica run` uses. The `--` is required rather than inferred, because the remote
command usually has flags of its own.

| Flag | Meaning |
| --- | --- |
| `--local=<path>` | Absolute path for the socket on this machine. A stale socket there is replaced; a regular file or directory is refused rather than deleted. |
| `--remote=<path>` | Where the remote process will create its socket. `~/…` is expanded against the remote's `$HOME`. |
| `--ready-timeout=<seconds>` | How long to wait for that socket before giving up (default 60). |

**The client is told nothing.** Forwarding the socket rather than a port is what makes this worth
having: a client connects to a path, exactly as it did when the server was local, and does not need to
learn a host, a port or a tunnel. The one invariant that matters is that the local socket exists only
while something can actually answer on it — clients of this shape read "the path is absent" as "start a
local one", and that fallback is only correct if bica never leaves a socket behind. So the local socket
is bound only after the remote one exists, and unlinked when either end goes away.

**It holds no workspace lease, and syncs nothing.** A lease held for the hours a tunnel lives would
block every `bica run` from the same checkout, including the test runs that are the reason for wanting
the tunnel in the first place. The tunnel therefore reads whatever the last run synced. That is safe for
the case it was built for because the client names its socket after a digest of the server's own source:
change the source, and the client asks for a socket the old server is not serving, so a stale server
stops being found rather than answering out of date.

**Readiness is an answer, not a file.** A socket file at the remote path proves nothing: a server that
loads a language model takes twenty seconds to bind, and a file left by a previous server that was
killed sits at the path for the whole of that time. So the wait ends on a real `connect()` succeeding,
and `--ready-timeout` governs that. Judging by the file instead meant the forward went up early and the
first request died with `connect failed` — a failure that looks like the tunnel's fault and is not.

**A dropped connection reconnects; it does not end the tunnel.** Resets happen on a busy remote, and a
tunnel is something you leave running for hours beside work making its own ssh connections. When only
the forward drops, bica re-establishes it and checks the server is still answering — no restart, so
nothing reloads. When the server went with it, bica starts it again. Backoff doubles from one second to
thirty, and ten attempts in a row that never serve a request end the tunnel rather than retrying a
command that cannot work. Throughout, the local socket is removed whenever nothing is behind it, which
is what lets a client fall back to a local server instead of failing against a dead path.

**Both ends take the other down.** When the remote process exits of its own accord — a server with an
idle timeout will — the tunnel closes with it. On `Ctrl+C`, `SIGTERM` or `SIGHUP`, the remote process is
stopped before bica exits.

That last part needs more than closing the connection. A command normally learns its caller is gone by
writing to a closed descriptor and taking `SIGPIPE`, which is why `bica run`'s chatty test suites die
promptly; with no PTY in play, sshd sends no `SIGHUP`. A socket server that prints one line and then
waits has nothing to write, so it would be reparented to init and keep its socket — and the next tunnel
would bind a second server beside it. So a tunnel's remote command is wrapped in a watchdog that reads
from a pipe bica holds open and kills the command when that read returns, which happens exactly when the
connection ends.

Needs OpenSSH 6.7 or later at both ends (stream-local forwarding). A forward that cannot be established
fails the whole command rather than connecting without it, since a tunnel that is silently absent looks
to a client exactly like one that was never started.

### The socket is bica's, not ssh's

ssh used to bind the path the client knew about, which tied that path's existence to one particular
remote process. bica now listens there itself and forwards to a private socket underneath. The client
sees no difference — it connects to a path — but the path can now outlive what is behind it, which is
what the restart modes need. The extra hop is a local socket pair; against a model that takes tens of
milliseconds to answer it is not measurable.

**A reply is never cut short at a buffer boundary.** The proxy lets each side's end-of-stream close the
other, rather than destroying a socket when its peer closes: a reply larger than a socket's 16 KiB
buffer is still queued at that moment, and destroying the socket discarded the remainder. Replies that
fit in one buffer were unaffected, which is how it stayed hidden until a 22 KB one arrived as exactly
16,384 bytes and the client reported the server's output as malformed.

### Restarting (`--restart`)

| Mode | When the remote command exits on its own |
| --- | --- |
| `never` (default) | The tunnel closes with it. |
| `on-exit` | It is started again at once, with backoff if it keeps failing. |
| `on-demand` | The socket stays bound and the command is started again when the next client connects. |

**Readiness means something answered, not that a socket file appeared.** bica waits for the remote
socket to exist and then asks the forward whether a connection is actually accepted, using ssh's own
`channel N: open failed` as the negative answer. The file alone is not enough: it is there both for a
working server and for one that died leaving it behind, and bica used to announce `Tunnel up` for
both — after which every request went unanswered while the log said the tunnel was fine.

**For a server that binds before it can answer, tell bica what to wait for.** A model load between
`listen` and the first `accept` is invisible from outside — the kernel queues connections either way,
so no probe can tell that server apart from a working one. The server knows, though, and usually says
so:

```bash
bica tunnel --local=… --remote=… --ready-when='ENTAILMENT READY' -- ./serve-entailment
```

bica then waits for that line instead of inferring anything. Measured against a server that binds in
two seconds and accepts twenty-five seconds later: with the flag, `Tunnel up` lands at twenty-nine
seconds and the first request is answered at once; without it, bica used to announce a tunnel at
eight.

**Without the flag, bica says when requests go unanswered.** It is the proxy, so it sees the bytes: a
request with no reply for twenty seconds gets a line saying so, naming `--ready-when` as the fix.
That does not make the tunnel work, but it replaces twenty minutes of silence against a healthy-looking
log with a sentence about what is actually happening.

**Readiness costs the server one empty connection.** The probe connects and hangs up without asking
anything — the same thing the server sees when a client is interrupted — so a server that treats an
empty request as fatal will be killed by its own readiness check. Servers that read a request and move
on are unaffected; one that crashes on an empty read needs fixing on its own account, since a client
can produce that at any time.

**`on-demand` is the mode for a server with an idle timeout.** Such a server exits precisely so its
memory goes back; restarting it eagerly undoes that, and letting the tunnel close means every later
client finds nothing. On demand, the first client after an exit waits for a start and the rest are
collapsed onto that same start — ten clients arriving during a model load produce one server, not ten
commands racing for the same remote path.

That matters more now that clients report a missing socket rather than quietly doing the work locally:
an absent path is no longer a silent fallback, it is a skipped check.

### Detaching, listing, stopping

```bash
bica tunnel --local=/tmp/parser.sock --remote=/tmp/parser.sock \
  --restart=on-demand --detach -- ./serve-parser
bica tunnel --list
bica tunnel --stop /tmp/parser.sock
```

`--detach` re-executes bica itself in the background with the same arguments minus the flag, so the
detached tunnel is the same code path and not a second one; its output goes to a log beside its record.
**It returns only once something has answered through the tunnel** — the same moment the foreground
form prints `Tunnel up` — so a script may start a tunnel and use it on the next line. It used to return
as soon as the child had recorded itself, which happens when the socket is bound and before the remote
command has started, so a server that took ten seconds to load left the next client connecting to a
path with nothing behind it. That matters where a
shell or an agent harness kills its background jobs on a timer — a tunnel started this way is not one
of them.

**A tunnel that is killed outright cannot tidy up, so the next command does.** A stop, a `Ctrl+C` or
a crash all run the cleanup; a `SIGKILL` runs nothing, and what it leaves behind is worse than
nothing — the socket file stays on disk with no listener, so clients are refused where an absent path
would have told them plainly that no tunnel is running. `bica tunnel --list` therefore clears up after
any tunnel it finds dead, and says what it removed.

It also kills the ssh processes such a tunnel left running. The forwarding ssh is the one that
lasts — it holds no pipe to its parent, so nothing tells it the tunnel is gone, and it keeps a
connection open to the remote, which is why a server there can still be alive long after the tunnel
that started it. The record itself is kept, because that is what a restart is rebuilt from.

`bica tunnel --restart <local-socket>` starts a recorded tunnel again with the same host, paths,
command and restart mode. The record holds the whole invocation, so reviving a tunnel does not mean
finding the `uv run --with …` line that started it.

**One tunnel per local socket.** Each records itself under `~/.bica/tunnels`, keyed by a digest of the
path it serves, and a second start against a live one is refused with that tunnel named rather than
quietly taking its clients. A record whose process is gone is litter rather than a conflict: it is
taken over, with a line saying so, because otherwise every hard kill would need a manual rescue.

## Environment

| Variable | Purpose |
| --- | --- |
| `BICA_SSH_HOST` | SSH target (or TTY prompt) |
| `BICA_REMOTE_PATH` | Remote workspace path (default `~/code/<repo folder name>`) |
| `BICA_LOGIN_SHELL` | Remote shell for non-interactive commands (default `zsh`) |
| `BICA_LOGIN_FLAGS` | Flags for that shell (default `-lc` for zsh) |
| `BICA_SSH_SHARE` | `0` = give every short ssh call and rsync its own connection, as before. By default they share one connection per host, kept for 60 s after the last use, in a folder under `/tmp` only you can read. The command's own connection is never shared |
| `BICA_DEBUG` | `1` = print remote script on stderr before `ssh` |
| `BICA_TUNNEL_DEAD_AFTER` | Seconds a tunnel's forward may go unanswered before ssh gives up (default `60`). Raise it on a link that stalls legitimately |
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

