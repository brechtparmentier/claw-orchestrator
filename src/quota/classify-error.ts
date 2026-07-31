/**
 * Classifies a session start/send failure so the router knows whether it is
 * safe to fall back to a different engine.
 *
 * The default is always 'task' — an ordinary content/task failure never
 * triggers a fallback. Only messages that positively match a known
 * quota/auth/engine signal are classified otherwise. This asymmetry is
 * deliberate: the codebase has no typed error hierarchy (no RateLimitError,
 * QuotaError, ...) for any engine, so classification is necessarily
 * message-pattern-based, and a false 'task' (missed fallback) is far safer
 * than a false 'quota' (routing away from an engine over a content bug).
 */

import type { SessionStats } from '../types.js';
import type { ErrorClassification } from './quota-types.js';

const QUOTA_PATTERNS = [
  /rate.?limit/i,
  /too many requests/i,
  /\b429\b/,
  /quota exceeded/i,
  /usage limit/i,
  /\boverloaded\b/i,
];

const AUTH_PATTERNS = [/unauthorized/i, /\b401\b/, /\b403\b/, /invalid api key/i, /not authenticated/i, /forbidden/i];

const ENGINE_PATTERNS = [
  /ENOENT/,
  /command not found/i,
  /spawn.*failed/i,
  /ECONNREFUSED/,
  /engine .* circuit breaker open/i,
];

function matchesAny(message: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(message));
}

/**
 * Classify a failure from an engine session start/send attempt.
 *
 * @param err   The thrown/rejected error.
 * @param stats Optional session stats — Claude's `lastRetryError` (populated
 *              from the CLI's own `api_retry`/`rate_limit` stop_reason
 *              signal) is currently the only structured cross-check available;
 *              every other engine relies solely on message-pattern matching.
 */
export function classifyError(err: Error, stats?: Pick<SessionStats, 'lastRetryError'>): ErrorClassification {
  const message = err?.message || '';

  if (stats?.lastRetryError && /rate.?limit|overloaded/i.test(stats.lastRetryError)) {
    return 'quota';
  }
  if (matchesAny(message, QUOTA_PATTERNS)) return 'quota';
  if (matchesAny(message, AUTH_PATTERNS)) return 'auth';
  if (matchesAny(message, ENGINE_PATTERNS)) return 'engine';
  return 'task';
}
