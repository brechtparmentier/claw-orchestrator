# Quota-aware prompt routing — architectuurplan

> Planningsdocument. `docs/` staat in `.gitignore` van deze fork ("All
> documentation lives under skills/. [...] docs/ is for local process scratch
> only and never shipped"), dus dit bestand wordt normaal nooit meegenomen
> door `git add -A` of getoond in `git status`. Het is hier bewust met
> `git add -f` toegevoegd zodat het op de fork/branch blijft staan als
> naslagwerk (zie Fase 7 van startPrompt.md). Feature-documentatie voor de
> router zelf staat in `skills/references/prompt-routing.md`, conform de
> conventie in `CLAUDE.md`.

Baseline: commit `99b6c1f` (v4.10.1), Node v24.18.1 / npm 11.16.0. Build, lint,
format:check en `npm run test` (887/887) zijn allemaal groen zonder wijzigingen.

## 1. Huidige relevante architectuur

### Sessions en engines

- `ISession` (`src/types.ts:452-493`) is de engine-agnostische interface:
  lifecycle (`start/stop/pause/resume`), communicatie (`send`), observability
  (`getStats/getHistory/getCost`), context (`compact/getEffort/setEffort`),
  model (`resolveModel`), plus een EventEmitter-oppervlak.
- Zeven engine-adapters implementeren `ISession`:
  - **Persistent** (één lang levend subprocess): `PersistentClaudeSession`
    (`src/persistent-session.ts`), `PersistentCodexAppServerSession`
    (`src/persistent-codex-app-session.ts`).
  - **One-shot** (nieuw process per `send()`), via de gedeelde abstracte
    basisklasse `BaseOneShotSession` (`src/base-oneshot-session.ts`):
    `PersistentCodexSession`, `PersistentGeminiSession`,
    `PersistentAgySession`, `PersistentCursorSession`,
    `PersistentOpencodeSession`.
  - `PersistentCustomSession` kan beide zijn, runtime bepaald door
    `CustomEngineConfig.persistent`.
- `EngineType` (`src/types.ts:40`) = `'claude' | 'codex' | 'codex-app' |
  'gemini' | 'agy' | 'cursor' | 'opencode' | 'custom'`.

### Engine-keuze vandaag: 100% statisch

`SessionManager._doStartSession()` bepaalt de engine met een simpele
precedentieketen, **geen scoring, geen beschikbaarheidscheck**:

```ts
// src/session-manager.ts:624-628
const engine: EngineType = fullConfig.engine || persisted?.engine || 'claude';
fullConfig.engine = engine;
```

Direct daarna: `this._circuitBreaker.check(engine)` (`:631`), dan
`this._createSession(engine, fullConfig)` (`:641`) — een switch-statement
(`:2019-2040`) die de concrete adapterklasse instantieert. Dit is de enige
plek waar "welke klasse" wordt beslist.

`sendMessage()` (`:682-774`) roept `managed.session.send(...)` precies één
keer aan (`:748`). **Er bestaat vandaag geen retry- of
fallback-naar-andere-engine-logica** — een gefaalde turn propageert gewoon als
error naar de caller.

### CircuitBreaker (`src/circuit-breaker.ts`)

Bestaat al en is generiek per engine (`Map<string, BreakerState>`),
exponentiële backoff (constants in `src/constants.ts:104-110`:
`CIRCUIT_BREAKER_THRESHOLD=3`, `BACKOFF_BASE_MS=1000`, `MAX_BACKOFF_MS=300000`,
`MAX_COUNT=10`). Maar: **hij wordt uitsluitend rond `session.start()`
gebruikt** — `check()` vóór het aanmaken van de session, `recordFailure()`
als `start()` faalt, `reset()` als `start()` slaagt. Hij ziet dus alleen
spawn-/authenticatiefouten bij het *starten* van een sessie, nooit een
quota-fout die halverwege een gesprek optreedt. Hij onderscheidt ook geen
foutsoorten — elke `start()`-fout telt hetzelfde.

Autoloop (`src/autoloop/dispatcher.ts:195/200/205`) kent wel per-rol
engine-toewijzing (planner/coder/reviewer), maar dat is **statische
gebruikersconfiguratie**, geen dynamische quota-routing, en engine wisselen
ná sessiestart is er expliciet verboden (`dispatcher.ts:407-410`).

### Foutclassificatie: de echte lacune

Er bestaat **geen typed error-hiërarchie** (geen `RateLimitError`,
`QuotaError`, `AuthError`, …) nergens in de codebase. Foutsignalen komen op
drie manieren binnen, en zijn nu alleen bij Claude bruikbaar:

```ts
// src/persistent-session.ts:451-456 — Claude CLI's eigen api_retry event
} else if (event.subtype === 'api_retry') {
  this.stats.retries++;
  this.stats.lastRetryError = (event.error_category as string) || String(event.error_status || 'unknown');
}
```

```ts
// src/persistent-session.ts:582-585 — stop_reason op het finale result-event
const stopReason = event.stop_reason;
if (stopReason === 'error' || stopReason === 'rate_limit') {
  this._fireHook('onStopFailure', { reason: stopReason, error: event.error });
}
```

Dit is passieve bookkeeping (`SessionStats.retries`/`lastRetryError`) of een
door de gebruiker geconfigureerde shell-hook — niets leest dit vandaag om een
failover te triggeren. **Codex, Gemini, Cursor, Agy, OpenCode hebben nul
rate-limit/quota-parsing** (geverifieerd via grep op alle adapters voor
`rate.limit|quota|429|cooldown|exhaust|overloaded|retry`).

### Configuratie

Geen YAML, nergens (geen dependency, geen `.yml`/`.yaml`-bestanden). Config is
laagsgewijs JSON/TS:

1. `openclaw.plugin.json` → `configSchema` (JSON Schema voor de OpenClaw-host).
2. `PluginConfig`-interface (`src/types.ts:497-507`) — bevat al optionele
   geneste config-objecten (`proxy?`, `pricingOverrides?`) — dit is het
   bestaande patroon om op aan te sluiten.
3. `src/index.ts:132-148` geeft `api.pluginConfig` één-op-één door aan
   `new SessionManager(rawConfig)`.
4. `bin/cli.ts` — Commander-flags + env vars (`CLAWO_API_URL`,
   `OPENCLAW_SERVE_MAX_SESSIONS`, …).
5. Per-engine binary-overrides via flat env vars: `GEMINI_BIN`, `AGY_BIN`,
   `CODEX_BIN`, `CURSOR_BIN`, `OPENCODE_BIN`, plus `CustomEngineConfig.binEnv`.

Er bestaat **geen per-engine `enabled`/`priority`-structuur** vandaag —
engines zijn alleen adressable via de `EngineType`-string.

### Teststrategie die al bestaat

`src/__tests__/circuit-breaker.test.ts` en `session-manager.test.ts` gebruiken
een `MockSession extends EventEmitter implements ISession`, geïnjecteerd door
`_createSession` te monkey-patchen op de manager-instance:

```ts
(manager as any)._createSession = (_engine, _config): ISession =>
  failNext ? new FailingSession() : new MockSession();
```

`FailingSession extends MockSession` met een overridende `start()` die gooit.
Dit is exact het patroon voor router-tests: varianten van `MockSession` die
quota-exhausted/cooldown/gezond simuleren. `node:fs` wordt globaal gemocked
(`vi.mock('node:fs', ...)`) om de echte `~/.openclaw/*.json`-bestanden niet
aan te raken.

## 2. Gevonden extensiepunten

| Extensiepunt | Locatie | Gebruik |
|---|---|---|
| Engine-resolutie | `src/session-manager.ts:624-628` | Hier de routingbeslissing invoegen, vóór `_createSession` |
| `_createSession` switch | `src/session-manager.ts:2019-2040` | Ongewijzigd laten — router beslist alleen *welke* `EngineType* wordt doorgegeven |
| `PluginConfig` | `src/types.ts:497-507` | Nieuw optioneel veld `promptRouting?: PromptRoutingConfig`, zelfde patroon als `proxy`/`pricingOverrides` |
| `CircuitBreaker` | `src/circuit-breaker.ts` | Blijft ongewijzigd verantwoordelijk voor start-faalbescherming; `QuotaManager` is complementair, niet vervangend |
| `SessionStats.retries/lastRetryError` | `src/types.ts:304-306`, alleen Claude | Eerste, enige vandaag beschikbare geobserveerde quota-hint |
| CLI (`bin/cli.ts`) → HTTP → `embedded-server.ts:389-391` → `manager.startSession` | — | `--dry-run`/`--explain` moet door deze hele keten heen (CLI-flag → HTTP body → server route → SessionManager) |
| Testpatroon `_createSession` monkey-patch | `src/__tests__/circuit-breaker.test.ts` | Hergebruiken voor `PromptRouter`-tests |

## 3. Verschillen tussen de engines (relevant voor routing)

| Engine | Stijl | Rate-limit/quota-signaal vandaag | Cached tokens |
|---|---|---|---|
| `claude` | persistent | Ja — `api_retry`/`stop_reason==='rate_limit'` (enige engine met signaal) | ja |
| `codex` | one-shot (ondanks de naam "Persistent...") | Geen | nee |
| `gemini` | one-shot, **legacy** (README/CLAUDE.md: "sunset, superseded by Antigravity"; niet gedocumenteerd, niet version-tracked) maar klasse bestaat en werkt nog | Geen | ja |
| `agy` (Antigravity) | one-shot | Geen | ja |
| `cursor` | one-shot | Geen | ja |
| `opencode` | one-shot | Geen | ja |
| `custom` | beide, runtime-config | Geen (per-CLI, gebruiker-specifiek) | user-defined |

Belangrijk: de opdracht vraagt routing voor Claude, Codex, **Gemini**, Cursor.
`gemini` is in deze fork een niet-gedocumenteerde, niet version-getrackte
legacy-optie (vervangen door `agy`) — maar de sessieklasse
(`PersistentGeminiSession`) bestaat en is functioneel identiek aan de andere
one-shot-engines qua interface. Om geen positie in te nemen over upstreams
deprecation-beslissing, ontwerpen we de router **generiek op `EngineType`**
(dus inclusief `agy`/`opencode`/`custom`) in plaats van vier hardcoded namen.
`engines.<naam>.enabled` in de config bepaalt welke engines meedoen — Claude,
Codex, Gemini, Cursor aan (zoals gevraagd), Agy/OpenCode desgewenst uit. Dat
lost de "vier vs. zeven" spanning zonder architecturale keuze op.

## 4. Risico's en onbekenden

1. **Per-prompt vs. per-sessie routing.** De opdracht vraagt "quota-aware
   **prompt** routing", maar in deze architectuur wordt de engine één keer
   gekozen bij `startSession` (`:624`) en blijft die vast voor de levensduur
   van de sessie/subprocess (`sendMessage` verstuurt naar een sessie wiens
   engine al vastligt). Per-`send()` herroutering zou een lopend subprocess
   moeten afbreken en een nieuwe engine-sessie moeten starten — dat is een
   grote wijziging en buiten scope voor v1. **Besluit: v1 routeert bij
   sessiestart** (elke nieuwe `session_start`/CLI-`session-start` roept de
   router aan als geen expliciete engine is opgegeven). Mid-sessie
   herroutering na een quota-fout is een expliciet benoemde latere fase
   (zie §9).
2. **Foutclassificatie is de kern van de kwaliteit, niet de scorer.** Zonder
   betrouwbare `classifyError()` valt fallback-only-bij-quota-fout uit
   elkaar. Vandaag heeft alleen Claude een signaal; de andere zes engines
   hebben er nul. Eerlijke v1-aanpak: Claude krijgt een
   observed-error-`QuotaProvider` (leest `stats.lastRetryError`/
   `stop_reason`); de overige engines krijgen alleen handmatig geconfigureerde
   quota / `unknown`-status. Dat is expliciet toegestaan door de opdracht
   ("`unknown` betekent niet automatisch onbruikbaar").
3. **Determinisme.** "Deterministische keuze bij gelijke input" betekent: geen
   `Date.now()`/`Math.random()` in de scorer zelf (een geïnjecteerde `now`
   parameter i.p.v. wall-clock reads), sortering van engine-namen vóór het
   itereren (niet `Object.keys()`-volgorde, die niet gegarandeerd stabiel is),
   en een expliciete tiebreak (priority, dan alfabetisch op enginenaam).
4. **Geen typed errors bestaan.** `classifyError` moet werken op basis van
   `Error.message`-patronen en (waar aanwezig) `SessionStats`-velden — fragiel
   per definitie. Mitigatie: default naar `'task'` (geen fallback) tenzij een
   signaal expliciet quota/auth/engine aanduidt. Dit is ook precies wat de
   test "geen fallback bij gewone taakfout" moet afdwingen.
5. **CircuitBreaker blijft ongemoeid.** We introduceren `QuotaManager` naast
   de bestaande `CircuitBreaker` in plaats van hem te vervangen — ze bewaken
   verschillende dingen (spawn-falen vs. quota-gezondheid). Risico: twee
   parallelle "is engine X bruikbaar"-mechanismen die uit sync kunnen raken.
   Mitigatie: `PromptRouter` respecteert beide (sluit een engine uit als
   `CircuitBreaker` open staat ÓF `QuotaManager` "cooldown"/"exhausted"
   rapporteert).
6. **`gemini` is legacy** — zie §3. Geen blocker, wel te vermelden bij het
   eindrapport.
7. **HTTP-tussenlaag.** `bin/cli.ts` praat met `SessionManager` uitsluitend via
   HTTP (`embedded-server.ts`), niet in-process. `--dry-run`/`--explain` moet
   dus door de hele keten (CLI-optie → request body → server-route →
   SessionManager-methode) i.p.v. alleen een in-process functieparameter.

## 5. Voorgestelde componenten

### `QuotaProvider` (interface, per engine)

```ts
// src/quota/quota-provider.ts
export type QuotaState = 'available' | 'degraded' | 'cooldown' | 'exhausted' | 'unknown';

export interface QuotaSnapshot {
  state: QuotaState;
  reason?: string;
  resetAt?: string;       // ISO timestamp, indien bekend
  observedAt: string;     // ISO timestamp van deze meting
}

export interface QuotaProvider {
  readonly engine: EngineType;
  getSnapshot(now: number): QuotaSnapshot;
  /** Voedt de provider met een classificatiesignaal van een echte send/start. */
  recordOutcome(outcome: EngineOutcome, now: number): void;
}
```

Databronnen, in volgorde van betrouwbaarheid (zoals gevraagd):
1. Machineleesbaar CLI-commando indien beschikbaar (nog geen van de zes CLI's
   biedt dit vandaag — niet in v1, wel als extensiepunt in de interface).
2. Waargenomen rate-limit-fouten (`classifyError` output + Claude's
   `lastRetryError`/`stop_reason`).
3. Lokaal bijgehouden verbruik (call-telling, simpel budget-model).
4. Gebruikersbudgetten uit config (`safetyMargin`, `priority`).
5. Fallback `unknown`.

Géén scraping van interactieve terminalschermen (expliciet uitgesloten).

### `QuotaManager`

```ts
// src/quota/quota-manager.ts
export class QuotaManager {
  constructor(private providers: Map<EngineType, QuotaProvider>, private clock: () => number = Date.now) {}
  getStatus(engine: EngineType): QuotaSnapshot;
  recordSuccess(engine: EngineType): void;
  recordFailure(engine: EngineType, classification: ErrorClassification): void;
  getAllStatuses(): Record<string, QuotaSnapshot>;
}
```

Verantwoordelijk voor status per engine, rolling usage, cooldowns,
resetmomenten, laatste succes/fout, configureerbare `safetyMargin`, en
persistente lokale status (JSON-bestand in dezelfde stijl als
`~/.openclaw/*.json`, **zonder credentials** — alleen tellers/timestamps).
Volgt hetzelfde `Map<EngineType, State>`-patroon als `CircuitBreaker`.

### `classifyError` (het kritieke onderdeel, zie risico 2 en 4)

```ts
// src/quota/classify-error.ts
export type ErrorClassification = 'quota' | 'auth' | 'engine' | 'task';

export function classifyError(err: Error, stats?: Partial<SessionStats>): ErrorClassification {
  // Claude: expliciet signaal
  if (stats?.lastRetryError === 'rate_limit' || /rate.?limit/i.test(err.message)) return 'quota';
  if (/429|quota exceeded|usage limit/i.test(err.message)) return 'quota';
  if (/unauthorized|401|invalid api key|not authenticated/i.test(err.message)) return 'auth';
  if (/ENOENT|command not found|spawn.*failed|econnrefused/i.test(err.message)) return 'engine';
  return 'task'; // default: GEEN fallback, dit is de veilige kant
}
```

### `PromptRouter`

```ts
// src/quota/prompt-router.ts
export interface RouteDecision {
  engine: EngineType;
  score: number;
  explain: string[];        // menselijk leesbare uitleg per factor
  candidates: Array<{ engine: EngineType; score: number; excluded?: string }>;
}

export interface RouteInput {
  taskHint?: string;                 // voor toekomstige taakgeschiktheids-scoring
  preferredEngine?: EngineType;      // expliciete gebruikersvoorkeur
  explicitEngine?: EngineType;       // hard override — routing wordt overgeslagen
}

export class PromptRouter {
  constructor(
    private config: PromptRoutingConfig,
    private quotaManager: QuotaManager,
    private circuitBreaker: CircuitBreaker,
    private reliability: ReliabilityTracker,
    private clock: () => number = Date.now,
  ) {}

  route(input: RouteInput): RouteDecision { /* zie scoring hieronder */ }
}
```

Score per kandidaat-engine (deterministisch, geen wall-clock in de
berekening zelf — `now` wordt doorgegeven):

```
score(engine) = taakgeschiktheid(engine, taskHint)
              × quotagezondheid(engine)     // available=1, degraded=0.5, unknown=0.75, cooldown/exhausted → uitgesloten
              × recente_betrouwbaarheid(engine)  // 1 - (faalratio laatste N pogingen)
              × gebruikersvoorkeur(engine)   // priority uit config, genormaliseerd
              × beschikbaarheid(engine)      // 0 als CircuitBreaker open of enabled=false, anders 1
