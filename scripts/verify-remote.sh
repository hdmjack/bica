#!/usr/bin/env bash
#
# Verify bica's remote-run guarantees against a real host. Not a unit test: these are the properties
# that only hold if ssh, rsync, git and the remote shell all behave, and every one of them has been
# wrong at least once.
#
#   scripts/verify-remote.sh --green <ref> --red <ref>
#
# --green must pass the check command, --red must fail it. Both are verified alone first, because a
# "red" ref that is not red for the command in use makes every later result meaningless -- and that
# has happened three times.
set -uo pipefail

BICA=${BICA:-bica}
GREEN=""; RED=""; CMD=()
die() { printf '%s\n' "$*" >&2; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --green) GREEN=${2:?}; shift 2 ;;
    --red) RED=${2:?}; shift 2 ;;
    --) shift; CMD=("$@"); break ;;
    *) die "unknown option $1" ;;
  esac
done
[[ -n $GREEN && -n $RED && ${#CMD[@]} -gt 0 ]] || die "usage: $0 --green <ref> --red <ref> -- <command...>"

OUT=$(mktemp -d "${TMPDIR:-/tmp}/bica-verify-XXXXXX")
FAILURES=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAILURES=$((FAILURES+1)); }
note() { printf '        %s\n' "$*"; }
section() { printf '\n\033[1m%s\033[0m\n' "$*"; }

section "0  Inputs are what they claim to be"
"$BICA" --yes run --ref "$GREEN" "${CMD[@]}" >"$OUT/green.log" 2>&1
[[ $? -eq 0 ]] && pass "green ref passes alone" || { fail "green ref FAILED alone -- not a usable baseline"; note "$OUT/green.log"; exit 1; }
"$BICA" --yes run --ref "$RED" "${CMD[@]}" >"$OUT/red.log" 2>&1
[[ $? -ne 0 ]] && pass "red ref fails alone -- the contrast is real" || { fail "red ref PASSED alone -- it is not red for this command"; note "$OUT/red.log"; exit 1; }

section "1  A run says what content it verified"
grep -qE 'workspace .*  content ' "$OUT/green.log" \
  && pass "the run states its workspace and content up front" \
  || fail "no identity line -- a caller cannot tell what was verified"

section "2  Several commands at once, each reporting its own outcome"
# A mixed batch is the real test: a pass/pass batch cannot tell you the codes are not simply copied.
"$BICA" --yes run --ref "$GREEN" "${CMD[@]}" -- sh -c 'exit 7' >"$OUT/par.log" 2>&1
par_rc=$?
if grep -qE 'exit codes:.*=0' "$OUT/par.log" && grep -qE 'exit codes:.*=7' "$OUT/par.log"; then
  pass "each command reported its own exit code"
else
  fail "per-command exit codes missing or wrong"; note "$OUT/par.log"
fi
[[ $par_rc -ne 0 ]] && pass "one failure makes the whole run non-zero (rc=$par_rc)" || fail "a failing command did not fail the run"
grep -q '=====' "$OUT/par.log" && pass "output is sectioned per command, not interleaved" || fail "no per-command sections"

section "3  A second run refuses rather than overwriting the first"
"$BICA" --yes run --ref "$GREEN" sh -c 'sleep 12' >"$OUT/hold.log" 2>&1 &
hold=$!
sleep 4
"$BICA" --yes run --ref "$GREEN" sh -c 'echo should-not-run' >"$OUT/second.log" 2>&1
second_rc=$?
wait "$hold" || true
if [[ $second_rc -eq 98 ]] && ! grep -q 'should-not-run' "$OUT/second.log"; then
  pass "second run exited 98 without running its command"
else
  fail "second run was not refused (rc=$second_rc)"; note "$OUT/second.log"
fi

section "4  The lease is released, so the next run is not blocked"
"$BICA" --yes run --ref "$GREEN" sh -c 'echo free' >"$OUT/after.log" 2>&1
[[ $? -eq 0 ]] && pass "workspace usable again after the previous run finished" || { fail "workspace still leased"; note "$OUT/after.log"; }

section "Result"
printf 'logs: %s\n' "$OUT"
[[ $FAILURES -eq 0 ]] && { printf '\033[32mall checks passed\033[0m\n'; exit 0; }
printf '\033[31m%d check(s) failed\033[0m\n' "$FAILURES"; exit 1
