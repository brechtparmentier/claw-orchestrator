Je werkt als lead TypeScript-ontwikkelaar en repository-maintainer. Help mij veilig verder bouwen op een fork van:

- Upstream: `Enderfga/claw-orchestrator`
- Mijn GitHub-account: `brechtparmentier`
- Gewenste lokale map: `~/repos/ai-cli-router`

## Hoofddoel

Breid Claw Orchestrator uiteindelijk uit met **quota-aware prompt routing** voor:

- Claude Code CLI
- Codex CLI
- Gemini CLI
- Cursor Agent CLI

De router moet per prompt de meest geschikte beschikbare agent kiezen, rekening houdend met:

1. geschiktheid voor de taak;
2. gekende of geschatte quota;
3. rate-limit- en cooldownstatus;
4. recente fouten en betrouwbaarheid;
5. expliciete gebruikersvoorkeuren.

Ik heb weinig ervaring met forks. Leg daarom vóór belangrijke Git-acties telkens in één korte zin uit wat je doet. Voer daarna de actie zelf uit.

## Strikte veiligheidsregels

- Push nooit naar `Enderfga/claw-orchestrator`.
- Gebruik mijn fork als `origin` en het originele project als `upstream`.
- Verander geen globale Git-configuratie.
- Gebruik nooit `--force` of `--force-with-lease`.
- Werk nooit rechtstreeks op `main`.
- Houd `main` gelijk aan `upstream/main`.
- Maak geen upstream pull request zonder mijn expliciete vraag.
- Push een featurebranch alleen naar mijn fork.
- Bewaar alle bestaande functionaliteit en interfaces.
- Gebruik geen echte API-keys in code, tests, logs of documentatie.
- Tests mogen geen echte CLI-quota verbruiken.
- Neem niet aan dat documentatie en implementatie overeenkomen: verifieer alles in de actuele code.

## Fase 1 — Fork en lokale repository veilig opzetten

Controleer eerst:

```bash
gh auth status
git --version
node --version
npm --version
```

Controleer daarna of mijn fork en lokale map al bestaan.

### Wanneer de fork nog niet bestaat

Maak en clone de fork met GitHub CLI:

```bash
cd ~/repos
gh repo fork Enderfga/claw-orchestrator --clone
cd claw-orchestrator
```

### Wanneer de fork wel bestaat maar niet lokaal staat

Clone mijn fork:

```bash
cd ~/repos
gh repo clone brechtparmentier/claw-orchestrator
cd claw-orchestrator
```

### Wanneer de repository al lokaal bestaat

Gebruik de bestaande map en maak geen tweede clone.

Controleer vervolgens:

```bash
git status
git branch --show-current
git remote -v
gh repo view --json nameWithOwner,isFork,parent,defaultBranchRef
```

De gewenste situatie is:

- `origin` → `brechtparmentier/claw-orchestrator`
- `upstream` → `Enderfga/claw-orchestrator`

Corrigeer de remotes indien nodig. Configureer uitsluitend lokaal dat pushes standaard naar mijn fork gaan:

```bash
git config remote.pushDefault origin
```

Controleer opnieuw met:

```bash
git remote -v
git config --local --get remote.pushDefault
```

## Fase 2 — Schone baseline vastleggen

Synchroniseer eerst veilig met upstream:

```bash
git fetch --all --prune
git switch main
git merge --ff-only upstream/main
git push origin main
```

Lees vóór verdere acties minimaal:

- `README.md`
- `CLAUDE.md`
- `CONTRIBUTING.md`
- `package.json`
- relevante documentatie over engines, sessions en routing
- bestaande tests en CI-workflows

Installeer dependencies volgens de huidige repository-instructies. Gebruik bij aanwezigheid van `package-lock.json` bij voorkeur:

```bash
npm ci
```

Voer daarna alle officieel vereiste baselinechecks uit, waaronder minimaal de in `CONTRIBUTING.md` en `package.json` vermelde build-, lint-, formatting- en testcommando’s.

Noteer:

- huidige commit-SHA;
- Node- en npm-versie;
- resultaat per check;
- bestaande fouten die al aanwezig waren vóór onze wijzigingen.

Wijzig nog geen productiecode zolang de baseline niet duidelijk is.

## Fase 3 — Onderzoek de bestaande architectuur

Onderzoek gericht:

1. waar de engine-adapters voor Claude, Codex, Gemini en Cursor staan;
2. welke gemeenschappelijke interface zij implementeren;
3. hoe `SessionManager` of de actuele tegenhanger engines selecteert;
4. waar CLI-output, errors, tokengebruik en kosten worden verwerkt;
5. welke routing-, fallback-, retry- en circuit-breakerlogica al bestaat;
6. welke CLI’s persistent draaien en welke per prompt worden gestart;
7. hoe configuratie, environment variables en CLI-argumenten worden geladen;
8. waar een nieuwe router het minst invasief kan worden ingevoegd.

Gebruik code search en lees de werkelijke implementatie. Vertrouw niet alleen op README-bestanden.

Maak daarna:

```text
docs/quota-aware-routing-plan.md
```

Dit document moet bevatten:

