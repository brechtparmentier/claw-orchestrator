/**
 * Read-only Codex quota provider backed by the official App Server method
 * `account/rateLimits/read`.
 */

import { CodexAppServerTransport } from '../codex-app-server-transport.js';
import type { Logger } from '../logger.js';
import type { QuotaSnapshot } from './quota-types.js';

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}

export interface CodexRateLimitBucket {
  limitId: string;
  limitName?: string | null;
  primary: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow | null;
  rateLimitReachedType?: string | null;
  planType?: string | null;
  credits?: unknown;
}

export interface CodexRateLimitsReadResponse {
  /** Backward-compatible single-bucket view. */
  rateLimits?: CodexRateLimitBucket | null;
  /** Current multi-bucket view, keyed by metered limit id. */
  rateLimitsByLimitId?: Record<string, CodexRateLimitBucket> | null;
  planType?: string | null;
}

export interface CodexRateLimitsReader {
  readRateLimits(): Promise<unknown>;
  stop?(): void;
}

export interface CodexRateLimitsProviderOptions {
  timeoutMs: number;
  ttlMs: number;
  safetyMargin: number;
  clock?: () => number;
  logger?: Pick<Logger, 'debug' | 'warn'>;
}

interface ValidWindow extends CodexRateLimitWindow {
  bucketReached: boolean;
}

/**
 * One lazy, long-lived App Server connection. It initializes the protocol but
 * intentionally never starts a thread or turn and exposes no mutating method.
 */
export class CodexAppServerRateLimitsReader implements CodexRateLimitsReader {
  private transport: CodexAppServerTransport | null = null;
  private initialized: Promise<void> | null = null;

  constructor(private readonly codexBin?: string) {}

  async readRateLimits(): Promise<CodexRateLimitsReadResponse> {
    await this.ensureInitialized();
    return (await this.transport!.request('account/rateLimits/read')) as CodexRateLimitsReadResponse;
  }

  stop(): void {
    this.transport?.stop();
    this.transport = null;
    this.initialized = null;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return this.initialized;

    const transport = new CodexAppServerTransport({
      codexBin: this.codexBin,
      onExit: () => {
        if (this.transport === transport) {
          this.transport = null;
          this.initialized = null;
        }
      },
    });
    // The request promise is the consumer-facing error path.
    transport.on('error', () => undefined);
    transport.start();
    this.transport = transport;
    this.initialized = transport
      .request('initialize', {
        clientInfo: { name: 'claw-orchestrator-quota', title: null, version: '1.2' },
      })
      .then(() => undefined);

    try {
      await this.initialized;
    } catch (error) {
      this.stop();
      throw error;
    }
  }
}

export class CodexRateLimitsProvider {
  private readonly clock: () => number;
  private cached: { snapshot: QuotaSnapshot; expiresAt: number } | null = null;
  private inFlight: Promise<QuotaSnapshot> | null = null;

  constructor(
    private readonly reader: CodexRateLimitsReader,
    private readonly options: CodexRateLimitsProviderOptions,
  ) {
    this.clock = options.clock ?? Date.now;
  }

  async getSnapshot(): Promise<QuotaSnapshot> {
    const now = this.clock();
    if (this.cached && this.cached.expiresAt > now) return this.cached.snapshot;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.readFresh();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  stop(): void {
    this.reader.stop?.();
  }

  private async readFresh(): Promise<QuotaSnapshot> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        this.reader.readRateLimits(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), this.options.timeoutMs);
        }),
      ]);
      const snapshot = mapCodexRateLimitsResponse(response, this.options.safetyMargin, this.clock());
      this.cache(snapshot);
      return snapshot;
    } catch (error) {
      // A timed-out request remains pending at transport level, so reset the
      // connection. The next cache miss gets a clean process and request map.
      this.reader.stop?.();
      const failureKind = error instanceof Error && error.message === 'timeout' ? 'timed out' : 'unavailable';
      this.options.logger?.warn(`[CodexQuota] official rate-limit read ${failureKind}; using unknown quota state`);
      const snapshot = unknownSnapshot(this.clock());
      this.cache(snapshot);
      return snapshot;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private cache(snapshot: QuotaSnapshot): void {
    this.cached = { snapshot, expiresAt: this.clock() + this.options.ttlMs };
  }
}

