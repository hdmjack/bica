import { describe, expect, it } from 'vitest';

import type { CancelOutcome } from './remoteClaim';
import { cancelSettledTheClaim, tearDownRunOnSignal } from './signalTeardown';

const NOTHING: CancelOutcome = {
  cleared: false,
  signalled: false,
  notMine: false,
  noClaim: false,
  neverRan: false,
};

function parts(cancelClaim: () => CancelOutcome) {
  const calls: string[] = [];
  return {
    calls,
    parts: {
      cancelClaim,
      disarmWatchdog: () => calls.push('disarm'),
      stopHeartbeat: () => calls.push('heartbeat'),
      terminateLocalConnections: () => calls.push('terminate'),
    },
  };
}

/**
 * The 0.10.0 report: SIGTERM printed "ending the remote command and releasing the workspace", the
 * process exited, and every later run was refused (98) for as long as it was left alone. The cancel's
 * ssh shares a process group with whatever sent the signal, so it often fails; the watchdog that
 * covers exactly that case had already been disarmed.
 */
describe('a run told to stop by a signal', () => {
  it('disarms the watchdog once the remote confirms the claim is cleared', () => {
    const t = parts(() => ({ ...NOTHING, cleared: true, signalled: true }));
    expect(tearDownRunOnSignal(t.parts).confirmed).toBe(true);
    expect(t.calls).toContain('disarm');
  });

  it('leaves the watchdog armed when the cancel reports nothing, as when its ssh was killed too', () => {
    const t = parts(() => NOTHING);
    expect(tearDownRunOnSignal(t.parts).confirmed).toBe(false);
    expect(t.calls).not.toContain('disarm');
  });

  it('leaves the watchdog armed when the cancel throws', () => {
    const t = parts(() => {
      throw new Error('spawn ssh ENOENT');
    });
    expect(tearDownRunOnSignal(t.parts).confirmed).toBe(false);
    expect(t.calls).not.toContain('disarm');
  });

  it('still stops the heartbeat and the local connections when the cancel failed', () => {
    const t = parts(() => NOTHING);
    tearDownRunOnSignal(t.parts);
    expect(t.calls).toEqual(['heartbeat', 'terminate']);
  });

  it('asks the remote before it stands anything down', () => {
    const order: string[] = [];
    tearDownRunOnSignal({
      cancelClaim: () => {
        order.push('cancel');
        return { ...NOTHING, cleared: true };
      },
      disarmWatchdog: () => order.push('disarm'),
      stopHeartbeat: () => order.push('heartbeat'),
      terminateLocalConnections: () => order.push('terminate'),
    });
    expect(order).toEqual(['cancel', 'disarm', 'heartbeat', 'terminate']);
  });
});

describe('cancelSettledTheClaim', () => {
  it('counts a claim that is gone or belongs to another run as settled', () => {
    expect(cancelSettledTheClaim({ ...NOTHING, noClaim: true })).toBe(true);
    expect(cancelSettledTheClaim({ ...NOTHING, notMine: true })).toBe(true);
  });

  it('does not count a reply that says nothing, or no reply at all', () => {
    expect(cancelSettledTheClaim(NOTHING)).toBe(false);
    expect(cancelSettledTheClaim(undefined)).toBe(false);
  });
});
