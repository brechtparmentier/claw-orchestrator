# Quota-Aware Prompt Routing

Opt-in engine selection for new sessions based on quota health, recent
reliability, configured priority, and an optional per-call preference.
Disabled by default — with no `promptRouting` config (or
`promptRouting.enabled: false`), `session-start` resolves the engine exactly
as it always has: `engine` (if given) → the persisted session's engine (if
resuming) → `'claude'`.

A quota-classified failure mid-conversation can also trigger **one**
automatic engine switch (v1.1) — but only for a session whose engine the
router itself chose. An explicit `engine` on `session-start`, or a resumed
persisted session's engine, always takes precedence over routing — the
router never manages an engine it didn't pick, at start *or* mid-conversation.
This is the single governing rule for the whole feature: **the router only
ever manages engines it chose itself.**

## Mid-conversation fallback (v1.1)

When `promptRouting.fallback: true` (see config below) and a `session-send`
call fails with a `'quota'`-classified error on a router-chosen session,
`sendMessage` will:

1. Record the failure (as always — this also happens with `fallback: false`,
   it just teaches *future* session-starts to avoid the engine).
2. Re-run routing, excluding the just-failed engine (it's now in cooldown).
3. Stop the current session and start a **new** session under the same name
   on the newly routed engine — **no conversation context is transferred**;
   there is no cross-engine way to carry over history, so the new session
   starts fresh. Engine-specific config (`model`, `resolvedModel`, `baseUrl`,
   resume IDs, ...) is dropped; engine-agnostic settings (`cwd`,
   `permissionMode`, `maxTurns`, `systemPrompt`, ...) are carried over.
4. Retry the failed message once on the new session.

The result's `engineSwitched: { from, to, reason }` field is set when this
happens, so callers can surface "this conversation lost context, engine
switched from X to Y" to the user.

**At most one automatic switch per session.** The fallback session is
started with an explicit `engine`, so it is never itself router-chosen —
if it also fails, that failure just propagates (no cascading engine-hopping).
If no fallback engine is available, or the fallback also fails, the
**original** error is what the caller sees (with the fallback attempt's
detail appended) — never a routing-plumbing error in its place.

## Enabling it

Add a `promptRouting` block to the plugin config (`PluginConfig` in
`src/types.ts`):

```jsonc
{
  "promptRouting": {
    "enabled": true,
    "strategy": "balanced",
    "fallback": true,
    "safetyMargin": 0.15,
    "engines": {
      "claude": { "enabled": true, "priority": 100 },
      "codex": { "enabled": true, "priority": 90 },
      "gemini": { "enabled": true, "priority": 80 },
      "cursor": { "enabled": true, "priority": 70 }
    }
  }
}
```

- `engines` is keyed by `EngineType` — any engine (including `agy`,
  `opencode`, `custom`) can be added; engines absent from the map are treated
  as excluded from routing (not as "enabled with default priority").
- `priority` only affects tie-breaking between healthy candidates — higher
  wins.
- `safetyMargin` (0–1) controls how much recent-reliability drop is tolerated
  before an engine is scored as `degraded` rather than `available`.
- `fallback` gates the mid-conversation switch described above — **only**
  that. It has no effect on start-time routing: an engine already in
  cooldown/exhausted is excluded from scoring at session-start regardless of
  this setting (that's just routing with current information, not a
  "fallback").

## How an engine is chosen

For each enabled, non-excluded engine:

```
score = quotaHealth × reliability × preference
```

- **`quotaHealth`** — `available` = 1, `degraded` = `1 - safetyMargin`,
  `unknown` = 0.75 (unknown quota is *not* treated as unusable).
  `cooldown`/`exhausted` engines are excluded outright, not merely
  down-scored.
- **`reliability`** — success ratio over the engine's recent outcomes
  (ordinary task/content failures count as successes here — they say
  nothing about engine health).
- **`preference`** — 1 if this engine matches `preferredEngine` for the
  call, otherwise a normalized, capped version of its configured `priority`.

Ties are broken by configured `priority`, then lexically by engine name — the
same input always produces the same decision.

An engine is also excluded if its circuit breaker is open (see
[Sessions](./sessions.md) / `src/circuit-breaker.ts`) — that mechanism is
unchanged and consulted alongside quota state, not replaced by it.

## Previewing a decision (`--dry-run` / `--explain`)

Previewing never starts a session and never mutates quota or circuit-breaker
state:

```bash
clawo route-explain --preferred-engine cursor
```

```
Chosen engine: claude (score=0.600)
Explain:
  - claude: score=0.600 (quota=available:1.00, reliability=1.00, preference=0.60, priority=100)
  - codex: score=0.443 (quota=unknown:0.75, reliability=1.00, preference=0.59, priority=90)
  - chosen: claude (score=0.600)
```

Or via HTTP: `POST /route/explain` with an optional `{ "preferredEngine": "..." }`
body. Both return the same `RouteDecision` shape (`engine`, `score`,
`explain`, `candidates`).

## What counts as a quota failure

`classifyError` (`src/quota/classify-error.ts`) classifies a start/send
failure as `'quota' | 'auth' | 'engine' | 'task'`, defaulting to `'task'`
(no effect on routing) unless a message pattern or, for Claude, the CLI's own
`api_retry`/`stop_reason` signal positively indicates otherwise. Only
`'quota'` opens a cooldown; `'auth'` marks an engine exhausted until its next
success; `'engine'` (spawn/CLI failures) is left to the circuit breaker;
`'task'` never affects quota state. This asymmetry is deliberate — an
ordinary content bug in generated code must never cause a fallback to a
different engine.

Today only the Claude adapter surfaces a structured rate-limit signal; every
other engine relies on message-pattern matching against `Error.message`. See
`docs/quota-aware-routing-plan.md` for the full design rationale and planned
follow-up phases (`docs/` is gitignored in this repo as local scratch, but
that specific file was force-added to persist on this branch).
