# Changelog

Dates are the release date. bica keeps state on the remote that several versions can reach, so
entries note where a change affects what another version sees.

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
