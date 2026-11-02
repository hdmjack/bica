/**
 * Shell for ending a run's processes on the remote, group and descendants both.
 *
 * Every way bica ends a command used to signal its process group: the shell sshd starts is a group
 * leader, so the group is the command and what it started. That misses anything that moves itself to
 * a group of its own, and GNU `timeout` is the common one -- it calls `setpgid(0, 0)` unless given
 * `--foreground`. A run cancelled under `timeout 900 ./viewer` reported the remote command ended and
 * left the viewer running, holding the GPU, with the workspace lease already released.
 *
 * The parent link survives a change of group, so descendants are found by parent pid. They have to be
 * collected *before* anything is signalled: once their parent is gone they are reparented to init and
 * nothing connects them to the run any more. A session id would be tidier, and macOS `ps` does not
 * report one.
 *
 * Plain `sh`: it is sent over ssh to whatever shell the remote has, and runs under both `sh` and the
 * login shell the command itself uses. That is `zsh` by default, which does not split an unquoted
 * variable into words the way `sh` does -- `kill -TERM $pids` was one invalid pid there, so the
 * watchdog that runs under the login shell ended nothing while the same code under `sh` worked. The
 * list is therefore split by a command substitution, which every shell splits.
 */
export const PROCESS_TREE_SH = [
  // Every descendant of pid $1, one per line, not including $1.
  '_bica_descendants() {',
  '  ps -A -o pid= -o ppid= 2>/dev/null | awk -v root="$1" \'',
  '    { parent[$1] = $2; pids[NR] = $1; n = NR }',
  '    END {',
  '      seen[root] = 1; again = 1',
  '      while (again) {',
  '        again = 0',
  '        for (i = 1; i <= n; i++) {',
  '          p = pids[i]',
  '          if (!(p in seen) && (parent[p] in seen)) { seen[p] = 1; print p; again = 1 }',
  '        }',
  '      }',
  '    }\'',
  '}',
  // TERM each pid in the newline-separated list $1. One at a time, from a command substitution, because
  // an unquoted variable is not split into words by zsh; see above.
  '_bica_term_each() {',
  '  for _bica_p in $(printf \'%s\\n\' "$1"); do',
  '    kill -TERM "$_bica_p" 2>/dev/null',
  '  done',
  '}',
  // TERM the process group led by $1, as before, then whatever left it. Returns the group's result,
  // which is how a caller tells "signalled" from "already gone".
  '_bica_end_tree() {',
  '  _bica_found=$(_bica_descendants "$1")',
  '  kill -TERM -"$1" 2>/dev/null',
  '  _bica_rc=$?',
  '  _bica_term_each "$_bica_found"',
  '  return $_bica_rc',
  '}',
  '',
].join('\n');