```

Vereisten uit de opdracht, expliciet geborgd:
- **Deterministisch bij gelijke input** — kandidaten gesorteerd op
  `[engine].sort()` vóór scoring, tiebreak op `priority` dan lexicaal.
- **Expliciete keuze blijft mogelijk** — `input.explicitEngine` slaat de
  router helemaal over (identiek aan vandaag: `fullConfig.engine` gezet).
- **`--explain`** — `RouteDecision.explain`/`candidates` wordt getoond.
- **`--dry-run`** — `route()` aanroepen zonder `_createSession`/`start()` aan
  te roepen.
- **Cooldown/exhausted uitgesloten** — score 0 / hard filter vóór scoring.
- **`unknown` ≠ onbruikbaar** — telt als neutrale (0.75) factor, geen uitsluiting.
- **Fallback alleen bij quota/auth/engine-fout** — via `classifyError`,
  nooit bij `'task'`.

## 6. Configuratievoorstel

Uitbreiding van `PluginConfig` (`src/types.ts`), zelfde nesting-patroon als
`proxy`/`pricingOverrides` — **geen YAML, geen tweede configsysteem**:

```ts
export interface PromptRoutingEngineConfig {
  enabled: boolean;
  priority: number;           // hoger = voorkeur bij gelijke score
  maxCallsPerWindow?: number; // optioneel, lokaal budget
  windowMinutes?: number;
}

