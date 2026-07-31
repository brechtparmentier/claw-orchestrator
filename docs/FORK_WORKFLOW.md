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

```bash
git switch main
git fetch upstream
git merge --ff-only upstream/main   # faalt als main lokaal afwijkt — zie hieronder
```

Als `--ff-only` faalt, heeft lokale `main` eigen commits die er niet horen te
zijn (main hoort nooit rechtstreeks bewerkt te worden). Onderzoek met
`git log main..upstream/main` en `git log upstream/main..main` welke kant
afwijkt voordat je verder gaat — forceer niets automatisch.

## Fork synchroniseren (`origin/main` bijwerken)

```bash
git push origin main
```

## Featurebranch maken

```bash
git switch main
git fetch upstream && git merge --ff-only upstream/main   # eerst schoon syncen
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
git fetch upstream && git merge --ff-only upstream/main
git switch feat/<korte-naam>
git merge main               # of: git rebase main, als de branch nog niet gepusht/gedeeld is
# conflicten oplossen, dan:
git add <bestanden>
git merge --continue          # of: git rebase --continue
```

Gebruik geen `git reset --hard` of `git checkout -- .` om een conflict "weg
te maken" — dat verwijdert eigen werk. Los conflicten op in de bestanden zelf.

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
