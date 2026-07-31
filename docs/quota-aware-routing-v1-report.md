# Eindrapport — Quota-Aware Prompt Routing (v1)

> Statusrapport van de uitvoering van `startPrompt.md` Fase 1–7. Zoals
> `docs/quota-aware-routing-plan.md` en `docs/FORK_WORKFLOW.md` is dit
> bestand met `git add -f` toegevoegd — `docs/` is gitignored in deze fork
> ("local process scratch only, never shipped"), maar dit rapport is een
> bewust deliverable en blijft dus op de branch staan. Toekomstige edits aan
> dit bestand vereisen opnieuw `git add -f`.

## 1. Fork- en remotestatus

- `origin` → `brechtparmentier/claw-orchestrator` (fork), `upstream` →
  `Enderfga/claw-orchestrator`
- `remote.pushDefault=origin` (lokaal ingesteld, niet globaal)
- Branch `feat/quota-aware-routing-v1` gepusht naar `origin` — nooit naar
  upstream aangeraakt
- `main` stond bij aanvang al gelijk aan `upstream/main` (fork was net
  aangemaakt)

## 2. Baseline

- Commit `99b6c1f` (v4.10.1), Node v24.18.1, npm 11.16.0
- `build` / `lint` / `format:check` / `test` (887/887) allemaal groen vóór
  wijzigingen — geen bestaande fouten

## 3. Architectuurbevindingen (kern)

- Engine-keuze was 100% statisch: `fullConfig.engine || persisted?.engine ||
  'claude'` in `session-manager.ts:624` — geen scoring, geen fallback-logica
  bestond
- `CircuitBreaker` bestond al, maar bewaakt alleen spawn-falen bij
  `session.start()`, niet quota tijdens een lopend gesprek
- **Enige bestaande quota-signaal**: Claude's `api_retry`/
  `stop_reason==='rate_limit'` — de andere zes engines hebben nul
  rate-limit-parsing
- `gemini` is in deze fork legacy (vervangen door `agy`), maar de
  sessieklasse bestaat nog — v1 routeert generiek op `EngineType`, dus dit is
  geen blocker
- Geen YAML/config-bestand bestaat in dit project — config loopt via
  `PluginConfig` + `openclaw.plugin.json` configSchema + env vars
- Volledige architectuuranalyse: `docs/quota-aware-routing-plan.md`

## 4. Gewijzigde/nieuwe bestanden

21 bestanden, +2029/-6 regels, 4 commits op `feat/quota-aware-routing-v1`.

**Nieuw:**
`src/quota/{quota-types,classify-error,quota-manager,prompt-router}.ts`,
`src/__tests__/quota/*.test.ts` (4 bestanden),
`skills/references/prompt-routing.md`,
`docs/{quota-aware-routing-plan,FORK_WORKFLOW}.md`

**Gewijzigd:** `src/session-manager.ts`, `src/types.ts`, `src/constants.ts`,
`src/embedded-server.ts`, `bin/cli.ts`, `openclaw.plugin.json`,
`CHANGELOG.md`, `README.md`, `skills/SKILL.md`, `skills/references/cli.md`

## 5. Geïmplementeerde functionaliteit

- `QuotaManager` (in-memory, per-engine cooldown/reliability, configureerbare
  safety margin) + `classifyError` (quota/auth/engine/task, default `'task'`
  = geen fallback) + `PromptRouter` (deterministisch, `--explain`-trace,
  tiebreak priority → lexicaal)
- Achter feature flag `promptRouting.enabled` (default **false**) — routeert
  alleen als er geen expliciete én geen persisted engine aanwezig is
  (persisted sessies worden nooit gekaapt)
- `clawo route-explain` (CLI) + `POST /route/explain` (HTTP) —
  `--dry-run`/`--explain`-equivalent, start nooit een sessie, muteert nooit
  quota-/circuit-breaker-state
- Bereikbaar via zowel standalone `clawo serve` (env vars
  `CLAWO_PROMPT_ROUTING` / `CLAWO_PROMPT_ROUTING_CONFIG`) als de
  OpenClaw-plugin (`openclaw.plugin.json` configSchema). Alle
  `new SessionManager(...)`-constructiesites gecontroleerd — geen derde dood
  configpad (`ultraapp/fix-on-failure-session.ts` gebruikt altijd een
  expliciete engine, dus routing is daar sowieso niet van toepassing).

## 6. Testresultaten

**943/943 groen** (887 baseline + 56 nieuw), build/lint/format:check schoon.

