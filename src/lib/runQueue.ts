import { readLocalBicaSettings } from '../localBicaSettings';

/**
 * A first-come-first-served limit on how many runs execute on a remote at once.
 *
 * The workspace lease answers "may this directory be synced over", and it does so per directory. It
 * says nothing about the machine: seven checkouts have seven leases, so seven runs all start at once,
 * and each of them is a test runner that sizes itself to every core. One afternoon had five of them
 * on a ten-core mini at a load of fifty. Nothing was broken -- every run was live and progressing --
 * but a run that takes seconds alone took ten minutes, and an agent whose tool call times out at ten
 * minutes reads that as a failure.
 *
 * Where it lives, and why:
 *
 * - **On the remote, in the run's own script.** The contended resource is that machine's CPU, so the
 *   count has to be kept where every client can see it, and several laptops share a remote. Putting
 *   the wait in the script that runs there also means everything already built for a running command
 *   applies to a queued one: Ctrl-C and SIGTERM end it, the heartbeat ends it if its client goes
 *   quiet, `bica cancel` signals it, and a detached run queues with no client at all.
 * - **After the lease and the sync, immediately before the command.** The lease is taken first, so a
 *   workspace someone else holds is still refused at once with 98 rather than after a wait. The sync
 *   happens while queued, so the files are already there when a slot comes free.
 * - **Counting live processes rather than releases.** A slot is held while its run's process group
 *   exists, so a run killed with `kill -9`, a connection that drops, or a reboot gives its slot back
 *   with no cleanup having run. The same reasoning as the lease's, and the same `ps` question.
 * - **One slot per run, not per command.** The commands of a `--also` run share the run's slot: they
 *   are one agent's one request, and charging three would let a single run take a three-slot limit
 *   whole.
 *
 * Only the user's command is gated. The install preflight and generated-output repair belong to the
 * same run and are not counted: they would give the slot up between steps and rejoin at the back.
 */

/** Where the queue lives on the remote. A `sh` word, so `$HOME` expands there and not here. */
export const REMOTE_QUEUE_DIR = '$HOME/.bica/queue';

/** A number of runs, or `auto`: a third of the remote's cores, at least one. */
export type QueueLimit = number | 'auto';

const ENV_MAX_RUNS = 'BICA_MAX_RUNS';

/**
 * How many runs may execute at once, or `null` for no limit.
 *
 * Precedence: the environment, then `.bica/local.yml`, then `auto`. `0`, `off` and `unlimited` all
 * mean no limit. A value that is none of those is an error rather than a fallback: a limit someone
 * typed that silently became something else is the kind of setting that goes unnoticed for months.
 */
export function resolveQueueLimit(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): QueueLimit | null {
  const fromEnv = env[ENV_MAX_RUNS]?.trim();
  const raw =
    fromEnv !== undefined && fromEnv !== ''
      ? { value: fromEnv, source: ENV_MAX_RUNS }
      : (() => {
          const local = readLocalBicaSettings(repoRoot).maxRuns;
          return local === undefined
            ? undefined
            : { value: local, source: '.bica/local.yml maxRuns' };
        })();
  if (raw === undefined) {
    return 'auto';
  }
  return parseQueueLimit(raw.value, raw.source);
}

export function parseQueueLimit(raw: string, source: string): QueueLimit | null {
  const t = raw.trim().toLowerCase();
  if (t === 'auto') {
    return 'auto';
  }
  if (t === 'off' || t === 'unlimited' || t === '0') {
    return null;
  }
  if (/^[1-9][0-9]*$/.test(t)) {
    return Number(t);
  }
  throw new Error(
    `${source} must be a whole number of runs, "auto", or "off" (got ${JSON.stringify(raw)}).`,
  );
}

/**
 * The shell both the gate and the status read share: is a pid alive, did the remote reboot since an
 * entry was written, and how many runs to allow.
 *
 * Liveness is `kill -0` or membership of a process group, either being enough. The recorded pid is
 * the remote shell, which sshd makes a group leader, and killing a shell does not take its children
 * with it -- a `sleep` was seen still running in a workspace after its shell was gone -- so the group
 * is the better witness; `kill -0` covers a shell that is not a leader.
 *
 * The boot stamp is what stops a restart from reading as a full house: pids restart from the bottom,
 * so a pre-restart entry's number can belong to anything. Compared with a margin because the stamp is
 * derived from the clock, and a clock stepped after boot moves it by seconds.
 */
