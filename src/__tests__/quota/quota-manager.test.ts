/**
 * Unit tests for QuotaManager — cooldown build-up/decay, reliability ratio,
 * and the interaction between the two, all driven by an injected clock so
 * behavior is deterministic and never depends on wall-clock time.
 */

import { describe, it, expect } from 'vitest';
import { QuotaManager } from '../../quota/quota-manager.js';

function withClock(startMs = 1_000_000) {
  let now = startMs;
  const clock = () => now;
  const advance = (ms: number) => {
    now += ms;
  };
  return { clock, advance };
}

describe('QuotaManager', () => {
  it('reports unknown for an engine with no recorded history', () => {
    const { clock } = withClock();
    const qm = new QuotaManager(clock);
    expect(qm.getSnapshot('claude').state).toBe('unknown');
  });

  it('reports available after a recorded success', () => {
    const { clock } = withClock();
    const qm = new QuotaManager(clock);
    qm.recordSuccess('claude');
    expect(qm.getSnapshot('claude').state).toBe('available');
  });

  it('opens a cooldown after a quota-classified failure and clears it once elapsed', () => {
    const { clock, advance } = withClock();
    const qm = new QuotaManager(clock);
    qm.recordFailure('codex', 'quota', 'rate_limit');

    const snap = qm.getSnapshot('codex');
    expect(snap.state).toBe('cooldown');
    expect(snap.resetAt).toBeDefined();

    // Still within cooldown window
    advance(1_000);
    expect(qm.getSnapshot('codex').state).toBe('cooldown');

    // Base cooldown is 30s (QUOTA_COOLDOWN_BASE_MS) — advance past it
    advance(60_000);
    expect(qm.getSnapshot('codex').state).not.toBe('cooldown');
  });

  it('doubles the cooldown for consecutive quota failures (exponential backoff)', () => {
    const { clock, advance } = withClock();
    const qm = new QuotaManager(clock);

    qm.recordFailure('gemini', 'quota');
    advance(30_001); // first cooldown (30s) just elapsed
    expect(qm.getSnapshot('gemini').state).not.toBe('cooldown');

    qm.recordFailure('gemini', 'quota'); // second consecutive failure -> ~60s cooldown
    advance(30_001);
    expect(qm.getSnapshot('gemini').state).toBe('cooldown'); // first window would've cleared, second hasn't
  });

  it('recordSuccess clears an existing cooldown and resets the consecutive-failure counter', () => {
    const { clock, advance } = withClock();
    const qm = new QuotaManager(clock);
    qm.recordFailure('cursor', 'quota');
    expect(qm.getSnapshot('cursor').state).toBe('cooldown');

    qm.recordSuccess('cursor');
    expect(qm.getSnapshot('cursor').state).toBe('available');

    // A fresh single failure after a reset should reopen only the base cooldown, not a doubled one
    qm.recordFailure('cursor', 'quota');
    advance(30_001);
    expect(qm.getSnapshot('cursor').state).not.toBe('cooldown');
  });

  it('an auth failure marks the engine exhausted until the next success', () => {
    const { clock } = withClock();
    const qm = new QuotaManager(clock);
    qm.recordFailure('claude', 'auth', 'invalid api key');
    expect(qm.getSnapshot('claude').state).toBe('exhausted');

    qm.recordSuccess('claude');
    expect(qm.getSnapshot('claude').state).toBe('available');
  });

  it('an engine failure (spawn/CLI) does not open a quota cooldown', () => {
    const { clock } = withClock();
    const qm = new QuotaManager(clock);
    qm.recordFailure('opencode', 'engine', 'ENOENT');
    const snap = qm.getSnapshot('opencode');
    expect(snap.state).not.toBe('cooldown');
    expect(snap.state).not.toBe('exhausted');
  });

  it('a task failure never affects quota state', () => {
    const { clock } = withClock();
    const qm = new QuotaManager(clock);
    qm.recordSuccess('claude');
    qm.recordFailure('claude', 'task', 'assertion failed');
    expect(qm.getSnapshot('claude').state).toBe('available');
  });

  it('degrades an engine once reliability drops below (1 - safetyMargin)', () => {
    const { clock } = withClock();
    const qm = new QuotaManager(clock, 0.2); // degraded threshold: reliability < 0.8

    // 'engine'-classified failures count against reliability without opening
    // a cooldown/exhausted state (unlike 'quota'/'auth'), so this isolates
    // the degraded-via-reliability path specifically.
    // 1 success, 4 engine-failures => reliability 1/5 = 0.2, well below 0.8
    qm.recordSuccess('claude');
    for (let i = 0; i < 4; i++) qm.recordFailure('claude', 'engine');

    expect(qm.getReliability('claude')).toBeCloseTo(0.2, 5);
    expect(qm.getSnapshot('claude').state).toBe('degraded');
  });

  it('a task-classified failure counts as a success for reliability purposes (content bugs are not engine-health signals)', () => {
    const { clock } = withClock();
    const qm = new QuotaManager(clock);
    qm.recordSuccess('claude');
    for (let i = 0; i < 4; i++) qm.recordFailure('claude', 'task');
    expect(qm.getReliability('claude')).toBe(1);
  });

  it('getAllStatuses returns a stable, alphabetically sorted snapshot', () => {
    const { clock } = withClock();
    const qm = new QuotaManager(clock);
    qm.recordSuccess('gemini');
    qm.recordSuccess('claude');
    qm.recordFailure('codex', 'quota');

    expect(Object.keys(qm.getAllStatuses())).toEqual(['claude', 'codex', 'gemini']);
  });

  it('setExhausted marks an engine unusable regardless of prior state', () => {
    const { clock } = withClock();
    const qm = new QuotaManager(clock);
    qm.recordSuccess('claude');
    qm.setExhausted('claude', 'manual budget exhausted');
    expect(qm.getSnapshot('claude').state).toBe('exhausted');
  });

  it('uses an official provider snapshot unless a stronger local cooldown is active', () => {
    const { clock } = withClock();
    const qm = new QuotaManager(clock);
    qm.recordSuccess('codex');
    qm.setProviderSnapshot('codex', {
      state: 'degraded',
      reason: 'official quota 90% used',
      observedAt: new Date(clock()).toISOString(),
    });
    expect(qm.getSnapshot('codex').state).toBe('degraded');

    qm.recordFailure('codex', 'quota', 'live rate limit');
    expect(qm.getSnapshot('codex').state).toBe('cooldown');
  });
});
