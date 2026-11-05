import { spawnSync } from 'node:child_process';

/**
 * What a run can say about a SIGTERM it was sent.
 *
 * It cannot say who sent it. Node hands a signal handler the signal's name and nothing else -- the
 * sender's pid is in the kernel's `siginfo`, which the runtime does not expose -- so any message that
 * claims a sender is a guess. What a run does know is the chain of processes above it, which is where
 * the usual senders live: the shell, the agent or task runner that started it, the terminal. Printing
 * that chain, with how long the run had been going, lets a reader match the signal against whatever
 * they were doing at that moment (ending a background task, a command timeout, closing a tab).
 *
 * bica itself sends SIGTERM to a run in exactly one case, `bica cancel --force`, and says so.
 */

export interface Ancestor {
  pid: number;
  command: string;
}

/** Layers that are bica's own: the launcher and the tsx loader that carry the CLI. Not the sender. */
const OWN_LAYER = /(tsx\/dist\/(cli|preflight)|\/bica\.cjs|\/bin\/bica)(\s|$|\.)/;

/**
 * The processes above `startPid`, nearest first, from one `ps -axo pid=,ppid=,command=` listing, with
 * bica's own layers left out and the walk stopped at init.
 */
export function ancestorsOf(psOutput: string, startPid: number): Ancestor[] {
  const rows = new Map<number, { ppid: number; command: string }>();
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) {
      continue;
    }
    rows.set(Number(m[1]), { ppid: Number(m[2]), command: m[3] });
  }
  const chain: Ancestor[] = [];
  const seen = new Set<number>();
  let pid = rows.get(startPid)?.ppid;
  while (pid !== undefined && pid > 1 && !seen.has(pid) && chain.length < 12) {
    seen.add(pid);
    const row = rows.get(pid);
    if (row === undefined) {
      break;
    }
    if (!OWN_LAYER.test(row.command)) {
      chain.push({ pid, command: row.command });
    }
    pid = row.ppid;
  }
  return chain;
}

/**
 * Whether whatever started the run has already gone: the outermost bica layer's parent is init. A
 * shell or agent that ended the run by ending its own process tree leaves exactly this behind.
 */
export function isOrphaned(psOutput: string, startPid: number): boolean {
  const rows = new Map<number, { ppid: number; command: string }>();
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined && m[3] !== undefined) {
      rows.set(Number(m[1]), { ppid: Number(m[2]), command: m[3] });
    }
  }
  let pid = startPid;
  for (let i = 0; i < 12; i += 1) {
    const ppid = rows.get(pid)?.ppid;
    if (ppid === undefined) {
      return false;
    }
    const parent = rows.get(ppid);
    if (ppid === 1) {
      return true;
    }
    if (parent === undefined || !OWN_LAYER.test(parent.command)) {
      return false;
    }
    pid = ppid;
  }
  return false;
}

function shorten(command: string, max = 70): string {
  const oneLine = command.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/** The sentence a run prints after it has been told to stop. Never claims a sender. */
export function describeSignal(options: {
  signal: string;
  ranForSeconds: number;
  ancestors: Ancestor[];
  /** The parent is init: whatever started this run has already gone. */
  orphaned: boolean;
}): string {
  const ran = `${String(Math.max(0, Math.round(options.ranForSeconds)))}s`;
  const lines = [
    `${options.signal} arrived ${ran} into the run. Node does not say which process sent a signal, so bica cannot either;` +
      ' bica itself sends one only for `bica cancel --force`.',
  ];
  if (options.orphaned) {
    lines.push(
      'What started this run is already gone (its parent is init), which points at that process or its group being ended.',
    );
  }
  if (options.ancestors.length > 0) {
    const chain = options.ancestors
      .map((a) => `${shorten(a.command)} (pid ${String(a.pid)})`)
      .join('\n    ← ');
    lines.push(`Started by, nearest first:\n    ${chain}`);
  }
  lines.push('This is a stop, not a test result: bica exits 143 for SIGTERM and 129 for SIGHUP.');
  return lines.join('\n');
}

/** One `ps` call; undefined where `ps` is missing or slow, in which case the message just omits the chain. */
export function readProcessTable(): string | undefined {
  try {
    const r = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return r.status === 0 ? r.stdout : undefined;
  } catch {
    return undefined;
  }
}
