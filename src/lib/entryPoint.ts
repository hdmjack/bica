/**
 * Whether a command is one the install preflight can say anything about.
 *
 * bica's package-manager plugins match on `argv[0]`: `pnpm`, `npm`, `cargo`. That is what decides
 * whether the remote's dependencies are checked before a run. A project whose entry point is a script
 * -- `./x build` for rustc, `./scripts/build.sh`, or `cmake` and `ninja` driving a tree that has no
 * package manager at all -- matches nothing, so no preflight runs.
 *
 * That is the correct behaviour and it has never been stated anywhere. It was discovered instead,
 * which is the complaint: somebody reasons about why their dependencies were not installed, or
 * assumes a preflight happened that did not. `bica doctor` now says which it is for this repository,
 * once, rather than leaving it to be worked out from an absence.
 */

/** A path-like argv[0] is a script in the tree rather than a tool on PATH. */
export function isScriptEntryPoint(argv0: string): boolean {
  return (
    argv0.startsWith('./') ||
    argv0.startsWith('../') ||
    argv0.startsWith('/') ||
    argv0.includes('/')
  );
}

/**
 * What `doctor` says about the install preflight for this repository.
 *
 * Phrased around what the user will see happen rather than around plugins, which are bica's
 * vocabulary and not theirs.
 */
export function describeEntryPoint(options: {
  /** Ids of the package-manager plugins active for this repo. */
  activePluginIds: readonly string[];
}): { detail: string; note?: string } {
  if (options.activePluginIds.length === 0) {
    return {
      detail: 'no package manager detected, so no install preflight runs',
      note:
        'That is expected for a cmake, ninja or script-driven build. bica syncs the tree and runs ' +
        'the command; keeping the remote\'s dependencies current is the build system\'s job.',
    };
  }
  return {
    detail: `${options.activePluginIds.join(', ')} — the remote installs when your lockfile differs from what it last installed`,
    note:
      'This applies to commands that start with the package manager. A script entry point such as ' +
      '`./x build` or `./scripts/build.sh` is matched by nothing, so it gets no preflight.',
  };
}