export const PRELUDE_SH = String.raw`
BOOT=$( (awk '/^btime /{print $2}' /proc/stat 2>/dev/null; sysctl -n kern.boottime 2>/dev/null | sed -n 's/^{ sec = \([0-9]*\),.*/\1/p') | head -n 1)
PGIDS=
refresh_pgids() { PGIDS=$(ps -A -o pgid= 2>/dev/null | tr -d ' '); }
is_alive() {
  case "$1" in ''|*[!0-9]*) return 1;; esac
  kill -0 "$1" 2>/dev/null && return 0
  printf '%s\n' "$PGIDS" | grep -qx "$1"
}
booted_since() {
  case "$1" in ''|*[!0-9]*) return 1;; esac
  case "$BOOT" in ''|*[!0-9]*) return 1;; esac
  _d=$((BOOT - $1)); [ "$_d" -lt 0 ] && _d=$((0 - _d))
  [ "$_d" -gt 30 ]
}
resolve_limit() {
  case "$1" in
    ''|*[!0-9]*)
      _c=$( (sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null) | head -n 1)
      case "$_c" in ''|*[!0-9]*) _c=3;; esac
      _l=$((_c / 3)); [ "$_l" -lt 1 ] && _l=1
      echo "$_l";;
    *) echo "$1";;
  esac
}
`;

/**
 * The gate: returns once this run may execute, which is immediately when it is under the limit and
 * nobody is ahead of it.
 *
 * Arguments: queue directory, run id, the pid to hold the slot with, the limit (`auto` or a number),
 * and the workspace's claim name, which lets `bica queue` show what a run is doing.
 *
 * Every decision is made inside one lock, because "count the holders, then become one" is exactly the
 * race that lets two runs both see a free slot. The lock is a directory, which `mkdir` makes
 * exclusive. A lock whose owner was killed mid-section is broken after ten seconds; two waiters
 * breaking it at the same moment can both enter for a few milliseconds, which at worst admits one
 * run more than the limit, and that is the right side to err on for a queue.
 *
 * The gate never fails a run. A directory it cannot create, or any other trouble of its own, lets the
 * command go ahead with a line saying so: a limit on load is not worth a run that does not happen.
 */
