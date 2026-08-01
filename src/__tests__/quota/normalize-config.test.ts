/**
 * Unit tests for normalizePromptRoutingConfig — runtime JSON config (env var,
 * OpenClaw host config) is never type-checked against PromptRoutingConfig,
 * so a partial object must never crash downstream consumers.
 */

import { describe, it, expect } from 'vitest';
import { normalizePromptRoutingConfig } from '../../quota/quota-types.js';
import { DEFAULT_ROUTING_SAFETY_MARGIN } from '../../constants.js';

describe('normalizePromptRoutingConfig', () => {
  it('fills in every default when given undefined', () => {
    expect(normalizePromptRoutingConfig(undefined)).toEqual({
      enabled: false,
      strategy: 'balanced',
      fallback: false,
      safetyMargin: DEFAULT_ROUTING_SAFETY_MARGIN,
      engines: {},
    });
  });

  it('fills in missing sub-fields when only `enabled` is provided', () => {
    // This is exactly the shape a hand-written CLAWO_PROMPT_ROUTING_CONFIG
    // JSON blob could have — `engines` missing entirely.
    const result = normalizePromptRoutingConfig({ enabled: true });
    expect(result.engines).toEqual({});
    expect(result.safetyMargin).toBe(DEFAULT_ROUTING_SAFETY_MARGIN);
    expect(result.fallback).toBe(false);
    expect(result.strategy).toBe('balanced');
    expect(result.enabled).toBe(true);
  });

  it('preserves explicitly provided fields', () => {
    const result = normalizePromptRoutingConfig({
      enabled: true,
      fallback: true,
      safetyMargin: 0.3,
      engines: { claude: { enabled: true, priority: 100 } },
    });
    expect(result).toEqual({
      enabled: true,
      strategy: 'balanced',
      fallback: true,
      safetyMargin: 0.3,
      engines: { claude: { enabled: true, priority: 100 } },
    });
  });

  it('falls back to the default for a non-finite safetyMargin', () => {
    expect(normalizePromptRoutingConfig({ safetyMargin: NaN }).safetyMargin).toBe(DEFAULT_ROUTING_SAFETY_MARGIN);
    expect(normalizePromptRoutingConfig({ safetyMargin: Infinity }).safetyMargin).toBe(DEFAULT_ROUTING_SAFETY_MARGIN);
  });

  it('clamps an out-of-range safetyMargin to [0, 1] instead of inverting scoring semantics', () => {
    expect(normalizePromptRoutingConfig({ safetyMargin: -0.5 }).safetyMargin).toBe(0);
    expect(normalizePromptRoutingConfig({ safetyMargin: 5 }).safetyMargin).toBe(1);
  });
});
