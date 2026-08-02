/**
 * Shared types for quota-aware prompt routing.
 */

import {
  DEFAULT_CODEX_RATE_LIMIT_TIMEOUT_MS,
  DEFAULT_CODEX_RATE_LIMIT_TTL_MS,
  DEFAULT_ROUTING_SAFETY_MARGIN,
} from '../constants.js';
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

export interface CodexRateLimitsConfig {
  /** Hard upper bound for initialize + account/rateLimits/read. */
  timeoutMs: number;
  /** Cache duration for successful and unknown snapshots. */
  ttlMs: number;
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
  /** Routing candidates. Engines absent from this map are excluded. */
  engines: Partial<Record<EngineType, PromptRoutingEngineConfig>>;
  /** Official Codex App Server account quota reader settings. */
  codexRateLimits?: CodexRateLimitsConfig;
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

/**
 * Fill in every missing field with its documented default. Runtime config
 * (the CLAWO_PROMPT_ROUTING_CONFIG env var's raw JSON, or an OpenClaw host
 * config) is never actually type-checked against `PromptRoutingConfig` —
 * a partial object like `{ enabled: true }` would otherwise reach
 * `PromptRouter`/`QuotaManager` with `engines`/`safetyMargin` `undefined`,
 * which crashes `Object.keys(undefined)` in `PromptRouter.route()` and
 * produces `NaN` scores. Always run config through this before using it.
 */
export function normalizePromptRoutingConfig(input: Partial<PromptRoutingConfig> | undefined): PromptRoutingConfig {
  const rawSafetyMargin = input?.safetyMargin;
  // Clamped to [0, 1], not just "finite" — an out-of-range value (e.g. a
  // negative margin) would otherwise let a 'degraded' engine outscore an
  // 'available' one in quotaHealthFactor's `1 - safetyMargin`, inverting the
  // scoring semantics instead of just producing a slightly-off number.
  const safetyMargin =
    typeof rawSafetyMargin === 'number' && Number.isFinite(rawSafetyMargin)
      ? Math.min(1, Math.max(0, rawSafetyMargin))
      : DEFAULT_ROUTING_SAFETY_MARGIN;
  return {
    enabled: input?.enabled ?? false,
    strategy: input?.strategy ?? 'balanced',
    fallback: input?.fallback ?? false,
    safetyMargin,
    engines: input?.engines ?? {},
    codexRateLimits: {
      timeoutMs: positiveFiniteOrDefault(input?.codexRateLimits?.timeoutMs, DEFAULT_CODEX_RATE_LIMIT_TIMEOUT_MS),
      ttlMs: positiveFiniteOrDefault(input?.codexRateLimits?.ttlMs, DEFAULT_CODEX_RATE_LIMIT_TTL_MS),
    },
  };
}

function positiveFiniteOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