| Fase 6 scenario | Test |
|---|---|
| alle engines beschikbaar | `prompt-router.test.ts` "picks the highest-priority healthy engine" |
| voorkeursengine bijna uitgeput | `prompt-router.test.ts` "a degraded (but not cooled-down) engine is still a candidate, just out-scored..." |
| engine in cooldown | `prompt-router.test.ts` "excludes an engine whose quota is in cooldown" |
| quota onbekend | `prompt-router.test.ts` "does NOT exclude an engine with unknown quota" |
| expliciet gekozen engine | `session-manager-routing.test.ts` "an explicit caller-supplied engine still bypasses routing" |
| fallback na gesimuleerde rate-limit | `session-manager-routing.test.ts` "fallback after a simulated quota failure" |
| geen fallback bij taakfout | `session-manager-routing.test.ts` "does NOT fall back after an ordinary task/content error" |
| deterministische keuze | `prompt-router.test.ts` "is deterministic" + `session-manager-routing.test.ts` "previewRoute() is deterministic" |
| bestaande werking zonder routing | `session-manager-routing.test.ts` "with promptRouting absent, resolves to claude exactly as before" + "PERSISTED session engine is resumed onto and never re-routed" |
| config met uitgeschakelde engine | `prompt-router.test.ts` + `session-manager-routing.test.ts` "an engine disabled via config is never chosen" |

Ook handmatig end-to-end geverifieerd tegen de echte gebouwde CLI (zie §8) —
niet alleen unit tests.

## 7. Resterende risico's en onbekenden

- `classifyError` is message-pattern-based voor 6 van de 7 engines (alleen
  Claude heeft een gestructureerd signaal) — een CLI-vendor die foutteksten
  wijzigt, degradeert stilzwijgend naar `'task'` (fail-safe: geen fallback,
  maar ook geen quota-detectie voor die engine)
- v1 routeert alleen bij sessie-start, niet per individuele prompt binnen een
  lopend gesprek (expliciet zo ontworpen, zie plan §4/§9 — mid-sessie
  fallback is v1.1)
- `gemini` is legacy in deze fork; dat is een upstream-beslissing, niet iets
  wat ik heb gewijzigd
- 14 pre-existing `npm audit`-kwetsbaarheden — niet door mij geïntroduceerd,
  niet aangepakt in deze fase
- `bin/mcp-server.ts` leest **geen enkel** config-veld uit env vars (niet
  alleen `promptRouting` niet) — bestaande beperking van dat entrypoint, geen
  nieuwe regressie

## 8. Exacte commando's om lokaal te testen

```bash
npm run build
OPENCLAW_SERVER_TOKEN=disabled CLAWO_PROMPT_ROUTING=1 node dist/bin/cli.js serve --port 18999 &
CLAWO_API_URL=http://127.0.0.1:18999 CLAWO_AUTH_TOKEN=disabled node dist/bin/cli.js route-explain --preferred-engine cursor
```

Echte output (zo gedraaid tijdens validatie):

```
Chosen engine: cursor (score=0.750)
Explain:
  - claude: score=0.450 (quota=unknown:0.75, reliability=1.00, preference=0.60, priority=100)
  - codex: score=0.443 (quota=unknown:0.75, reliability=1.00, preference=0.59, priority=90)
  - cursor: score=0.750 (quota=unknown:0.75, reliability=1.00, preference=1.00, priority=70)
  - gemini: score=0.435 (quota=unknown:0.75, reliability=1.00, preference=0.58, priority=80)
  - chosen: cursor (score=0.750)
```

Zonder `CLAWO_PROMPT_ROUTING=1` geeft `route-explain`:
`Failed: Quota-aware routing is disabled (...)` — bevestigt dat de default
ongewijzigd is.

## 9. Workflow om later `upstream/main` veilig binnen te halen

Zie `docs/FORK_WORKFLOW.md` (met `git add -f` toegevoegd aan de branch,
ondanks dat `docs/` gitignored is — vergeet die `-f` niet bij toekomstige
edits aan dat bestand of `quota-aware-routing-plan.md`). Kern:

```bash
git fetch upstream
git switch main && git merge --ff-only upstream/main && git push origin main
```

daarna de featurebranch opnieuw baseren op de bijgewerkte `main`.

`startPrompt.md` is bewust ongetrackt gelaten (persoonlijke werkinstructies,
geen forkinhoud).

## 10. Aanbeveling volgende stap

1. Open zelf een PR op je fork (naar eigen `main`, niet upstream) zodat je de
   diff in de GitHub-UI kan reviewen voor je verdergaat.
2. Test `route-explain` met een echte gesimuleerde rate-limit-run
   (`CLAWO_PROMPT_ROUTING_CONFIG` met een engine op lage prioriteit) tegen
   een van je eigen CLI's.
3. Volgende kleine fase (v1.1 uit het plan): mid-sessie fallback na een echte
   quota-fout tijdens `session-send`, in plaats van alleen bij de
   eerstvolgende nieuwe sessie.