export const QUEUE_GATE_SH = String.raw`
D=$1; RUN=$2; PID=$3; LIMIT=$4; WS=$5
mkdir -p "$D/held" "$D/wait" 2>/dev/null || { echo "[bica] Cannot create $D; running without the queue." >&2; exit 0; }
${PRELUDE_SH}
L=$(resolve_limit "$LIMIT")
BOOTW=$BOOT; [ -n "$BOOTW" ] || BOOTW=-
LOCKED=
lock() {
  _n=0
  until mkdir "$D/.lock" 2>/dev/null; do
    _n=$((_n + 1))
    if [ "$_n" -gt 50 ]; then rm -rf "$D/.lock"; _n=0; fi
    sleep 0.2 2>/dev/null || sleep 1
  done
  LOCKED=1
}
unlock() { if [ -n "$LOCKED" ]; then rmdir "$D/.lock" 2>/dev/null; LOCKED=; fi; }
trap 'unlock; exit 143' TERM INT HUP
record() {
  printf '%s %s %s %s\n' "$PID" "$BOOTW" "$(date +%s)" "$WS" > "$D/.tmp.$$" && mv "$D/.tmp.$$" "$1"
}
prune() {
  refresh_pgids
  for f in "$D"/held/* "$D"/wait/*; do
    [ -f "$f" ] || continue
    p=; b=; read -r p b _ < "$f" 2>/dev/null
    if ! is_alive "$p" || booted_since "$b"; then rm -f "$f"; fi
  done
}
POLL=$BICA_QUEUE_POLL; [ -n "$POLL" ] || POLL=2
STARTED=$(date +%s); QUEUED=; LASTKEY=; LASTSAY=0
while :; do
  lock
  prune
  HOLDING=$(ls "$D/held" 2>/dev/null | awk -F. -v r="$RUN" '$1==r' | wc -l | tr -d ' ')
  if [ "$HOLDING" -gt 0 ]; then
    # Another command of this run already holds its slot, and a run's commands share it.
    rm -f "$D"/wait/*."$RUN"."$PID"
    record "$D/held/$RUN.$PID"; unlock; break
  fi
  # A command of this run already queued keeps its place; a new run goes to the back.
  MYSEQ=$(ls "$D/wait" 2>/dev/null | awk -F. -v r="$RUN" '$2==r {print $1; exit}')
  if [ -z "$MYSEQ" ]; then
    N=$(cat "$D/seq" 2>/dev/null); case "$N" in ''|*[!0-9]*) N=0;; esac
    N=$((N + 1)); echo "$N" > "$D/seq"
    MYSEQ=$(printf '%010d' "$N")
  fi
  HOLDERS=$(ls "$D/held" 2>/dev/null | sed 's/\.[0-9]*$//' | sort -u | wc -l | tr -d ' ')
  AHEAD=$(ls "$D/wait" 2>/dev/null | awk -F. -v r="$RUN" -v s="$MYSEQ" '$2!=r && $1<s {print $1"."$2}' | sort -u | wc -l | tr -d ' ')
  if [ "$HOLDERS" -lt "$L" ] && [ "$AHEAD" -eq 0 ]; then
    rm -f "$D"/wait/*."$RUN"."$PID"
    record "$D/held/$RUN.$PID"; unlock; break
  fi
  record "$D/wait/$MYSEQ.$RUN.$PID"
  unlock
  QUEUED=1
  NOW=$(date +%s)
  KEY="$HOLDERS/$AHEAD"
  # Said when the picture changes, and otherwise once a minute: enough that a wait is never silent,
  # not so often that a long one is a screenful.
  if [ "$KEY" != "$LASTKEY" ] || [ $((NOW - LASTSAY)) -ge 60 ]; then
    echo "[bica] Queued: $HOLDERS of $L run slots busy, $AHEAD ahead of this run (waited $((NOW - STARTED))s). 'bica queue' lists them." >&2
    LASTKEY=$KEY; LASTSAY=$NOW
  fi
  sleep "$POLL"
done
[ -n "$QUEUED" ] && echo "[bica] Slot free after $(($(date +%s) - STARTED))s; starting." >&2
exit 0
`;

/**
 * The block spliced into a run's script, directly before the command.
 *
 * `$$` is the remote shell, which is what the lease already publishes and what stays alive for the
 * whole command. The script goes in as a here-document so it needs no quoting, and so the command
 * that follows keeps its own standard input.
 */
export function buildQueueGate(options: {
  runId: string;
  limit: QueueLimit;
  /** The workspace's claim file name, for `bica queue` to look up what the run is doing. */
  claimName: string;
  /** Overridden by tests, which point it at a temp directory. */
  dir?: string;
}): string {
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  const dir = options.dir === undefined ? `"${REMOTE_QUEUE_DIR}"` : q(options.dir);
  // A run id is a pid, but the file names carry it between dots, so nothing else may reach them.
  const run = options.runId.replace(/[^A-Za-z0-9_-]/g, '_');
  return (
    `sh -s -- ${dir} ${q(run)} "$$" ${q(String(options.limit))} ${q(options.claimName)} <<'BICA_QUEUE_EOF'\n` +
    `${QUEUE_GATE_SH.replace(/^\n/, '')}` +
    'BICA_QUEUE_EOF\n'
  );
}

