import * as path from 'node:path';

import {
  assertValidLaneId,
  DEFAULT_LANE_POOL_SIZE,
  defaultLaneIdentity,
  isLaneRemotePath,
  laneIdentity,
  laneIdsForPool,
  laneRemoteWorkspacePath,
  laneSessionName,
  MAX_LANE_POOL_SIZE,
  normalizeLanePoolSize,
} from './lanes';

const REPO = '/Users/me/code/float-javascript';

describe('assertValidLaneId', () => {
  it('accepts lowercase alphanumeric ids with inner dashes', () => {
    for (const id of ['1', '12', 'a', 'lane-2', 'verify-tip']) {
      expect(() => {
        assertValidLaneId(id);
      }).not.toThrow();
    }
  });

  it('rejects ids that would escape the remote directory or break a session name', () => {
    // A lane id becomes part of a remote path and a Mutagen session name, so separators, expansion
    // characters and leading dashes must never reach either.
    for (const id of ['../etc', 'a/b', 'Lane', 'a b', '$HOME', '-lead', 'trail-', '']) {
      expect(() => {
        assertValidLaneId(id);
      }).toThrow();
    }
  });

  it('rejects "auto", which selects a lane rather than naming one', () => {
    expect(() => {
      assertValidLaneId('auto');
    }).toThrow(/reserved/);
  });
});

describe('defaultLaneIdentity', () => {
  it('keeps the historical identity: no suffix, .bica as its state dir', () => {
    const lane = defaultLaneIdentity(REPO);
    expect(lane.isDefault).toBe(true);
    expect(lane.id).toBeNull();
    expect(lane.suffix).toBe('');
    expect(lane.stateDir).toBe(path.join(REPO, '.bica'));
  });

});

describe('laneIdentity', () => {
  it('gives each lane its own state directory', () => {
    expect(laneIdentity(REPO, '2').stateDir).toBe(
      path.join(REPO, '.bica', 'lanes', '2'),
    );
  });

});

describe('laneRemoteWorkspacePath', () => {
  it('leaves the base path alone for the default lane', () => {
    expect(
      laneRemoteWorkspacePath('~/code/repo', defaultLaneIdentity(REPO)),
    ).toBe('~/code/repo');
  });

  it('appends the lane suffix', () => {
    expect(laneRemoteWorkspacePath('~/code/repo', laneIdentity(REPO, '3'))).toBe(
      '~/code/repo-lane-3',
    );
  });

  it('drops a trailing slash so the suffix does not become a child directory', () => {
    expect(laneRemoteWorkspacePath('~/code/repo/', laneIdentity(REPO, '3'))).toBe(
      '~/code/repo-lane-3',
    );
  });

  it('gives distinct lanes distinct remote workspaces', () => {
    const paths = ['1', '2', '3'].map((id) =>
      laneRemoteWorkspacePath('~/code/repo', laneIdentity(REPO, id)),
    );
    expect(new Set(paths).size).toBe(3);
  });
});

describe('laneSessionName', () => {
  it('suffixes the spec session name so concurrent lanes never share an identity', () => {
    expect(laneSessionName('float-javascript', laneIdentity(REPO, '2'))).toBe(
      'float-javascript-lane-2',
    );
    expect(
      laneSessionName('float-javascript', defaultLaneIdentity(REPO)),
    ).toBe('float-javascript');
  });
});

describe('isLaneRemotePath', () => {
  it('recognises a derived lane path', () => {
    expect(isLaneRemotePath('~/code/repo', '~/code/repo-lane-1')).toBe(true);
    expect(isLaneRemotePath('~/code/repo/', '~/code/repo-lane-abc')).toBe(true);
  });

  it('refuses the base workspace, which `lanes clean` must never delete', () => {
    expect(isLaneRemotePath('~/code/repo', '~/code/repo')).toBe(false);
    expect(isLaneRemotePath('~/code/repo', '~/code/repo/')).toBe(false);
  });

  it('refuses unrelated or malformed paths', () => {
    expect(isLaneRemotePath('~/code/repo', '~/code/other-lane-1')).toBe(false);
    expect(isLaneRemotePath('~/code/repo', '~/code/repo-lane-')).toBe(false);
    expect(isLaneRemotePath('~/code/repo', '~/code/repo-lane-a/b')).toBe(false);
    expect(isLaneRemotePath('~/code/repo', '~')).toBe(false);
  });
});

describe('laneIdsForPool', () => {
  it('numbers lanes from 1', () => {
    expect(laneIdsForPool(3)).toEqual(['1', '2', '3']);
  });
});

describe('normalizeLanePoolSize', () => {
  it('defaults when unset', () => {
    expect(normalizeLanePoolSize(undefined, 'parallel.lanes')).toBe(
      DEFAULT_LANE_POOL_SIZE,
    );
  });

  it('accepts the allowed range', () => {
    expect(normalizeLanePoolSize(1, 'x')).toBe(1);
    expect(normalizeLanePoolSize(MAX_LANE_POOL_SIZE, 'x')).toBe(
      MAX_LANE_POOL_SIZE,
    );
  });

  it('rejects values a typo would produce, rather than fanning out', () => {
    for (const bad of [0, -1, 1.5, MAX_LANE_POOL_SIZE + 1, NaN]) {
      expect(() => normalizeLanePoolSize(bad, 'parallel.lanes')).toThrow();
    }
  });
});

describe('reserved lane ids', () => {
  it('rejects "none", which selects the default workspace rather than naming a lane', () => {
    // Without this, `--lane none` meant as "use the default workspace" would create a lane called
    // "none" — it matches the id pattern perfectly.
    expect(() => {
      assertValidLaneId('none');
    }).toThrow(/reserved/);
  });
});
