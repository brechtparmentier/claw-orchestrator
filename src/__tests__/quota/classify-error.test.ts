/**
 * Unit tests for classifyError — the load-bearing gate that decides whether
 * a failure is allowed to influence routing (quota/auth/engine) or must be
 * left alone as an ordinary content failure (task).
 */

import { describe, it, expect } from 'vitest';
import { classifyError } from '../../quota/classify-error.js';

describe('classifyError', () => {
  it.each([
    ['rate limit exceeded, please retry later', 'quota'],
    ['Rate-limit hit', 'quota'],
    ['Too many requests', 'quota'],
    ['HTTP 429: slow down', 'quota'],
    ['quota exceeded for this billing period', 'quota'],
    ['usage limit reached', 'quota'],
    ['the model is currently overloaded', 'quota'],
  ] as const)('classifies %j as quota', (message, expected) => {
    expect(classifyError(new Error(message))).toBe(expected);
  });

  it.each([
    ['401 Unauthorized', 'auth'],
    ['403 Forbidden: access denied', 'auth'],
    ['invalid API key provided', 'auth'],
    ['not authenticated — please run login', 'auth'],
  ] as const)('classifies %j as auth', (message, expected) => {
    expect(classifyError(new Error(message))).toBe(expected);
  });

  it.each([
    ['spawn claude ENOENT', 'engine'],
    ['command not found: codex', 'engine'],
    ['ECONNREFUSED 127.0.0.1:1234', 'engine'],
    ["Engine 'codex' circuit breaker open after 3 consecutive failures. Retry in 30s.", 'engine'],
  ] as const)('classifies %j as engine', (message, expected) => {
    expect(classifyError(new Error(message))).toBe(expected);
  });

  it.each([
    ["cannot find module 'left-pad'"],
    ['TypeError: expected string, got undefined'],
    ['test suite failed: 3 assertions failed'],
    ['syntax error on line 42'],
    [''],
  ] as const)('defaults %j to task (no fallback)', (message) => {
    expect(classifyError(new Error(message))).toBe('task');
  });

  it('prefers the observed lastRetryError signal over message text when both are ambiguous', () => {
    const err = new Error('turn did not complete');
    expect(classifyError(err, { lastRetryError: 'rate_limit' })).toBe('quota');
  });

  it('an ordinary task error is unaffected by an unrelated lastRetryError field', () => {
    const err = new Error('assertion failed in generated code');
    expect(classifyError(err, { lastRetryError: undefined })).toBe('task');
  });
});
