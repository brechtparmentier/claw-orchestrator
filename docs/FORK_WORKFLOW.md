# Fork-workflow — brechtparmentier/claw-orchestrator

Korte referentie voor het werken op deze fork van `Enderfga/claw-orchestrator`.

> Let op: `docs/` staat in `.gitignore` van deze fork ("local process scratch
> only, never shipped"). Dit bestand is expliciet met `git add -f`
> toegevoegd zodat het wél op de branch/PR staat — nieuwe bestanden onder
> `docs/` worden anders stilzwijgend niet meegenomen door `git add -A` of
> `git status`.
>
> **Belangrijk voor latere wijzigingen:** ook toekomstige edits aan dit
> bestand of `docs/quota-aware-routing-plan.md` moeten opnieuw expliciet met
> `git add -f <bestand>` gestaged worden — een gewone `git add -A` of
> `git status` slaat ze stilzwijgend over zodra ze eenmaal getrackt zijn,
> `git add <bestand>` zonder `-f` geeft een expliciete foutmelding
> ("paths are ignored by one of your .gitignore files").

## Statuswijziging (2026-08-01): `main` is niet langer een spiegel van upstream

Tot en met commit `99b6c1f` liep lokale/fork-`main` gelijk aan
`upstream/main`, en werden `--ff-only`-merges gebruikt om dat gegarandeerd zo
te houden. Op 2026-08-01 is dat bewust doorbroken: de quota-aware-routing-
feature (v1 + v1.1, ontwikkeld op `feat/quota-aware-routing-v1` en
`feat/quota-aware-routing-v1.1`) is via PR's #1 en #3 in `main` gemerged als
nieuwe, eigen basis voor verdere ontwikkeling. `main` bevat vanaf nu commits
die niet in `upstream/main` zitten.

**Praktisch gevolg:** `git merge --ff-only upstream/main` zal vanaf nu altijd
falen (dat is verwacht, geen foutsituatie) — gebruik in plaats daarvan een
gewone merge. Zie hieronder.

## Remotes (eenmalig controleren)

```bash
git remote -v
# origin    git@github.com:brechtparmentier/claw-orchestrator.git (fetch/push)
# upstream  git@github.com:Enderfga/claw-orchestrator.git (fetch/push)
git config --local --get remote.pushDefault   # moet 'origin' zijn
```

## Upstream ophalen

```bash
git fetch upstream
```

## Lokale `main` synchroniseren met upstream

`main` heeft nu eigen commits (zie boven), dus een gewone merge — niet meer
`--ff-only`:

```bash
git switch main
git fetch upstream
git merge upstream/main   # maakt een merge-commit; los conflicten op indien nodig
git push origin main
```

Controleer bij conflicten eerst wat er precies botst — met name `src/types.ts`,
`src/session-manager.ts` en `openclaw.plugin.json` zijn plekken waar
upstream-wijzigingen kunnen overlappen met de quota-aware-routing-code. Los
conflicten op in de bestanden zelf; gebruik nooit `git checkout --theirs .`
of vergelijkbaar om in bulk te "kiezen" zonder te lezen wat er verandert.

Alternatief voor een schonere lineaire historie (optioneel, alleen als er nog
geen anderen op `main` gebaseerd werk hebben): `git rebase upstream/main` in
plaats van `merge` — herschrijft dan wel de hashes van de eigen commits op
`main`, dus alleen doen als je zeker weet dat niemand anders die hashes al
gebruikt (bijv. in een nog niet gepushte branch elders).

## Fork synchroniseren (`origin/main` bijwerken)

```bash
git push origin main
```

## Featurebranch maken

```bash
git switch main
git fetch upstream && git merge upstream/main   # eerst schoon syncen (niet meer --ff-only, zie boven)
git switch -c feat/<korte-naam>
```

## Featurebranch pushen (uitsluitend naar de fork)

```bash
git push -u origin feat/<korte-naam>
```

`remote.pushDefault=origin` staat lokaal ingesteld, dus een kale `git push`
op een featurebranch gaat ook naar `origin`. Gebruik nooit `--force` of
`--force-with-lease` tenzij expliciet gevraagd.

## Conflicten veilig oplossen

```bash
git switch main
git fetch upstream && git merge upstream/main
git switch feat/<korte-naam>
git merge main               # of: git rebase main, als de branch nog niet gepusht/gedeeld is
# conflicten oplossen, dan:
git add <bestanden>
git merge --continue          # of: git rebase --continue
```

Gebruik geen `git reset --hard` of `git checkout -- .` om een conflict "weg
te maken" — dat verwijdert eigen werk. Los conflicten op in de bestanden zelf.

## Valkuil: een PR sluit automatisch als je de basisbranch verwijdert

Bij gestapelde PR's (PR B met base = branch van PR A, in plaats van `main`):
zodra PR A gemerged wordt met "delete branch" aangevinkt, sluit GitHub PR B
**automatisch** — zelfs al staan de commits van PR B nog gewoon op de
remote. `gh pr reopen`/`gh pr edit --base` werken dan niet meer (de
basisbranch bestaat niet meer om tegen te vergelijken). Er gaat geen code
verloren, maar de PR zelf is niet meer bruikbaar.

Oplossing: laat een nieuwe PR aanmaken vanaf dezelfde featurebranch, nu met
`--base main` (of de correcte, nog bestaande branch). Controleer eerst met
`git merge-base origin/main origin/<branch>` dat dit een schone, kleine diff
oplevert (geen dubbele commits) voordat je de PR aanmaakt. Voorkomen is
beter: merge de PR's van een stack in volgorde van basis naar top, en
retarget een afhankelijke PR naar `main` *vóórdat* je de branch eronder
verwijdert — niet erna.

## Controleren dat je niet per ongeluk naar upstream pusht

```bash
git remote get-url --push origin     # moet brechtparmentier/claw-orchestrator zijn
git remote get-url --push upstream   # moet Enderfga/claw-orchestrator zijn
git config --local --get remote.pushDefault   # moet 'origin' zijn
```

Vuistregel: als een `git push`-commando geen expliciete remote noemt en
`pushDefault` op `origin` staat, is een push naar upstream feitelijk
onmogelijk zonder `git push upstream ...` expliciet te typen. Typ dat nooit
zonder uitdrukkelijke bevestiging vooraf.
