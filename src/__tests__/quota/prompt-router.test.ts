/**
 * Unit tests for PromptRouter — determinism, exclusion rules, explicit
 * override, and the unknown-is-not-unusable requirement.
 */

import { describe, it, expect } from 'vitest';
import { PromptRouter } from '../../quota/prompt-router.js';
import { QuotaManager } from '../../quota/quota-manager.js';
import { CircuitBreaker } from '../../circuit-breaker.js';
import type { PromptRoutingConfig } from '../../quota/quota-types.js';

function baseConfig(overrides: Partial<PromptRoutingConfig> = {}): PromptRoutingConfig {
  return {
    enabled: true,
    strategy: 'balanced',
    fallback: true,
    safetyMargin: 0.15,
    engines: {
      claude: { enabled: true, priority: 100 },
      codex: { enabled: true, priority: 90 },
      gemini: { enabled: true, priority: 80 },
      cursor: { enabled: true, priority: 70 },
    },
    ...overrides,
  };
}

describe('PromptRouter', () => {
  it('is deterministic — identical input scored twice yields an identical decision', () => {
    const router = new PromptRouter(baseConfig(), new QuotaManager(), new CircuitBreaker());
    const d1 = router.route({});
    const d2 = router.route({});
    expect(d2).toEqual(d1);
  });

  it('picks the highest-priority healthy engine when all are available (all-engines-available scenario)', () => {
    const qm = new QuotaManager();
    qm.recordSuccess('claude');
    qm.recordSuccess('codex');
    qm.recordSuccess('gemini');
    qm.recordSuccess('cursor');
    const router = new PromptRouter(baseConfig(), qm, new CircuitBreaker());
    const decision = router.route({});
    expect(decision.engine).toBe('claude'); // highest configured priority
  });

  it('excludes an engine whose quota is in cooldown (preferred engine nearly exhausted scenario)', () => {
    const qm = new QuotaManager();
    qm.recordSuccess('claude');
    qm.recordSuccess('codex');
    qm.recordFailure('claude', 'quota', 'rate_limit'); // claude now in cooldown despite highest priority
    const router = new PromptRouter(baseConfig(), qm, new CircuitBreaker());
    const decision = router.route({});
    expect(decision.engine).toBe('codex');
    const claudeCandidate = decision.candidates.find((c) => c.engine === 'claude');
    expect(claudeCandidate?.excluded).toMatch(/cooldown/);
  });

  it('a degraded (but not cooled-down) engine is still a candidate, just out-scored by a healthy lower-priority peer', () => {
    // Simulated "preferred engine nearly exhausted" scenario: claude has the
    // highest configured priority but a poor recent reliability ratio from
    // repeated engine-level failures (not quota — those would hard-exclude
    // via cooldown instead, see the test above). It must remain a scoreable
    // candidate (degraded != excluded) while losing out to a healthy engine.
    const qm = new QuotaManager();
    qm.recordSuccess('claude');
    for (let i = 0; i < 4; i++) qm.recordFailure('claude', 'engine');
    qm.recordSuccess('codex');

    const router = new PromptRouter(baseConfig(), qm, new CircuitBreaker());
    const decision = router.route({});

    const claudeCandidate = decision.candidates.find((c) => c.engine === 'claude');
    expect(claudeCandidate?.excluded).toBeUndefined();
    expect(decision.engine).toBe('codex');
    expect(decision.score).toBeGreaterThan(claudeCandidate!.score);
  });

  it('excludes an engine whose circuit breaker is open', () => {
    const cb = new CircuitBreaker();
    cb.recordFailure('claude');
    cb.recordFailure('claude');
    cb.recordFailure('claude'); // CIRCUIT_BREAKER_THRESHOLD = 3
    const qm = new QuotaManager();
    qm.recordSuccess('codex');
    const router = new PromptRouter(baseConfig(), qm, cb);
    const decision = router.route({});
    expect(decision.engine).toBe('codex');
    expect(decision.candidates.find((c) => c.engine === 'claude')?.excluded).toMatch(/circuit breaker/);
  });

  it('does NOT exclude an engine with unknown quota — unknown is not automatically unusable', () => {
    // No recordSuccess/recordFailure calls at all -> every engine is 'unknown'.
    const router = new PromptRouter(baseConfig(), new QuotaManager(), new CircuitBreaker());
    const decision = router.route({});
    // Highest-priority engine should still win purely on priority, since all are equally 'unknown'.
    expect(decision.engine).toBe('claude');
    expect(decision.candidates.every((c) => !c.excluded)).toBe(true);
  });

  it('excludes a disabled engine via config', () => {
    const config = baseConfig({
      engines: { claude: { enabled: false, priority: 100 }, codex: { enabled: true, priority: 90 } },
    });
    const router = new PromptRouter(config, new QuotaManager(), new CircuitBreaker());
    const decision = router.route({});
    expect(decision.engine).toBe('codex');
    expect(decision.candidates.find((c) => c.engine === 'claude')?.excluded).toMatch(/disabled/);
  });

  it('respects an explicit engine override and skips scoring entirely', () => {
    const qm = new QuotaManager();
    qm.setExhausted('codex', 'manually exhausted');
    const router = new PromptRouter(baseConfig(), qm, new CircuitBreaker());
    const decision = router.route({ explicitEngine: 'codex' });
    expect(decision.engine).toBe('codex');
    expect(decision.candidates).toEqual([{ engine: 'codex', score: 1 }]);
  });

  it('breaks a tied score by configured priority, then lexically by engine name', () => {
    // Equal priority, equal (unknown) quota state -> pure lexical tiebreak.
    const config = baseConfig({
      engines: {
        cursor: { enabled: true, priority: 50 },
        codex: { enabled: true, priority: 50 },
      },
    });
    const router = new PromptRouter(config, new QuotaManager(), new CircuitBreaker());
    const decision = router.route({});
    expect(decision.engine).toBe('codex'); // 'codex' < 'cursor' lexically
  });

  it('a preferred engine is weighted above a merely higher-priority alternative', () => {
    const qm = new QuotaManager();
    qm.recordSuccess('claude');
    qm.recordSuccess('cursor');
    const router = new PromptRouter(baseConfig(), qm, new CircuitBreaker());
    const decision = router.route({ preferredEngine: 'cursor' });
    expect(decision.engine).toBe('cursor');
  });

  it('throws when every configured engine is excluded', () => {
    const qm = new QuotaManager();
    qm.setExhausted('claude', 'x');
    qm.setExhausted('codex', 'x');
    qm.setExhausted('gemini', 'x');
    qm.setExhausted('cursor', 'x');
    const router = new PromptRouter(baseConfig(), qm, new CircuitBreaker());
    expect(() => router.route({})).toThrow(/no engine available/);
  });

  it('produces a human-readable explain trace for every candidate plus the final choice', () => {
    const router = new PromptRouter(baseConfig(), new QuotaManager(), new CircuitBreaker());
    const decision = router.route({});
    expect(decision.explain.length).toBeGreaterThanOrEqual(baseConfig().engines ? 4 : 0);
    expect(decision.explain.some((line) => line.startsWith('chosen:'))).toBe(true);
  });

  it('a missing/non-numeric priority never produces a NaN score (runtime JSON config is not type-checked)', () => {
    // Simulates a hand-written CLAWO_PROMPT_ROUTING_CONFIG JSON blob that
    // omits `priority` — the TS type says it's required, but nothing
    // enforces that at runtime.
    const config = baseConfig({
      engines: {
        claude: { enabled: true } as unknown as { enabled: boolean; priority: number },
        codex: { enabled: true, priority: 50 },
      },
    });
    const router = new PromptRouter(config, new QuotaManager(), new CircuitBreaker());
    const decision = router.route({});

    expect(Number.isNaN(decision.score)).toBe(false);
    for (const candidate of decision.candidates) {
      expect(Number.isNaN(candidate.score)).toBe(false);
    }
    // Missing priority normalizes to 0 — codex (priority 50) should win.
    expect(decision.engine).toBe('codex');
    expect(decision.explain.some((line) => line.includes('priority=0'))).toBe(true);
  });
});
