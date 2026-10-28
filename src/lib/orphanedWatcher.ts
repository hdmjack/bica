import { spawnSync } from 'node:child_process';

/**
 * Start `script` under `sh` as a process nothing of ours is the parent of, and return its pid.
 *
 * `spawn(..., { detached: true })` is not enough for a watcher whose job is to outlive bica. It makes
 * a new process group, but the watcher is still bica's child, and the callers that kill bica most
 * often -- an agent's shell tool on timeout, a task runner stopping a job -- kill the whole tree of
 * descendants, not a group. The watcher died with the run it was watching, which is the one case it
 * exists for, and the run's command went on for fourteen minutes with nobody reading it.
 *
 * So the shell started here backgrounds the script and exits at once: the script is re-parented to
 * init, and a walk of bica's descendants no longer reaches it. Its output goes to /dev/null so the
 * pipe this reads the pid from closes when the outer shell exits.
 */
export function startOrphanedWatcher(script: string): number | undefined {
  try {
    const result = spawnSync(
      'sh',
      ['-c', '( eval "$BICA_WATCHER" ) </dev/null >/dev/null 2>&1 &\necho $!'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, BICA_WATCHER: script },
        timeout: 5000,
      },
    );
    const pid = Number((result.stdout ?? '').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Stop a watcher before it acts. Killing it while it waits is enough: nothing after the wait runs. */
export function stopOrphanedWatcher(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}
