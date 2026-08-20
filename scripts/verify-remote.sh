#!/usr/bin/env bash
#
# Verify bica's remote-run guarantees against a real host. Not a unit test: these properties only hold
# if ssh, rsync and the remote shell all behave, and each of them has been wrong at least once.
#
#   scripts/verify-remote.sh
#
# Run it from a repo with a working bica config. It uses trivial shell commands rather than the
# project's real checks, because what is under test is bica, not the project.
set -uo pipefail

BICA=${BICA:-bica}
OUT=$(mktemp -d "${TMPDIR:-/tmp}/bica-verify-XXXXXX")
FAILURES=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAILURES=$((FAILURES+1)); }
note() { printf '        %s\n' "$*"; }
section() { printf '\n\033[1m%s\033[0m\n' "$*"; }

section "1  A single command runs and reports its exit code"
"$BICA" run sh -c 'echo single-ok' >"$OUT/single.log" 2>&1
[[ $? -eq 0 ]] && grep -q single-ok "$OUT/single.log" && pass "ran and exited 0" || { fail "single command failed"; note "$OUT/single.log"; }
"$BICA" run sh -c 'exit 5' >"$OUT/rc.log" 2>&1
[[ $? -eq 5 ]] && pass "a command's own exit code is passed through" || fail "exit code not propagated"

section "2  No prompt blocks an unattended run"
# Deliberately no --yes. Stdin is closed, so anything that prompts hangs and the timeout catches it.
timeout 180 "$BICA" run sh -c 'echo unattended' </dev/null >"$OUT/noprompt.log" 2>&1
case $? in
  0) pass "ran with no --yes and no prompt" ;;
  124) fail "run blocked on a prompt with stdin closed" ;;
  *) fail "run failed (rc=$?)"; note "$OUT/noprompt.log" ;;
esac

section "3  Several commands at once, each reporting its own outcome"
# Mixed on purpose: a pass/pass batch cannot show the codes are not simply copied from one another.
"$BICA" run sh -c 'echo alpha' -- sh -c 'echo beta; exit 7' >"$OUT/par.log" 2>&1
par_rc=$?
grep -qE 'exit codes:.*=0' "$OUT/par.log" && grep -qE 'exit codes:.*=7' "$OUT/par.log" \
  && pass "each command reported its own exit code" \
  || { fail "per-command exit codes missing or wrong"; note "$OUT/par.log"; }
[[ $par_rc -ne 0 ]] && pass "one failure makes the whole run non-zero (rc=$par_rc)" || fail "a failing command did not fail the run"
grep -q '=====' "$OUT/par.log" && pass "output is sectioned per command, not interleaved" || fail "no per-command sections"
grep -qE 'workspace .*  run ' "$OUT/par.log" && pass "the run states where it ran" || fail "no identity line"

section "4  A second run refuses rather than overwriting the first"
"$BICA" run sh -c 'sleep 12' -- sh -c 'sleep 12' >"$OUT/hold.log" 2>&1 &
hold=$!
sleep 4
"$BICA" run sh -c 'echo should-not-run' -- sh -c 'true' >"$OUT/second.log" 2>&1
second_rc=$?
wait "$hold" || true
if [[ $second_rc -eq 98 ]] && ! grep -q 'should-not-run' "$OUT/second.log"; then
  pass "second run exited 98 without running its command"
else
  fail "second run was not refused (rc=$second_rc)"; note "$OUT/second.log"
fi

section "5  The lease is released, so the next run is not blocked"
"$BICA" run sh -c 'echo free' -- sh -c 'true' >"$OUT/after.log" 2>&1
[[ $? -eq 0 ]] && pass "workspace usable again after the previous run finished" || { fail "workspace still leased"; note "$OUT/after.log"; }

section "6  A malformed command list is refused before anything runs"
"$BICA" run sh -c 'echo x' -- --coverage >"$OUT/dd.log" 2>&1
[[ $? -ne 0 ]] && grep -q 'cannot start a command' "$OUT/dd.log" \
  && pass "a flag after -- is refused with guidance" \
  || { fail "the -- passthrough habit was not caught"; note "$OUT/dd.log"; }

section "Result"
printf 'logs: %s\n' "$OUT"
[[ $FAILURES -eq 0 ]] && { printf '\033[32mall checks passed\033[0m\n'; exit 0; }
printf '\033[31m%d check(s) failed\033[0m\n' "$FAILURES"; exit 1
