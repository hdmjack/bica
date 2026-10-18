import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPlainObject } from 'es-toolkit';
import YAML from 'yaml';

/** Gitignored defaults for SSH / remote path (written by `bica init` / setup). */
export const LOCAL_BICA_SETTINGS_RELATIVE = path.join('.bica', 'local.yml');

export interface LocalBicaSettings {
  sshHost?: string;
  remotePath?: string;
  /**
   * A remote build directory this checkout should use, exported to every command as
   * `$BICA_BUILD_DIR`.
   *
   * Sibling worktrees of one fork want to share a build tree, so switching branches stays
   * incremental rather than costing an hour. The lease already stops them using it at the same time;
   * what was missing was a way to say where it is without a wrapper script. Kept in `local.yml`
   * because it is a fact about this machine's layout, not about the repository.
   */
  buildDir?: string;
}

export function readLocalBicaSettings(repoRoot: string): LocalBicaSettings {
  const abs = path.join(repoRoot, LOCAL_BICA_SETTINGS_RELATIVE);
  if (!fs.existsSync(abs)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(abs, 'utf8');
    const doc: unknown = YAML.parse(raw);
    if (!isPlainObject(doc)) {
      return {};
    }
    const sshHost =
      typeof doc.sshHost === 'string' ? doc.sshHost.trim() : undefined;
    const remotePath =
      typeof doc.remotePath === 'string' ? doc.remotePath.trim() : undefined;
    const buildDir =
      typeof doc.buildDir === 'string' ? doc.buildDir.trim() : undefined;
    return {
      buildDir:
        buildDir !== undefined && buildDir.length > 0 ? buildDir : undefined,
      sshHost:
        sshHost !== undefined && sshHost.length > 0 ? sshHost : undefined,
      remotePath:
        remotePath !== undefined && remotePath.length > 0
          ? remotePath
          : undefined,
    };
  } catch {
    return {};
  }
}

export function writeLocalBicaSettings(
  repoRoot: string,
  settings: LocalBicaSettings,
): void {
  const dir = path.join(repoRoot, '.bica');
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(repoRoot, LOCAL_BICA_SETTINGS_RELATIVE);
  const payload: Record<string, string> = {};
  if (settings.sshHost !== undefined && settings.sshHost.trim() !== '') {
    payload.sshHost = settings.sshHost.trim();
  }
  if (settings.remotePath !== undefined && settings.remotePath.trim() !== '') {
    payload.remotePath = settings.remotePath.trim();
  }
  if (settings.buildDir !== undefined && settings.buildDir.trim() !== '') {
    payload.buildDir = settings.buildDir.trim();
  }
  fs.writeFileSync(abs, `${YAML.stringify(payload, { indent: 2 })}\n`, 'utf8');
}
