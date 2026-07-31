/**
 * Integration tests for quota-aware routing wired into SessionManager.
 *
 * These go through `startSession`/`sendMessage` with `_createSession`
 * monkey-patched (same pattern as circuit-breaker.test.ts) so they exercise
 * the actual chokepoint at session-manager.ts (engine resolution just before
 * `_createSession`), not just the PromptRouter class in isolation. That is
 * the only way to prove the feature-flag-off path is byte-for-byte
 * unchanged, and that a persisted session's engine is never silently
 * re-routed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type {
  ISession,
  SessionConfig,
  SessionStats,
  SessionSendOptions,
  TurnResult,
  CostBreakdown,
  EffortLevel,
  PromptRoutingConfig,
} from '../../types.js';

// ─── Mock ISession ─────────────────────────────────────────────────────────

class MockSession extends EventEmitter implements ISession {
  sessionId?: string;
  private _isReady = true;
  private _isPaused = false;
  private _isBusy = false;
  private _effort: EffortLevel = 'auto';

  constructor(
    private failStartWith?: Error,
    private failSendWith?: Error,
  ) {
    super();
  }

  get isReady() {
    return this._isReady;
  }
  get isPaused() {
    return this._isPaused;
  }
  get isBusy() {
    return this._isBusy;
  }

  async start(): Promise<this> {
    if (this.failStartWith) throw this.failStartWith;
    this.sessionId = `mock-${Math.random().toString(36).slice(2)}`;
    return this;
  }
  stop(): void {}
  pause(): void {
    this._isPaused = true;
  }
  resume(): void {
    this._isPaused = false;
  }
  async send(
    message: string | unknown[],
    _options?: SessionSendOptions,
  ): Promise<TurnResult | { requestId: number; sent: boolean }> {
    if (this.failSendWith) throw this.failSendWith;
    return { text: `response: ${message}`, event: { type: 'result', result: 'done' } };
  }
  getStats(): SessionStats & { sessionId?: string; uptime: number } {
    return {
      turns: 0,
      toolCalls: 0,
      toolErrors: 0,
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
      costUsd: 0,
      isReady: this._isReady,
      startTime: null,
      lastActivity: null,
      contextPercent: 0,
      sessionId: this.sessionId,
      uptime: 0,
    };
  }
  getHistory() {
    return [];
  }
  getCost(): CostBreakdown {
    return {
      model: 'mock',
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
      pricing: { inputPer1M: 0, outputPer1M: 0, cachedPer1M: undefined },
      breakdown: { inputCost: 0, cachedCost: 0, outputCost: 0 },
      totalUsd: 0,
    };
  }
  async compact(): Promise<TurnResult> {
    return { text: 'compacted', event: { type: 'result' } };
  }
  getEffort(): EffortLevel {
    return this._effort;
  }
  setEffort(level: EffortLevel): void {
    this._effort = level;
  }
  resolveModel(alias: string): string {
    return alias;
  }
}

// ─── Mock fs (avoid touching ~/.openclaw/*.json) ───────────────────────────

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const patched = {
    ...actual,
    existsSync: vi.fn((p: string) => {
      if (typeof p === 'string' && (p.includes('claude-sessions.json') || p.includes('session-pids.json')))
        return false;
      return actual.existsSync(p);
    }),
    readFileSync: vi.fn((p: string, enc?: string) => {
      if (typeof p === 'string' && p.includes('claude-sessions.json')) return '[]';
      return actual.readFileSync(p, enc as BufferEncoding);
    }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
  return { ...patched, default: patched };
});

const { SessionManager } = await import('../../session-manager.js');

// ─── Helpers ────────────────────────────────────────────────────────────────

let engineCalls: string[] = [];
let failStartFor: Record<string, Error> = {};

function patchCreateSession(manager: InstanceType<typeof SessionManager>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (manager as any)._createSession = (engine: string, _config: SessionConfig): ISession => {
    engineCalls.push(engine);
    return new MockSession(failStartFor[engine]);
  };
}

function routingConfig(overrides: Partial<PromptRoutingConfig> = {}): PromptRoutingConfig {
  return {
    enabled: true,
    strategy: 'balanced',
    fallback: true,
    safetyMargin: 0.15,
    engines: {
      claude: { enabled: true, priority: 100 },
      codex: { enabled: true, priority: 50 },
    },
    ...overrides,
  };
}

describe('Quota-aware routing — SessionManager integration', () => {
  beforeEach(() => {
    engineCalls = [];
    failStartFor = {};
  });

  describe('regression: routing must never change existing behavior unless explicitly enabled', () => {
    it('with promptRouting absent, resolves to the claude default exactly as before', async () => {
      const manager = new SessionManager();
      patchCreateSession(manager);
      await manager.startSession({ name: 'r1', cwd: '/tmp' });
      expect(engineCalls).toEqual(['claude']);
      await manager.shutdown();
    });

    it('with promptRouting enabled, an explicit caller-supplied engine still bypasses routing entirely', async () => {
      const manager = new SessionManager({
        promptRouting: routingConfig({
          engines: { claude: { enabled: true, priority: 1 }, codex: { enabled: true, priority: 1000 } },
        }),
      });
      patchCreateSession(manager);
      // codex has a vastly higher priority, but the caller pinned 'claude' explicitly.
      await manager.startSession({ name: 'r2', cwd: '/tmp', engine: 'claude' });
      expect(engineCalls).toEqual(['claude']);
      await manager.shutdown();
    });

    it('with promptRouting enabled, a PERSISTED session engine is resumed onto and never re-routed', async () => {
      // codex has the higher priority (would win routing if it ran); claude is
      // what's actually persisted for this session name (persistence keys off
      // an engine-specific resumable ID — MockSession's generic `sessionId`
      // only satisfies that for the 'claude' resume-id path, see
      // `_sessionResumeId` in session-manager.ts). If the guard at
      // session-manager.ts were `!fullConfig.engine` only (missing the
      // `!persisted?.engine` check), this would incorrectly re-route to codex.
      const manager = new SessionManager({
        promptRouting: routingConfig({
          engines: { claude: { enabled: true, priority: 10 }, codex: { enabled: true, priority: 200 } },
        }),
      });
      patchCreateSession(manager);

      await manager.startSession({ name: 'resume-me', cwd: '/tmp', engine: 'claude' });
      await manager.stopSession('resume-me', { keepPersisted: true });
      engineCalls = [];

      await manager.startSession({ name: 'resume-me' });
      expect(engineCalls).toEqual(['claude']);
      await manager.shutdown();
    });
  });

  describe('routing enabled: positive scenarios', () => {
    it('all engines available/unknown: picks the highest-priority engine', async () => {
      const manager = new SessionManager({ promptRouting: routingConfig() });
      patchCreateSession(manager);
      await manager.startSession({ name: 'p1', cwd: '/tmp' });
      expect(engineCalls).toEqual(['claude']);
      await manager.shutdown();
    });

    it('an engine disabled via config is never chosen', async () => {
      const manager = new SessionManager({
        promptRouting: routingConfig({
          engines: { claude: { enabled: false, priority: 100 }, codex: { enabled: true, priority: 50 } },
        }),
      });
      patchCreateSession(manager);
      await manager.startSession({ name: 'p2', cwd: '/tmp' });
      expect(engineCalls).toEqual(['codex']);
      await manager.shutdown();
    });

    it('fallback after a simulated quota failure: the next routed session avoids the failed engine', async () => {
      const manager = new SessionManager({ promptRouting: routingConfig() });
      patchCreateSession(manager);

      failStartFor.claude = new Error('rate limit exceeded, please retry later');
      await expect(manager.startSession({ name: 'fail-1', cwd: '/tmp' })).rejects.toThrow('rate limit');
      expect(engineCalls).toEqual(['claude']); // router picked claude first (highest priority)

      engineCalls = [];
      await manager.startSession({ name: 'fail-2', cwd: '/tmp' }); // no engine specified -> routed again
      expect(engineCalls).toEqual(['codex']); // claude now in quota cooldown, excluded
      await manager.shutdown();
    });

    it('does NOT fall back after an ordinary (non-quota) task/content error', async () => {
      const manager = new SessionManager({ promptRouting: routingConfig() });
      patchCreateSession(manager);

      failStartFor.claude = new Error('generated code failed an assertion');
      await expect(manager.startSession({ name: 'ok-1', cwd: '/tmp' })).rejects.toThrow('assertion');
      expect(engineCalls).toEqual(['claude']);

      failStartFor = {}; // clear so the second attempt can actually succeed
      engineCalls = [];
      await manager.startSession({ name: 'ok-2', cwd: '/tmp' });
      expect(engineCalls).toEqual(['claude']); // still claude — task error must not have opened a cooldown
      await manager.shutdown();
    });

    it('previewRoute() is deterministic and never starts a session or mutates state', async () => {
      const manager = new SessionManager({ promptRouting: routingConfig() });
      patchCreateSession(manager);

      const d1 = manager.previewRoute({});
      const d2 = manager.previewRoute({});
      expect(d2).toEqual(d1);
      expect(engineCalls).toEqual([]); // no session was actually created
      await manager.shutdown();
    });

    it('previewRoute() throws when routing is disabled — nothing to preview', async () => {
      const manager = new SessionManager();
      expect(() => manager.previewRoute({})).toThrow(/disabled/);
      await manager.shutdown();
    });

    it('health() exposes per-engine quota status', async () => {
      const manager = new SessionManager({ promptRouting: routingConfig() });
      patchCreateSession(manager);
      await manager.startSession({ name: 'h1', cwd: '/tmp' });
      const health = manager.health();
      expect(health.quota.claude?.state).toBe('available');
      await manager.shutdown();
    });
  });
});
