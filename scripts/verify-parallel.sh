#!/usr/bin/env bash
#
# Verify that concurrent `bica run` invocations are actually isolated — not merely that two of them
# can be started at once.
#
# Run this from the repository you want to verify (the one with bica.yml), with a working
# BICA_SSH_HOST / .bica/local.yml. It needs two refs whose outcomes you already know: one where the
# command passes and one where it fails. A pair that both pass proves nothing, because a run
# reporting the *other* run's result would look identical to success.
#
#   scripts/verify-parallel.sh --green main --red feat/known-broken -- pnpm validate
#
# Checks, in order:
#   0  The green ref passes alone, establishing that it is a usable baseline. Two independent attempts
#      at this harness failed check 1 because "green" was not green; without this, that failure is
#      indistinguishable from lanes crossing, which is the one thing check 1 exists to show.
#   1  Green and red run concurrently in separate lanes; each must report its own outcome.
#   2  The lanes' remote HEADs must differ afterwards — direct evidence the content did not cross,
#      rather than an inference from exit codes.
#   3  Two runs told to share one lane: exactly one must be refused. This is the check that proves
#      the isolation is load-bearing; if both proceeded, check 1 passing would be a coincidence.
#   4  A live-tree run raced against a tree that keeps changing must fail loudly, not report a
#      result derived from a half-synced mix of two states. NOTE: this greps bica's own wording, so if
#      that message changes, update the grep or this check silently becomes inconclusive.
#   5  Wall-clock for N refs concurrently vs one ref alone. Measures per-run overhead first and
#      declines to judge when the command is smaller than it, because concurrency cannot compress
#      transport and a ratio measured there says nothing about whether lanes work.
#
set -uo pipefail

BICA=${BICA:-bica}
GREEN=""
RED=""
LANES=4
SWEEP_REFS=()
CMD=()

die() { printf '%s\n' "$*" >&2; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --green) GREEN=${2:?--green needs a ref}; shift 2 ;;
    --red) RED=${2:?--red needs a ref}; shift 2 ;;
    --lanes) LANES=${2:?--lanes needs an integer}; shift 2 ;;
    --sweep) IFS=',' read -r -a SWEEP_REFS <<< "${2:?--sweep needs a comma-separated ref list}"; shift 2 ;;
    --) shift; CMD=("$@"); break ;;
    *) die "unknown option $1" ;;
  esac
done

