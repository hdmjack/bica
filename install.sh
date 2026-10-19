#!/bin/bash
{
# Truncation guard: this brace group opens on line 2 and closes on the last line, so bash must read
# and parse the whole file before it runs any command. On the `curl … | bash` path a download cut
# short anywhere before the final `}` is an unterminated compound command, which bash reports as a
# syntax error at EOF without having run a thing.
#
# Without it, a cut right after `set` would run the bare builtin and print every shell variable, and
# a cut in the middle of the install would leave a half-configured machine behind with an exit status
# of 0. A connection dropping mid-download is the normal case this guards, not an exotic one.
#
# Borrowed, with thanks, from morluto/rea's installer.
set -euo pipefail

REPOSITORY="hdmjack/bica"
NODE_MINIMUM_MAJOR=22

version="${BICA_VERSION:-}"
dry_run=false

fail() {
  printf 'bica installation failed: %s\n' "$1" >&2
  exit 1
}

note() {
  printf '%s\n' "$1"
}

usage() {
  cat <<'USAGE'
Install bica.

  curl -fsSL https://raw.githubusercontent.com/hdmjack/bica/main/install.sh | bash

Options:
  --version <tag>   Install a specific tag (for example v0.6.4) instead of main.
  --dry-run         Print what would be run, and run nothing.
  --help            This text.

Environment:
  BICA_VERSION      Same as --version.
USAGE
}

# The engine floor is stated in package.json#engines.node -- change both together.
#
# Checked rather than attempted because an old Node does not fail cleanly here: bica runs through
# tsx, and the error you get from a Node too old to parse it names a file inside node_modules and
# says nothing about versions at all.
check_node() {
  command -v node >/dev/null 2>&1 ||
    fail "Node.js is not on your PATH. bica needs Node ${NODE_MINIMUM_MAJOR} or later: https://nodejs.org"

  local raw major
  raw="$(node --version 2>/dev/null || true)"
  # v22.11.0 -> 22. A build that does not match leaves `major` empty, which is treated as unknown
  # rather than as too old: refusing to install over an unparsable version string would be a worse
  # failure than letting it through.
  major="$(printf '%s' "$raw" | sed -n 's/^v\([0-9][0-9]*\)\..*$/\1/p')"
  if [ -n "$major" ] && [ "$major" -lt "$NODE_MINIMUM_MAJOR" ]; then
    fail "Node ${raw} is too old; bica needs ${NODE_MINIMUM_MAJOR} or later. Upgrade Node and run this again."
  fi
}

# pnpm does the install, so its absence is the most likely reason this script is being read at all.
# Name the two ways out rather than picking one: corepack ships with Node and needs no network, and
# the npm route is what people with an older setup already have.
check_pnpm() {
  command -v pnpm >/dev/null 2>&1 && return 0
  fail "$(printf 'pnpm is not on your PATH, and bica installs with it.\n%s\n%s' \
    '  corepack enable pnpm        # ships with Node, no download' \
    '  npm install --global pnpm   # if you have no corepack')"
}

# A global install replaces whatever `bica` currently points at. For somebody working on bica itself
# that is a linked checkout, and silently swapping it for a published copy would take their changes
# out of play without saying so.
warn_about_existing_link() {
  command -v bica >/dev/null 2>&1 || return 0
  local resolved
  resolved="$(command -v bica)"
  if grep -q 'code/bica' "$resolved" 2>/dev/null; then
    note "Note: \`bica\` currently runs from a local checkout (${resolved})."
    note '      Installing will replace that link. If you are working on bica itself, stop here.'
  fi
}

main() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version)
        [ "$#" -ge 2 ] || fail '--version needs a tag, for example --version v0.6.4'
        version="$2"
        shift 2
        ;;
      --version=*)
        version="${1#--version=}"
        shift
        ;;
      --dry-run)
        dry_run=true
        shift
        ;;
      --help | -h)
        usage
        exit 0
        ;;
      *)
        fail "Unknown option: $1 (try --help)"
        ;;
    esac
  done

  check_node
  check_pnpm

  local target="${REPOSITORY}"
  if [ -n "$version" ]; then
    target="${REPOSITORY}#${version}"
  fi

  if [ "$dry_run" = true ]; then
    note "Would run: pnpm add -g ${target}"
    exit 0
  fi

  warn_about_existing_link

  note "Installing bica from ${target}…"
  # esbuild arrives through tsx with a prebuilt binary for this platform and has nothing to build, so
  # pnpm's "build scripts were ignored" line here is expected and not a failure.
  pnpm add -g "${target}" ||
    fail 'pnpm could not install bica. The output above says why.'

  command -v bica >/dev/null 2>&1 ||
    fail "$(printf 'bica installed but is not on your PATH.\n%s' \
      '  pnpm bin -g   # prints the directory to add')"

  note ''
  note "Installed $(bica --version)."
  # shellcheck disable=SC2016  # The backticks are literal: this is prose about two commands, and
  # double quotes here would make the shell try to run them.
  note 'Next: run `bica init` in a repository, then `bica doctor` to check the remote.'
}

main "$@"
}
