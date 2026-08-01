/**
 * Deterministic, explainable engine selection for quota-aware routing.
 *
 * v1 scope: routes at *session start* only. Per-send (mid-conversation)
 * rerouting is out of scope — see docs/quota-aware-routing-plan.md §4/§9 —
 * because engine is bound to a session's long-lived (or one-shot-per-send but
 * still session-scoped) subprocess; switching engines mid-session would mean
 * tearing down and restarting that subprocess, which is a larger change.
 */

import type { CircuitBreaker } from '../circuit-breaker.js';
import type { EngineType } from '../types.js';
import type { QuotaManager } from './quota-manager.js';
import type { PromptRoutingConfig, RouteCandidate, RouteDecision, RouteInput } from './quota-types.js';

/** Quota-state → score multiplier. Cooldown/exhausted are hard-excluded before this applies. */
function quotaHealthFactor(state: 'available' | 'degraded' | 'unknown', safetyMargin: number): number {
  switch (state) {
    case 'available':
      return 1;
    case 'degraded':
      return Math.max(0, 1 - safetyMargin);
    case 'unknown':
      // Explicitly NOT excluded — "unknown betekent niet automatisch onbruikbaar".
      return 0.75;
  }
}

export class PromptRouter {
  constructor(
    private config: PromptRoutingConfig,
    private quotaManager: QuotaManager,
    private circuitBreaker: CircuitBreaker,
  ) {}

  /**
   * Compute the best available engine for a new session. Never mutates state
   * (safe to call repeatedly for --dry-run/--explain) and never starts a
   * session itself — the caller decides what to do with the decision.
   */
  route(input: RouteInput = {}): RouteDecision {
    if (input.explicitEngine) {
      return {
        engine: input.explicitEngine,
        score: 1,
        explain: [`explicit engine override '${input.explicitEngine}' — routing skipped`],
        candidates: [{ engine: input.explicitEngine, score: 1 }],
      };
    }

    // Sorted for determinism — Object.keys() order on a Partial<Record<...>>
    // is insertion-order, not guaranteed stable across config-construction
    // paths, so we never rely on it directly.
    const engineNames = (Object.keys(this.config.engines) as EngineType[]).sort();

    const candidates: RouteCandidate[] = [];
    const explain: string[] = [];

    for (const engine of engineNames) {
      const engineCfg = this.config.engines[engine];
      if (!engineCfg?.enabled) {
        candidates.push({ engine, score: 0, excluded: 'disabled in config' });
        explain.push(`${engine}: excluded (disabled in config)`);
        continue;
      }

      let circuitOpen = false;
      try {
        this.circuitBreaker.check(engine);
      } catch {
        circuitOpen = true;
      }
      if (circuitOpen) {
        candidates.push({ engine, score: 0, excluded: 'circuit breaker open' });
        explain.push(`${engine}: excluded (circuit breaker open)`);
        continue;
      }

      const quota = this.quotaManager.getSnapshot(engine);
      if (quota.state === 'cooldown' || quota.state === 'exhausted') {
        const suffix = quota.reason ? ` (${quota.reason})` : '';
        candidates.push({ engine, score: 0, excluded: `quota ${quota.state}${suffix}` });
        explain.push(`${engine}: excluded (quota ${quota.state}${suffix})`);
        continue;
      }

      const safePriority = this._safePriority(engineCfg.priority);
      const quotaHealth = quotaHealthFactor(quota.state, this.config.safetyMargin);
      const reliability = this.quotaManager.getReliability(engine);
      const preference = input.preferredEngine === engine ? 1 : this._normalizedPriority(safePriority);
      const score = quotaHealth * reliability * preference;

      candidates.push({ engine, score });
      explain.push(
        `${engine}: score=${score.toFixed(3)} ` +
          `(quota=${quota.state}:${quotaHealth.toFixed(2)}, reliability=${reliability.toFixed(2)}, preference=${preference.toFixed(2)}, priority=${safePriority})`,
      );
    }

    const winner = this._pickWinner(candidates);
    if (!winner) {
      explain.push('no engine available — all candidates excluded or none configured');
      throw new Error(
        'PromptRouter: no engine available (all configured engines are disabled, in cooldown, exhausted, or circuit-open)',
      );
    }

    explain.push(`chosen: ${winner.engine} (score=${winner.score.toFixed(3)})`);
    return { engine: winner.engine, score: winner.score, explain, candidates };
  }

  /** Deterministic winner selection: highest score, tie-break by configured priority, then lexical engine name. */
  private _pickWinner(candidates: RouteCandidate[]): RouteCandidate | null {
    let best: RouteCandidate | null = null;
    for (const candidate of candidates) {
      if (candidate.excluded) continue;
      if (!best) {
        best = candidate;
        continue;
      }
      if (candidate.score > best.score) {
        best = candidate;
        continue;
      }
      if (candidate.score === best.score) {
        const bestPriority = this._safePriority(this.config.engines[best.engine]?.priority);
        const candidatePriority = this._safePriority(this.config.engines[candidate.engine]?.priority);
        if (candidatePriority > bestPriority) {
          best = candidate;
        }
        // else keep `best` — candidates are iterated in sorted (lexical) order,
        // so the first-seen engine on a full tie is already the lexical winner.
      }
    }
    return best;
  }

  private _normalizedPriority(priority: number): number {
    // Priorities in the example config run 0-100+; normalize into a soft
    // multiplier, capped strictly below 1 regardless of how high a priority
    // is configured. The cap matters: `preferredEngine` (a RouteInput-level,
    // per-call soft preference) scores exactly 1, and must always be able to
    // outweigh a merely high `priority` (a static, config-level preference) —
    // otherwise an engine with priority >= ~100 could tie or beat an
    // explicitly preferred engine on this factor alone.
    return Math.min(0.95, 0.5 + Math.max(0, priority) / 1000);
  }

  /**
   * `PromptRoutingEngineConfig.priority` is typed as a required `number`, but
   * runtime config (the CLAWO_PROMPT_ROUTING_CONFIG env var's raw JSON, or an
   * OpenClaw host config) is never actually type-checked — a config that
   * omits `priority`, or sets it to something non-numeric, would otherwise
   * turn `NaN` into the score and silently break winner selection
   * (NaN comparisons are always false, so a NaN-scored engine can never win
   * a tie and can corrupt the `explain` trace). Missing/invalid -> 0, the
   * same "no configured preference" value used elsewhere for an absent
   * engine entry.
   */
  private _safePriority(priority: number | undefined): number {
    return typeof priority === 'number' && Number.isFinite(priority) ? priority : 0;
  }
}