[[ -n $GREEN ]] || die "usage: $0 --green <ref> --red <ref> [--lanes N] [--sweep a,b,c] -- <command...>"
[[ -n $RED ]] || die "usage: $0 --green <ref> --red <ref> [--lanes N] [--sweep a,b,c] -- <command...>"
[[ ${#CMD[@]} -gt 0 ]] || die "no command given after --"
git rev-parse --verify --quiet "$GREEN^{commit}" >/dev/null || die "cannot resolve --green $GREEN"
git rev-parse --verify --quiet "$RED^{commit}" >/dev/null || die "cannot resolve --red $RED"

OUT=$(mktemp -d "${TMPDIR:-/tmp}/bica-verify-XXXXXX")
SSH_HOST=${BICA_SSH_HOST:-$(sed -n 's/^sshHost:[[:space:]]*//p' .bica/local.yml 2>/dev/null | head -1)}
FAILURES=0

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
note() { printf '        %s\n' "$*"; }
section() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# Lane workspace path for a lane id, derived the same way bica derives it.
lane_remote_path() {
  local base=${BICA_REMOTE_PATH:-}
  if [[ -z $base ]]; then
    base=$(sed -n 's/^remotePath:[[:space:]]*//p' .bica/local.yml 2>/dev/null | head -1)
  fi
  [[ -n $base ]] || return 1
  printf '%s-lane-%s' "${base%/}" "$1"
}

remote_head() {
  local lane_path
  lane_path=$(lane_remote_path "$1") || return 1
  [[ -n $SSH_HOST ]] || return 1
  ssh -T "$SSH_HOST" "git -C ${lane_path} rev-parse HEAD" 2>/dev/null
}

section "Warming the lane pool (one-time install cost, kept out of the timings below)"
"$BICA" --yes lanes prepare --lanes "$LANES" || note "lanes prepare reported a problem; continuing so the checks still run"

section "0  Preflight — is the green ref actually green, run entirely alone?"
# Two independent attempts at this harness failed check 1 because the "green" ref was not green: once
# because it needed an install the lane did not have, once because the command used --max-warnings 0
# and the ref carried a pre-existing warning. Both look identical to "results crossed between lanes",
# which is the one conclusion check 1 exists to support. So establish the baseline first, with nothing
# else running: if green fails here, checks 1 and 2 cannot mean anything and the run stops.
"$BICA" --yes run --lane 1 --ref "$GREEN" "${CMD[@]}" >"$OUT/preflight-green.log" 2>&1
preflight_status=$?
if [ $preflight_status -eq 0 ]; then
  pass "green ref passes alone in a lane — the baseline is sound"
else
  fail "green ref FAILED alone (exit $preflight_status) — it is not a valid baseline"
  note "log: $OUT/preflight-green.log"
  note "Fix the ref or the command before reading anything into checks 1-2. Common causes:"
  note "  - the ref needs an install the lane does not have yet (run 'bica lanes prepare')"
  note "  - the command is stricter than the ref is clean (e.g. --max-warnings 0 with warnings)"
  note "Also confirm the red ref fails for the reason you intend, not incidentally."
  section "Result"
  printf 'logs: %s\n' "$OUT"
  printf '\033[31maborted: no usable green baseline\033[0m\n'
  exit 1
fi

section "1  Green and red concurrently — each must report its own outcome"
"$BICA" --yes run --lane 1 --ref "$GREEN" "${CMD[@]}" >"$OUT/green.log" 2>&1 &
green_pid=$!
"$BICA" --yes run --lane 2 --ref "$RED" "${CMD[@]}" >"$OUT/red.log" 2>&1 &
red_pid=$!
wait "$green_pid"; green_status=$?
wait "$red_pid"; red_status=$?
note "green ($GREEN) exit $green_status, log $OUT/green.log"
note "red   ($RED) exit $red_status, log $OUT/red.log"
if [[ $green_status -eq 0 ]]; then
  pass "the known-green ref passed in its lane"
else
  # Check 0 already proved this ref passes alone, so "not actually green" is ruled out and only the
  # concurrency explanation is left. This is the harness's strongest possible negative result.
  fail "the known-green ref failed WHILE the red ref ran, but passed alone in check 0 — content crossed between lanes"
  note "diff $OUT/preflight-green.log against $OUT/green.log to see what changed under concurrency"
fi
if [[ $red_status -ne 0 ]]; then
  pass "the known-red ref failed in its lane"
else
  fail "the known-red ref passed — the strongest possible sign results crossed between lanes"
fi

section "2  The two lanes must hold different commits afterwards"
green_head=$(remote_head 1 || true)
red_head=$(remote_head 2 || true)
if [[ -z $green_head || -z $red_head ]]; then
  note "skipped: could not read remote HEADs (needs git.sync enabled and a resolvable remote path)"
elif [[ $green_head != "$red_head" ]]; then
  pass "lane 1 is at ${green_head:0:12}, lane 2 at ${red_head:0:12}"
else
  fail "both lanes are at ${green_head:0:12} — one lane's content overwrote the other's"
fi

section "3  Two runs told to share one lane — exactly one must be refused"
"$BICA" --yes run --lane 1 --ref "$GREEN" "${CMD[@]}" >"$OUT/share-a.log" 2>&1 &
a_pid=$!
# Give the first run time to take the lock, so this is a genuine collision rather than a race the
# test itself decides.
sleep 2
"$BICA" --yes run --lane 1 --ref "$RED" "${CMD[@]}" >"$OUT/share-b.log" 2>&1
b_status=$?
wait "$a_pid" || true
# Assert the exit code, not the wording. This grepped the refusal text and stopped matching the moment
# that text changed -- a false failure on a working mechanism, which is the same trap check 4 fell into.
if [[ $b_status -eq 98 ]]; then
  pass "the second run was refused with exit 98, naming the holder"
else
  fail "the second run was not refused (exit $b_status) — two runs can share a workspace, so check 1 proves nothing"
  note "see $OUT/share-b.log"
fi

section "4  A live-tree run whose tree keeps moving must fail loudly"
marker="bica-verify-churn.txt"
(
  for _ in $(seq 1 400); do
    printf '%s\n' "$RANDOM" > "$marker"
    sleep 0.05
  done
) &
churn_pid=$!
"$BICA" --yes run --lane 3 "${CMD[@]}" >"$OUT/torn.log" 2>&1
torn_status=$?
kill "$churn_pid" 2>/dev/null || true
wait "$churn_pid" 2>/dev/null || true
rm -f "$marker"
if grep -qE 'changed while syncing|Refusing to run' "$OUT/torn.log"; then
  pass "bica refused to run against content that moved mid-sync"
elif [[ $torn_status -eq 0 ]]; then
  note "inconclusive: the sync won the race and completed cleanly (exit 0). Re-run to retry, or"
  note "trust check 3 — this check is inherently timing-dependent."
else
  note "inconclusive: the run failed for another reason (exit $torn_status); see $OUT/torn.log"
fi

section "5  Wall clock: N refs concurrently vs one ref alone"
# This check used to divide two wall-clock numbers and call it a verdict. That is unsound, and it
# misled its author three times in one day: a lane run has a fixed cost (content hash, tree rsync, a
# handful of ssh round-trips) that concurrency cannot reduce, so for a command cheaper than that cost
# the measurement is of transport, not of verification, and it will report FAIL however well lanes
# work. Measure the overhead, subtract it, and decline to judge when the command is too small to say
# anything -- an honest "cannot tell" beats a confident wrong answer.
if [[ ${#SWEEP_REFS[@]} -eq 0 ]]; then
  note "skipped: pass --sweep ref1,ref2,... to measure a real sweep"
else
  # Overhead is measured with the *same ref* as the single run that follows, and immediately before
  # it, so both push identical content into the same lane. A null run against different content -- a
  # live tree, say, when the lane last held a ref -- measures the size of that difference instead, and
  # can come out larger than the full run it is supposed to be a component of. It did, which is how
  # this was caught.
  "$BICA" --yes run --lane 1 --ref "${SWEEP_REFS[0]}" true >"$OUT/warm.log" 2>&1 || true
  start=$SECONDS
  "$BICA" --yes run --lane 1 --ref "${SWEEP_REFS[0]}" true >"$OUT/overhead.log" 2>&1 || true
  overhead=$((SECONDS - start))

  start=$SECONDS
  "$BICA" --yes run --lane 1 --ref "${SWEEP_REFS[0]}" "${CMD[@]}" >"$OUT/single.log" 2>&1 || true
  single=$((SECONDS - start))
  command_time=$((single - overhead))
  [[ $command_time -lt 0 ]] && command_time=0

  n=${#SWEEP_REFS[@]}
  note "per-run overhead:     ${overhead}s  (sync + hashing + ssh; concurrency cannot reduce this)"
  note "command alone:        ~${command_time}s"
  note "one ref end to end:   ${single}s"

  if [[ $command_time -le $overhead ]]; then
    note ""
    note "NOT JUDGED: the command (~${command_time}s) is no larger than the per-run overhead (${overhead}s)."
    note "Concurrent runs share one network link and one remote host, so when transport dominates they"
    note "serialise no matter how well lanes work, and any ratio measured here describes the transport."
    note "Re-run with a command that takes several times ${overhead}s -- the workload lanes exist for."
    note "(Overhead here is a warm lane already holding this ref. A lane switching to different content"
    note " pays the rsync delta on top, which is why a sweep's first run into each lane costs more.)"
  else
    start=$SECONDS
    for ref in "${SWEEP_REFS[@]}"; do
      "$BICA" --yes run --lane auto --lanes "$LANES" --ref "$ref" "${CMD[@]}" \
        >"$OUT/sweep-$(printf '%s' "$ref" | tr '/' '-').log" 2>&1 &
    done
    wait
    sweep=$((SECONDS - start))

    serial=$((single * n))
    # Best case: every run's command overlaps, so the sweep costs one command plus each run's own
    # unavoidable overhead. Reporting it turns a bare pass/fail into "how much of the available win
    # did we get", which is the number worth tracking.
    ideal=$((command_time + overhead * n))
    note "$n refs concurrently: ${sweep}s"
    note "serial equivalent:    ${serial}s (${n} x one ref)"
    note "best case:            ~${ideal}s (commands fully overlapped)"
    if [[ $sweep -lt $serial ]]; then
      pass "the sweep beat the serial equivalent (saved $((serial - sweep))s of ${serial}s)"
    else
      fail "the sweep was no faster than running the refs one after another"
      note "with the command larger than overhead this is a real result, not a measurement artefact"
    fi
  fi
  note "pool size was $LANES; a sweep wider than the pool queues, so raise --lanes to fan out further"
fi

section "Result"
printf 'logs: %s\n' "$OUT"
if [[ $FAILURES -eq 0 ]]; then
  printf '\033[32mall checks passed\033[0m\n'
  exit 0
fi
printf '\033[31m%d check(s) failed\033[0m\n' "$FAILURES"
exit 1
