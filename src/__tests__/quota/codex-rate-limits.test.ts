import { describe, expect, it, vi } from 'vitest';
import {
  CodexRateLimitsProvider,
  mapCodexRateLimitsResponse,
  type CodexRateLimitsReader,
} from '../../quota/codex-rate-limits.js';

const NOW = 1_800_000_000_000;
const FUTURE_SECONDS = NOW / 1000 + 3_600;

function window(usedPercent: number, resetsAt = FUTURE_SECONDS) {
  return { usedPercent, windowDurationMins: 60, resetsAt };
}

function bucket(usedPercent: number, secondary?: number) {
  return {
    limitId: 'codex',
    limitName: null,
    primary: window(usedPercent),
    secondary: secondary === undefined ? null : window(secondary),
    rateLimitReachedType: null,
    planType: 'plus',
  };
}

describe('mapCodexRateLimitsResponse', () => {
  it('maps an available primary window', () => {
    expect(mapCodexRateLimitsResponse({ rateLimits: bucket(25) }, 0.15, NOW).state).toBe('available');
  });

  it('uses a stricter secondary window conservatively', () => {
    const snapshot = mapCodexRateLimitsResponse({ rateLimits: bucket(20, 90) }, 0.15, NOW);
    expect(snapshot.state).toBe('degraded');
    expect(snapshot.reason).toContain('90%');
  });

  it('uses the strictest bucket from the multi-bucket view', () => {
    const snapshot = mapCodexRateLimitsResponse(
      {
        rateLimits: bucket(5),
        rateLimitsByLimitId: {
          codex: bucket(30),
          codex_other: { ...bucket(92), limitId: 'codex_other' },
        },
      },
      0.15,
      NOW,
    );
    expect(snapshot.state).toBe('degraded');
    expect(snapshot.reason).toContain('92%');
  });

  it('supports the backward-compatible single-bucket view', () => {
    expect(mapCodexRateLimitsResponse({ rateLimits: bucket(10) }, 0.15, NOW)).toMatchObject({
      state: 'available',
      observedAt: new Date(NOW).toISOString(),
    });
  });

  it.each([
    undefined,
    {},
    { rateLimits: {} },
    { rateLimits: { ...bucket(10), primary: { usedPercent: '10' } } },
    { rateLimitsByLimitId: { codex: null } },
  ])('maps missing or invalid data to unknown', (response) => {
    expect(mapCodexRateLimitsResponse(response, 0.15, NOW).state).toBe('unknown');
  });

  it('marks usage at the configured safety margin as degraded', () => {
    expect(mapCodexRateLimitsResponse({ rateLimits: bucket(80) }, 0.2, NOW).state).toBe('degraded');
  });

  it('maps a reached limit to cooldown and preserves the conservative reset time', () => {
    const response = {
      rateLimits: {
        ...bucket(100, 100),
        rateLimitReachedType: 'primary',
        primary: window(100, FUTURE_SECONDS),
        secondary: window(100, FUTURE_SECONDS + 600),
      },
    };
    const snapshot = mapCodexRateLimitsResponse(response, 0.15, NOW);
    expect(snapshot.state).toBe('cooldown');
    expect(snapshot.resetAt).toBe(new Date((FUTURE_SECONDS + 600) * 1000).toISOString());
  });

  it('maps a reached limit without a future reset to exhausted', () => {
    const response = {
      rateLimits: {
        ...bucket(100),
        rateLimitReachedType: 'primary',
        primary: window(100, NOW / 1000 - 1),
      },
    };
    expect(mapCodexRateLimitsResponse(response, 0.15, NOW).state).toBe('exhausted');
  });
});

describe('CodexRateLimitsProvider', () => {
  it('fails safe to unknown on a protocol error', async () => {
    const reader: CodexRateLimitsReader = { readRateLimits: vi.fn().mockRejectedValue(new Error('protocol')) };
    const provider = new CodexRateLimitsProvider(reader, {
      timeoutMs: 50,
      ttlMs: 1_000,
      safetyMargin: 0.15,
      clock: () => NOW,
    });
    await expect(provider.getSnapshot()).resolves.toMatchObject({ state: 'unknown' });
  });

  it('fails safe to unknown and resets the reader on timeout', async () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    const reader: CodexRateLimitsReader = {
      readRateLimits: vi.fn(() => new Promise(() => undefined)),
      stop,
    };
    const provider = new CodexRateLimitsProvider(reader, {
      timeoutMs: 50,
      ttlMs: 1_000,
      safetyMargin: 0.15,
      clock: () => NOW,
    });
    const pending = provider.getSnapshot();
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toMatchObject({ state: 'unknown' });
    expect(stop).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('uses its TTL cache to avoid repeated App Server reads', async () => {
    let now = NOW;
    const readRateLimits = vi.fn().mockResolvedValue({ rateLimits: bucket(25) });
    const provider = new CodexRateLimitsProvider(
      { readRateLimits },
      { timeoutMs: 50, ttlMs: 1_000, safetyMargin: 0.15, clock: () => now },
    );

    await provider.getSnapshot();
    now += 999;
    await provider.getSnapshot();
    expect(readRateLimits).toHaveBeenCalledOnce();

    now += 2;
    await provider.getSnapshot();
    expect(readRateLimits).toHaveBeenCalledTimes(2);
  });
});