/** Who is running and who is waiting, for `bica queue`. Read-only: it prunes nothing. */
export function buildQueueStatusScript(dir: string = `"${REMOTE_QUEUE_DIR}"`): string {
  return (
    `D=${dir}\n` +
    `${PRELUDE_SH}` +
    'refresh_pgids\n' +
    `printf 'NOW\\t%s\\n' "$(date +%s)"\n` +
    `printf 'AUTO\\t%s\\n' "$(resolve_limit auto)"\n` +
    'for kind in held wait; do\n' +
    '  for f in "$D/$kind"/*; do\n' +
    '    [ -f "$f" ] || continue\n' +
    '    p=; b=; t=; w=; read -r p b t w < "$f" 2>/dev/null\n' +
    '    is_alive "$p" || continue\n' +
    '    booted_since "$b" && continue\n' +
    '    c=$(cat "$HOME/.bica/claims/$w.cmd" 2>/dev/null | tr "\\t\\n" "  ")\n' +
    `    printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$kind" "$(basename "$f")" "$t" "$w" "$c"\n` +
    '  done\n' +
    'done\n'
  );
}

export interface QueueEntry {
  runId: string;
  /** Pids of the commands of this run that are queued or running. */
  pids: number[];
  /** Epoch seconds, on the remote's clock, of when the run was admitted or queued. */
  since: number;
  /** The workspace's claim name, which is its remote path made filename-safe. */
  workspace: string;
  command?: string;
}

export interface QueueState {
  running: QueueEntry[];
  waiting: QueueEntry[];
  now: number | undefined;
  /** What `auto` resolves to on that remote. */
  autoLimit: number | undefined;
}

/**
 * Parse the status script's tab-separated lines, grouping the commands of one run into one entry:
 * the person reading this is asking which runs are going, not which processes.
 */
export function parseQueueStatus(stdout: string): QueueState {
  const state: QueueState = {
    running: [],
    waiting: [],
    now: undefined,
    autoLimit: undefined,
  };
  const find = (list: QueueEntry[], runId: string): QueueEntry | undefined =>
    list.find((e) => e.runId === runId);
  for (const line of stdout.split('\n')) {
    const [kind, name, since, workspace, command] = line.split('\t');
    if (kind === 'NOW') {
      state.now = Number(name);
    } else if (kind === 'AUTO') {
      state.autoLimit = Number(name);
    } else if ((kind === 'held' || kind === 'wait') && name !== undefined) {
      const parts = name.split('.');
      // held: <run>.<pid>   wait: <seq>.<run>.<pid>
      const [runId, pid] = kind === 'held' ? parts : parts.slice(1);
      if (runId === undefined || !/^[0-9]+$/.test(pid ?? '')) {
        continue;
      }
      const list = kind === 'held' ? state.running : state.waiting;
      const existing = find(list, runId);
      if (existing !== undefined) {
        existing.pids.push(Number(pid));
        continue;
      }
      list.push({
        runId,
        pids: [Number(pid)],
        since: Number(since),
        workspace: workspace ?? '',
        ...(command !== undefined && command !== '' ? { command } : {}),
      });
    }
  }
  return state;
}

function age(entry: QueueEntry, now: number | undefined): string {
  if (now === undefined || !Number.isFinite(entry.since)) {
    return '';
  }
  const s = Math.max(0, now - entry.since);
  return s < 60 ? `${String(s)}s` : `${String(Math.floor(s / 60))}m`;
}

/** The text `bica queue` prints. `limit` is what this checkout would use, resolved against the remote. */
export function describeQueue(
  state: QueueState,
  limit: QueueLimit | null,
): string {
  const effective =
    limit === 'auto' ? state.autoLimit : limit === null ? undefined : limit;
  const of =
    limit === null
      ? 'no limit'
      : effective === undefined
        ? ''
        : `${String(effective)} allowed`;
  const row = (e: QueueEntry, lead: string): string =>
    `  ${lead} run ${e.runId}  ${e.workspace}  ${age(e, state.now)}${e.command === undefined ? '' : `  ${e.command}`}`;
  const lines = [
    `Executing: ${String(state.running.length)}${of === '' ? '' : ` (${of})`}`,
    ...state.running.map((e) => row(e, '•')),
    `Waiting: ${String(state.waiting.length)}`,
    ...state.waiting.map((e, i) => row(e, `${String(i + 1)}.`)),
  ];
  return lines.join('\n');
}
