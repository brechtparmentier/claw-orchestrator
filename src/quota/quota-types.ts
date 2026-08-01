/**
 * Shared types for quota-aware prompt routing.
 */

import type { EngineType } from '../types.js';

// ─── Quota State ─────────────────────────────────────────────────────────────

export type QuotaState = 'available' | 'degraded' | 'cooldown' | 'exhausted' | 'unknown';

export interface QuotaSnapshot {
  state: QuotaState;
  /** Human-readable reason for the current state, e.g. "3 consecutive rate_limit failures" */
  reason?: string;
  /** ISO timestamp when the engine is expected to be usable again, if known */
  resetAt?: string;
  /** ISO timestamp of this measurement */
  observedAt: string;
}

// ─── Error Classification ────────────────────────────────────────────────────

/**
 * 'quota'  — rate-limited / usage-limit-exceeded, expected to recover after a cooldown
 * 'auth'   — authentication/authorization failure, engine unusable until reconfigured
 * 'engine' — the CLI itself failed to run (spawn failure, missing binary, crash)
 * 'task'   — an ordinary content/task failure; must NEVER trigger routing fallback
 */
export type ErrorClassification = 'quota' | 'auth' | 'engine' | 'task';

// ─── Routing Configuration ────────────────────────────────────────────────────

export interface PromptRoutingEngineConfig {
  enabled: boolean;
  /** Higher priority wins ties in scoring. */
  priority: number;
}

export interface PromptRoutingConfig {
  /** Master feature flag. Default false — routing never runs unless explicitly enabled. */
  enabled: boolean;
  /** Scoring strategy. Only 'balanced' exists in v1. */
  strategy: 'balanced';
  /**
   * Whether a quota-classified failure mid-conversation may trigger an
   * automatic, one-time engine switch for a router-chosen session (v1.1 —
   * see docs/quota-aware-routing-plan.md). Does NOT affect start-time
   * routing: an engine already in cooldown/exhausted is excluded from
   * scoring at session-start regardless of this flag — that's just routing
   * with current information, not "falling back". A session whose engine
   * was explicitly pinned (by the caller, or resumed from a persisted
   * session) is never auto-switched, no matter this setting.
   */
  fallback: boolean;
  /** Safety margin (0..1) applied before a 'degraded' engine is treated as effectively unusable. */
  safetyMargin: number;
  /** Per-engine overrides. Engines absent from this map are treated as enabled with priority 0. */
  engines: Partial<Record<EngineType, PromptRoutingEngineConfig>>;
}

// ─── Routing Decision ─────────────────────────────────────────────────────────

export interface RouteCandidate {
  engine: EngineType;
  score: number;
  excluded?: string;
}

export interface RouteDecision {
  engine: EngineType;
  score: number;
  /** Human-readable trace of how the winning engine was chosen — powers --explain. */
  explain: string[];
  /** All candidates considered, including excluded ones, for transparency. */
  candidates: RouteCandidate[];
}

export interface RouteInput {
  /** User-supplied engine preference (soft — still scored, just weighted higher). */
  preferredEngine?: EngineType;
  /** Explicit engine override (hard — routing is skipped entirely). */
  explicitEngine?: EngineType;
}