export function mapCodexRateLimitsResponse(response: unknown, safetyMargin: number, now: number): QuotaSnapshot {
  const root = asRecord(response);
  if (!root) return unknownSnapshot(now);

  const multi = asRecord(root.rateLimitsByLimitId);
  let rawBuckets: unknown[];
  if (multi && Object.keys(multi).length > 0) {
    rawBuckets = Object.values(multi);
  } else if (root.rateLimits !== undefined && root.rateLimits !== null) {
    rawBuckets = [root.rateLimits];
  } else {
    return unknownSnapshot(now);
  }

  const windows: ValidWindow[] = [];
  for (const rawBucket of rawBuckets) {
    const bucket = asRecord(rawBucket);
    if (!bucket || typeof bucket.limitId !== 'string' || bucket.limitId.length === 0) {
      return unknownSnapshot(now);
    }

    const reachedType = bucket.rateLimitReachedType;
    if (reachedType !== undefined && reachedType !== null && typeof reachedType !== 'string') {
      return unknownSnapshot(now);
    }
    const bucketReached = typeof reachedType === 'string' && reachedType.length > 0;
    const primary = parseWindow(bucket.primary, bucketReached);
    if (!primary) return unknownSnapshot(now);
    windows.push(primary);

    if (bucket.secondary !== undefined && bucket.secondary !== null) {
      const secondary = parseWindow(bucket.secondary, bucketReached);
      if (!secondary) return unknownSnapshot(now);
      windows.push(secondary);
    }
  }

  if (windows.length === 0) return unknownSnapshot(now);
  const observedAt = new Date(now).toISOString();
  const reached = windows.filter((window) => window.bucketReached || window.usedPercent >= 100);
  if (reached.length > 0) {
    const futureResets = reached.map((window) => window.resetsAt * 1000).filter((reset) => reset > now);
    const resetAtMs = futureResets.length > 0 ? Math.max(...futureResets) : undefined;
    return {
      state: resetAtMs ? 'cooldown' : 'exhausted',
      reason: 'official Codex account rate limit reached',
      resetAt: resetAtMs ? new Date(resetAtMs).toISOString() : undefined,
      observedAt,
    };
  }

  const strictest = windows.reduce((worst, window) => (window.usedPercent > worst.usedPercent ? window : worst));
  const threshold = (1 - Math.min(1, Math.max(0, safetyMargin))) * 100;
  if (strictest.usedPercent >= threshold) {
    const resetAtMs = strictest.resetsAt * 1000;
    return {
      state: 'degraded',
      reason: `official Codex quota ${Math.round(strictest.usedPercent)}% used`,
      resetAt: resetAtMs > now ? new Date(resetAtMs).toISOString() : undefined,
      observedAt,
    };
  }

  return { state: 'available', observedAt };
}

function parseWindow(value: unknown, bucketReached: boolean): ValidWindow | null {
  const window = asRecord(value);
  if (!window) return null;
  const { usedPercent, windowDurationMins, resetsAt } = window;
  if (
    typeof usedPercent !== 'number' ||
    !Number.isFinite(usedPercent) ||
    usedPercent < 0 ||
    typeof windowDurationMins !== 'number' ||
    !Number.isFinite(windowDurationMins) ||
    windowDurationMins <= 0 ||
    typeof resetsAt !== 'number' ||
    !Number.isFinite(resetsAt) ||
    resetsAt <= 0
  ) {
    return null;
  }
  return { usedPercent, windowDurationMins, resetsAt, bucketReached };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unknownSnapshot(now: number): QuotaSnapshot {
  return { state: 'unknown', observedAt: new Date(now).toISOString() };
}