- huidige relevante architectuur;
- gevonden extensiepunten;
- verschillen tussen de vier engines;
- risico’s en onbekenden;
- voorgestelde componenten;
- configuratievoorstel;
- teststrategie;
- migratiepad zonder breaking changes;
- opsplitsing in kleine implementeerbare fasen.

## Fase 4 — Ontwerpvereisten

Ontwerp minimaal deze losse componenten, aangepast aan de bestaande naamgeving en structuur:

### `QuotaProvider`

Een interface waarmee elke engine quota-informatie kan aanleveren:

- `available`
- `degraded`
- `cooldown`
- `exhausted`
- `unknown`

Quota-informatie kan komen uit:

1. een officieel machineleesbaar CLI-commando, indien beschikbaar;
2. waargenomen rate-limit-errors en resetinformatie;
3. lokaal bijgehouden verbruik;
4. door de gebruiker ingestelde budgetten;
5. een fallbackstatus `unknown`.

Gebruik geen fragiele scraping van interactieve terminalschermen als standaardoplossing.

### `QuotaManager`

Verantwoordelijk voor:

- status per engine;
- rolling usage;
- cooldowns;
- resetmomenten;
- laatste succesvolle aanvraag;
- laatste quota-gerelateerde fout;
- configureerbare veiligheidsmarge;
- persistente lokale status zonder credentials.

### `PromptRouter`

Berekent een uitlegbare score op basis van:

```text
taakgeschiktheid
× quotagezondheid
× recente betrouwbaarheid
× gebruikersvoorkeur
× beschikbaarheid
```

Vereisten:

- deterministische keuze bij gelijke input;
- expliciete enginekeuze blijft altijd mogelijk;
- `--explain` toont waarom een engine gekozen werd;
- `--dry-run` kiest een engine zonder die te starten;
- engines in cooldown of `exhausted` worden uitgesloten;
- `unknown` betekent niet automatisch onbruikbaar;
- fallback gebeurt alleen bij relevante engine-, authenticatie- of quota-errors;
- inhoudelijke fouten in gegenereerde code mogen niet als quota-fout worden behandeld.

### Configuratie

Voorzie een duidelijke configuratie zoals:

```yaml
routing:
  strategy: balanced
  fallback: true
  safetyMargin: 0.15

engines:
  claude:
    enabled: true
    priority: 100
  codex:
    enabled: true
    priority: 90
  gemini:
    enabled: true
    priority: 80
  cursor:
    enabled: true
    priority: 70
```

Pas het formaat aan de bestaande configuratiearchitectuur aan. Introduceer geen tweede configuratiesysteem wanneer er al één bestaat.

## Fase 5 — Maak een minimale verticale implementatie

Maak vanaf gesynchroniseerde `main` een branch:

```bash
git switch -c feat/quota-aware-routing-v1
```

Implementeer vervolgens alleen een kleine, testbare eerste versie:

1. gemeenschappelijke quota-statusmodellen;
2. in-memory `QuotaManager`;
3. manueel configureerbare quota per engine;
4. router met `balanced` strategie;
5. `--dry-run` of equivalent;
6. `--explain` of equivalent;
7. automatische cooldown na gesimuleerde rate-limit;
8. unit tests met fake engines;
9. documentatie met voorbeeldconfiguratie.

Nog niet in deze eerste versie:

- fragiele parsing van dashboards;
- authenticatiebeheer;
- volledige historische analytics;
- complexe UI;
- automatische detectie die echte quota verbruikt;
- breaking changes aan bestaande engine-selectie.

Plaats de nieuwe router achter een expliciete optie of feature flag. Zonder die optie moet Claw Orchestrator zich exact zoals voordien gedragen.

## Fase 6 — Validatie

Voer na implementatie alle repositorychecks opnieuw uit.

Test minimaal:

- alle engines beschikbaar;
- voorkeursengine bijna uitgeput;
- engine in cooldown;
- quota onbekend;
- expliciet gekozen engine;
- fallback na gesimuleerde rate-limit;
- geen fallback bij gewone taakfout;
- deterministische keuze;
- bestaande werking zonder quota-routing;
- config met uitgeschakelde engine.

Vergelijk de resultaten met de baseline.

## Fase 7 — Git en rapportering

Controleer vóór commit:

```bash
git status
git diff --check
git diff --stat
git diff
```

Maak logische, kleine commits volgens de conventies van het project. Push uitsluitend naar mijn fork:

```bash
git push -u origin feat/quota-aware-routing-v1
```

Open nog geen upstream pull request.

Geef als eindrapport:

1. fork- en remotestatus;
2. baseline en gebruikte commit-SHA;
3. belangrijkste architectuurbevindingen;
4. gewijzigde bestanden;
5. geïmplementeerde functionaliteit;
6. testresultaten;
7. resterende risico’s en onbekenden;
8. exacte commando’s om de feature lokaal te testen;
9. exacte workflow om later `upstream/main` veilig binnen te halen;
10. aanbeveling voor de eerstvolgende kleine vervolgstap.

Maak daarnaast een korte handleiding:

```text
docs/FORK_WORKFLOW.md
```

Met maximaal de essentiële commando’s voor:

- upstream ophalen;
- lokale `main` synchroniseren;
- fork synchroniseren;
- featurebranch maken;
- featurebranch pushen;
- conflicten veilig oplossen;
- controleren dat ik niet per ongeluk naar upstream push.