export interface PromptRoutingConfig {
  enabled: boolean;           // feature flag — default false, huidig gedrag ongewijzigd
  strategy: 'balanced';       // enum, uitbreidbaar; v1 heeft alleen 'balanced'
  fallback: boolean;
  safetyMargin: number;       // 0..1, marge vóór "exhausted"
  engines: Partial<Record<EngineType, PromptRoutingEngineConfig>>;
}

export interface PluginConfig {
  // ...bestaande velden ongewijzigd...
  promptRouting?: PromptRoutingConfig;
}
```

Default (equivalent aan het YAML-voorbeeld uit de opdracht, maar in het
bestaande JSON/TS-formaat):

```jsonc
{
  "promptRouting": {
    "enabled": false,
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

Wordt gespiegeld in `openclaw.plugin.json`'s `configSchema` (voor de
OpenClaw-hostconfig-UI) en optioneel als CLI-flags/env vars in `bin/cli.ts`
(bv. `--no-routing`, `CLAWO_PROMPT_ROUTING_ENABLED`), consistent met de
bestaande `GEMINI_BIN`/`AGY_BIN`-stijl env-overrides.

## 7. Teststrategie

- **Unit** (`src/__tests__/quota/*.test.ts`, vitest, geen echte CLI's):
  - `classify-error.test.ts` — matrix van foutmeldingen → verwachte classificatie,
    inclusief de expliciete "content-fout → `'task'`, geen fallback"-gevallen.
  - `quota-manager.test.ts` — cooldown-opbouw/-verval met geïnjecteerde clock,
    reset bij succes, persistente status zonder credentials.
  - `prompt-router.test.ts` — hergebruikt het bestaande `MockSession` +
    `_createSession`-monkeypatch-patroon uit `circuit-breaker.test.ts`, met
    `FailingSession`-varianten per quota-state (`cooldown`, `exhausted`,
    `unknown`, gezond). Test expliciet: determinisme (zelfde input → zelfde
    `RouteDecision` inclusief `explain`), uitsluiting bij cooldown/exhausted,
    `unknown` telt niet als onbruikbaar, expliciete engine-override,
    fallback bij gesimuleerde quota-fout, **geen** fallback bij gewone
    taakfout.
  - **Regressietest voor de feature flag**: met `promptRouting.enabled` afwezig
    of `false`, is de resolved engine voor bestaande inputs bit-voor-bit gelijk
    aan de huidige `fullConfig.engine || persisted?.engine || 'claude'`-logica
    op `session-manager.ts:624`. Dit is de belangrijkste test van de hele
    fase — hij bewijst "zonder die optie gedraagt Claw Orchestrator zich exact
    zoals voordien".
- **Integratie**: uitbreiding van `session-manager.test.ts` met routing
  ingeschakeld — engine wordt gekozen op basis van gesimuleerde quotastatus,
  zonder echte CLI's te starten (zelfde mocking als vandaag).
- **Nadrukkelijk niet**: geen test die echte CLI-quota verbruikt (conform
  veiligheidsregel) — alle quota-simulatie gebeurt via geïnjecteerde
  `QuotaProvider`-fakes/`classifyError`-input, nooit via live API-calls.

## 8. Migratiepad zonder breaking changes

1. Nieuwe modules onder `src/quota/` — raken geen bestaande bestanden totdat
   ze bewust worden aangesloten.
2. Eén regel wijzigt in `_doStartSession` (rond `:624-641`): als
   `fullConfig.engine` **niet** expliciet gezet is én
   `this.pluginConfig.promptRouting?.enabled` waar is, vraag `PromptRouter`
   om een engine; anders exact het huidige gedrag.
3. `CircuitBreaker`-gebruik blijft ongewijzigd — `QuotaManager` raadpleegt
   `CircuitBreaker.getStatus()` als extra uitsluitingsfactor, vervangt hem
   niet.
4. `PluginConfig.promptRouting` is optioneel; ontbreekt hij, dan is
   `enabled` effectief `false` en verandert er niets.
5. Geen wijziging aan `ISession`, geen wijziging aan bestaande adapter-
   bestanden in v1 (foutclassificatie gebeurt op basis van `Error.message` en
   bestaande `SessionStats`-velden, niet door adapters te herschrijven).
6. `openclaw.plugin.json`-`configSchema` krijgt een nieuw optioneel blok;
   bestaande installaties zonder dat blok blijven werken.
7. `CHANGELOG.md` krijgt een `## [Unreleased]`-sectie (geen versie-bump in
   `package.json` — dat garandeert een merge-conflict bij elke toekomstige
   `git merge --ff-only upstream/main`).

## 9. Opsplitsing in kleine, implementeerbare fasen

1. **v1 (deze branch, `feat/quota-aware-routing-v1`)** — datamodellen
   (`QuotaState`/`QuotaSnapshot`), in-memory `QuotaManager`, handmatig
   configureerbare quota per engine, `classifyError`, `PromptRouter` met
   `balanced`-strategie, `--dry-run`/`--explain` (via CLI + HTTP-route +
   MCP-tool-parameter), automatische cooldown na gesimuleerde rate-limit,
   unit tests met fake engines, config-default zoals §6, feature-vlag uit
   (`enabled: false`) door default.
2. **v1.1 — mid-sessie fallback bij live quota-fout. GEÏMPLEMENTEERD**
   (`feat/quota-aware-routing-v1.1`, gestapeld op v1). `sendMessage` vangt
   een `classifyError() === 'quota'`-fout op, en — uitsluitend als de
   sessie's engine door de router zelf gekozen was (`routedByRouter`, nooit
   een expliciete of hervatte engine) én `promptRouting.fallback: true` —
   stopt de huidige sessie en herstart onder dezelfde naam op de
   eerstvolgende beschikbare engine, waarna het bericht éénmalig opnieuw
   wordt verstuurd. Besluit over sessie-continuïteit (risico 1 uit §4): géén
   contextoverdracht — technisch onmogelijk tussen verschillende CLI's/
   protocollen; de nieuwe sessie start vers, alleen engine-agnostische config
   (`cwd`, `permissionMode`, `maxTurns`, …) wordt overgenomen, en de caller
   krijgt dit terug via `SendResult.engineSwitched`. Precies één automatische
   switch per sessie (de fallback-sessie wordt met een expliciete engine
   gestart, dus zelf nooit opnieuw router-gekozen — geen cascaderende
   engine-hopping). Bij falen van de fallback zelf blijft de oorspronkelijke
   fout leidend (via `Error.cause`, maar ook letterlijk in de top-level
   `.message`, omdat HTTP-foutafhandeling elders in de codebase alleen
   `.message` leest, nooit `.cause`). Zie
   `skills/references/prompt-routing.md` voor het volledige gedrag.
3. **v1.2 — per-engine machineleesbare quota-check**, indien en zodra een CLI
   (Claude, Codex, …) een officieel `--usage`/`--quota`-commando aanbiedt.
   Vervangt bron 1 in de `QuotaProvider`-prioriteitenlijst van "nog niet
   beschikbaar" naar "actief".
4. **v1.3 — reliability-tracking verfijnen**: sliding-window
   succes/faalratio per engine per taaktype, i.p.v. de simpele teller uit v1.
5. **v1.4 — dashboard-integratie**: routing-status en `--explain`-traces
   zichtbaar in de bestaande embedded dashboard (`src/dashboard/`), als
   losstaande, opt-in uitbreiding.

Elke fase is onafhankelijk shippable en laat het gedrag bij
`promptRouting.enabled: false` (of ontbrekend) exact ongewijzigd.
