/**
 * In-memory quota/reliability tracking per engine.
 *
 * Mirrors the existing CircuitBreaker pattern (Map<engine, state>, exponential
 * backoff) but tracks a different concern: not "did the subprocess spawn",
 * but "is this engine's quota currently healthy" based on classified outcomes
 * of start/send attempts. Complementary to CircuitBreaker, not a replacement —
 * PromptRouter consults both.
 *
 * v1 is in-memory only. Persistent local status (without credentials) is
 * designed but deferred — see docs/quota-aware-routing-plan.md §9 (v1.x).
 */

import {
  DEFAULT_ROUTING_SAFETY_MARGIN,
  QUOTA_COOLDOWN_BASE_MS,
  QUOTA_COOLDOWN_MAX_MS,
  QUOTA_RELIABILITY_WINDOW,
} from '../constants.js';
import type { EngineType } from '../types.js';
import type { ErrorClassification, QuotaSnapshot, QuotaState } from './quota-types.js';

interface EngineState {
  consecutiveQuotaFailures: number;
  cooldownUntil: number;
  lastFailureReason?: string;
  lastFailureAt?: number;
  lastSuccessAt?: number;
  /** Sliding window of recent outcomes, most recent last. true = success. */
  recentOutcomes: boolean[];
  /** Set once an 'auth' failure is observed; cleared on next success. */
  authFailed: boolean;
}

function freshState(): EngineState {
  return {
    consecutiveQuotaFailures: 0,
    cooldownUntil: 0,
    recentOutcomes: [],
    authFailed: false,
  };
}

export class QuotaManager {
  private engines = new Map<EngineType, EngineState>();

  constructor(
    private clock: () => number = Date.now,
    /** Configurable safety margin (0..1) — reliability below (1 - margin) is reported as 'degraded'. */
    private safetyMargin: number = DEFAULT_ROUTING_SAFETY_MARGIN,
  ) {}

  private stateFor(engine: EngineType): EngineState {
    let state = this.engines.get(engine);
    if (!state) {
      state = freshState();
      this.engines.set(engine, state);
    }
    return state;
  }

  /**
   * Record a successful start/send — clears cooldown, auth-failed status,
   * AND the reliability window (mirrors CircuitBreaker.reset()'s full-clear
   * semantics elsewhere in this codebase: one confirmed success means the
   * engine is healthy now, not "50% reliable over its last two attempts").
   */
  recordSuccess(engine: EngineType): void {
    const state = this.stateFor(engine);
    state.consecutiveQuotaFailures = 0;
    state.cooldownUntil = 0;
    state.authFailed = false;
    state.lastSuccessAt = this.clock();
    state.recentOutcomes = [];
    state.recentOutcomes.push(true);
    if (state.recentOutcomes.length > QUOTA_RELIABILITY_WINDOW) state.recentOutcomes.shift();
  }

  /**
   * Record a failed start/send. Only 'quota' classifications open a cooldown;
   * 'task' failures never affect quota state (they are ordinary content
   * failures, not engine-health signals).
   */
  recordFailure(engine: EngineType, classification: ErrorClassification, reason?: string): void {
    const state = this.stateFor(engine);
    const now = this.clock();
    state.lastFailureAt = now;
    state.lastFailureReason = reason;

    if (classification === 'task') {
      // Ordinary content failure — the engine itself worked fine (it ran and
      // responded), so this counts as a SUCCESS for reliability purposes.
      // Only quota/auth/engine failures are evidence the engine is unhealthy.
      state.recentOutcomes.push(true);
      if (state.recentOutcomes.length > QUOTA_RELIABILITY_WINDOW) state.recentOutcomes.shift();
      return;
    }

    state.recentOutcomes.push(false);
    if (state.recentOutcomes.length > QUOTA_RELIABILITY_WINDOW) state.recentOutcomes.shift();

    if (classification === 'auth') {
      state.authFailed = true;
      return;
    }

    if (classification === 'quota') {
      state.consecutiveQuotaFailures += 1;
      const backoff = Math.min(
        QUOTA_COOLDOWN_BASE_MS * Math.pow(2, state.consecutiveQuotaFailures - 1),
        QUOTA_COOLDOWN_MAX_MS,
      );
      state.cooldownUntil = now + backoff;
    }
    // 'engine' failures (spawn/CLI-level) are left to CircuitBreaker; we still
    // record the outcome above for reliability purposes but don't cooldown.
  }

  /**
   * Manually mark an engine exhausted (e.g. a user-configured budget was hit)
   * until the next recorded success — always permanent, never a timed
   * cooldown (use `recordFailure(engine, 'quota', ...)` for that instead).
   */
  setExhausted(engine: EngineType, reason: string): void {
    const state = this.stateFor(engine);
    state.cooldownUntil = Number.MAX_SAFE_INTEGER;
    state.lastFailureReason = reason;
  }

  getSnapshot(engine: EngineType): QuotaSnapshot {
    const state = this.engines.get(engine);
    const now = this.clock();
    const observedAt = new Date(now).toISOString();
    if (!state) {
      return { state: 'unknown', observedAt };
    }

    if (state.authFailed) {
      return { state: 'exhausted', reason: state.lastFailureReason || 'authentication failure', observedAt };
    }

    if (state.cooldownUntil > now) {
      const isPermanent = state.cooldownUntil >= Number.MAX_SAFE_INTEGER;
      const derivedState: QuotaState = isPermanent ? 'exhausted' : 'cooldown';
      return {
        state: derivedState,
        reason: state.lastFailureReason || `${state.consecutiveQuotaFailures} consecutive quota failure(s)`,
        resetAt: isPermanent ? undefined : new Date(state.cooldownUntil).toISOString(),
        observedAt,
      };
    }

    const reliability = this.getReliability(engine);
    const degradedThreshold = 1 - this.safetyMargin;
    if (state.recentOutcomes.length > 0 && reliability < degradedThreshold) {
      return {
        state: 'degraded',
        reason: `reliability ${Math.round(reliability * 100)}% over recent attempts`,
        observedAt,
      };
    }

    return { state: 'available', observedAt };
  }

  /** Success ratio over the recent-outcomes window. 1 when no history exists yet. */
  getReliability(engine: EngineType): number {
    const state = this.engines.get(engine);
    if (!state || state.recentOutcomes.length === 0) return 1;
    const successes = state.recentOutcomes.filter(Boolean).length;
    return successes / state.recentOutcomes.length;
  }

  getAllStatuses(): Record<string, QuotaSnapshot> {
    return Object.fromEntries([...this.engines.keys()].sort().map((engine) => [engine, this.getSnapshot(engine)]));
  }
}
