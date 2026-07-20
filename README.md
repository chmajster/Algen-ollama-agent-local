# Local Code Agent — lokalna orkiestracja specjalistów (etap 11)

Lokalny agent programistyczny korzystający z Ollamy. Analizuje repozytorium, przygotowuje kontrolowane zmiany, stosuje je transakcyjnie, a następnie przedstawia rzeczywiste wyniki testów, lintowania, typechecku i buildu. Integracja GitHub jest opcjonalna, domyślnie wyłączona i nie obejmuje telemetrii. Po jej włączeniu tylko jawnie wybrane operacje korzystają z GitHub API.

## Orchestrated

Tryb `Orchestrated` rozdziela duże zadanie między lokalnych specjalistów: planner, eksploracja repozytorium, architektura, implementacja, testy, niezależny review, security, wydajność i dokumentacja. Centralny `AgentOrchestrator` buduje DAG, egzekwuje budżety i file lease’y, uruchamia tylko bezpieczne partie równoległe, waliduje artefakty oraz syntetyzuje wynik bez udostępniania historii rozmów między agentami.

```text
User approval → Task graph → Specialist agents → Shared artifacts
              → Conflict detection → Security + independent review
              → Final user approval
```

Żaden specjalista nie może zastosować ChangeSetu, przywrócić checkpointu, pisać do remote, utworzyć innego agenta ani zatwierdzić wyniku. Zapisy przygotowawcze przechodzą przez wspólny `LocalChangeService`; `AGENT_ORCHESTRATION_ALLOW_PARALLEL_WRITES` jest bezwarunkowo `false`. Security veto i wynik `changes_required` blokują finalne zatwierdzenie.

Plan i wynik mają osobne, obowiązkowe bramki użytkownika. Flaga `--yes`, model ani protokół narzędziowy nie mogą ich ominąć.

### Agent, Autonomous i Orchestrated

| Tryb         | Przebieg                                      | Zapis                                        |
| ------------ | --------------------------------------------- | -------------------------------------------- |
| Agent        | jedna pętla modelu i wspólny ToolRegistry     | po istniejącym potwierdzeniu ChangeSetu      |
| Autonomous   | wariant zakresu sesji orkiestracji            | w tym repozytorium tylko przygotowanie zmian |
| Orchestrated | DAG kilku niezależnych ról, review i security | specjaliści nigdy nie stosują zmian          |

Repozytorium nie zawiera obecnie osobnej implementacji LSP, GitSandbox ani izolowanych Git Worktree. Dlatego tryb orkiestracji nie udaje tych zabezpieczeń: pola `symbols` i `diagnostics` pozostają puste bez dostawcy LSP, a `autonomous` nie wykonuje automatycznego zapisu, commita ani publikacji. Przygotowane zmiany nadal podlegają istniejącemu ChangeService i jawnej decyzji użytkownika.

### CLI

```bash
npm run agent -- orchestrate "Dodaj system ról i uprawnień"
npm run agent -- orchestrate --mode analysis "Przeanalizuj architekturę modułu płatności"
npm run agent -- orchestrate --mode implementation "Dodaj cache Redis"
npm run agent -- orchestrate --mode autonomous "Przebuduj warstwę cache i dodaj testy"

npm run agent -- orchestration list
npm run agent -- orchestration status <sessionId>
npm run agent -- orchestration plan <sessionId>
npm run agent -- orchestration approve <sessionId>
npm run agent -- orchestration reject <sessionId>
npm run agent -- orchestration graph <sessionId>
npm run agent -- orchestration agents <sessionId>
npm run agent -- orchestration artifacts <sessionId>
npm run agent -- orchestration conflicts <sessionId>
npm run agent -- orchestration review <sessionId>
npm run agent -- orchestration cancel <sessionId>
npm run agent -- orchestration resume <sessionId>
```

Pierwsze `approve` zatwierdza plan i uruchamia graf. Po review drugie `approve` zatwierdza wyłącznie wynik bez blokad. Sesje są zapisywane w `.agent/orchestration/<sessionId>/` jako manifest, graf, journal, wersjonowane artefakty i raport końcowy. Przerwany stan `running` przechodzi po odtworzeniu do `recovery_required`; wznowienie jest zawsze ręczne.

### VS Code i runtime protocol

Webview udostępnia tryb `Orchestrated`, a widok `Agent Orchestration` pokazuje sesję, węzły, agentów i review. Polecenia `Approve orchestration` i `Reject orchestration` obsługują obie bramki. Krytyczne ustawienia zatwierdzeń i review mają scope `machine`, a wartość `false` jest ignorowana.

Protokół `1.2.0` dodaje procedury `orchestration.*` do tworzenia, listowania, recovery, grafu, agentów, artefaktów, konfliktów oraz zatwierdzeń, a także notyfikacje postępu. Standardowe testy używają deterministycznego runnera i nie wymagają Ollamy.

### Koszt i konfiguracja

Orkiestracja może jednocześnie ładować kilka modeli i zużywać znacznie więcej RAM, CPU, czasu oraz kontekstu niż zwykły Agent. Domyślne limity to 8 agentów, 3 równoległych agentów, 30 podzadań, 200 kroków, 400 tool calls, 100 poleceń, 200 000 tokenów kontekstu i 2 godziny. Wszystkie opcje `AGENT_ORCHESTRATION_*` są opisane w `.env.example` i `config/default.json`.

Testy rdzenia i integracji:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

## GitHub — zakres i granica bezpieczeństwa

Integracja składa się z trzech pakietów:

- `remote-repository` — interfejs dostawcy, parser remote, stan zaufania, polityka operacji, jednorazowe zgody i audyt;
- `github-provider` — Octokit, uwierzytelnianie, uprawnienia, kontrolowany push, Draft PR, GitHub Actions, review i rate limit;
- `ci-analysis` — ograniczanie i sanitizacja logów, diagnostyki, fingerprinty oraz klasyfikacja awarii CI.

```text
Agent → GitHub Provider → Remote Operation Policy → Permission Check
      → User Approval → API/kontrolowany Git → Verification → Audit
```

Publikowanie gałęzi, tworzenie Pull Request i wysyłanie komentarzy są operacjami zewnętrznymi. Każda z nich wymaga jawnej decyzji użytkownika.

Agent nie wykonuje merge, force push ani usuwania zdalnych gałęzi. Nie tworzy forka, issue, release, tagu i nie uruchamia workflow.

### Włączenie i uwierzytelnianie

```env
AGENT_REMOTE_ENABLED=true
AGENT_REMOTE_PROVIDER=github
AGENT_GITHUB_AUTH_MODE=token
```

CLI odczytuje token wyłącznie z `GITHUB_TOKEN`, `GH_TOKEN` albo dostarczonego systemowego magazynu poświadczeń. Argument `--token` jest blokowany, aby sekret nie trafił do historii powłoki. Rozszerzenie używa `vscode.authentication`; token przechodzi do procesu runtime tylko w pamięci przez typowany protokół i nigdy nie trafia do ustawień, SecretStorage, Webview, manifestu ani audytu. `SecretStorage` zapamiętuje wyłącznie nazwę konta.

GitHub Enterprise jest wyłączony. Jego użycie wymaga `AGENT_GITHUB_ALLOW_ENTERPRISE=true` oraz jawnych adresów HTTPS API i Web; klient nie wyłącza TLS i blokuje przekierowanie do innego hosta.

### Remote i uprawnienia

Rozpoznawane są:

```text
git@github.com:owner/repository.git
https://github.com/owner/repository.git
ssh://git@github.com/owner/repository.git
```

URL z hasłem lub tokenem jest blokowany. Host, owner i nazwa repozytorium są walidowane. Kilka remote wymaga jawnego wyboru; zmiana remote unieważnia zaufanie. Przed zapisem runtime odczytuje rzeczywiste role i wylicza `canPush`, `canCreatePullRequest`, `canComment`, `canManageIssues` oraz `canResolveReviewThreads` bez wymagania administratora.

### Publikowanie task branch i Draft PR

Publikować można tylko ukończony task z manifestem, końcowym review, lokalnymi commitami, czystym worktree pod `.agent/worktrees` i gałęzią `agent/*` albo `task/*`. `main`, `master`, `develop` i chronione branche są blokowane. Runtime buduje jedyny dozwolony refspec:

```text
git push <verified-remote> refs/heads/<task-branch>:refs/heads/<task-branch>
```

Nie ma ścieżki kodu dodającej `--force`, `--force-with-lease`, tagi ani inny refspec. Przed kolejnym pushem zdalny HEAD musi zgadzać się z manifestem, a zmiana musi być fast-forward. Po push runtime ponownie odczytuje remote head.

Draft PR może powstać dopiero po publikacji gałęzi. Runtime sprawdza head/base, istniejący PR, issue i istniejące etykiety. Tytuł ma maksymalnie 72 znaki. Opis jest generowany z celu, commitów, zmienionych plików i rzeczywistych wyników weryfikacji; nie zawiera pełnego promptu, logów ani prywatnych ścieżek. Aktualizacja tytułu, opisu lub etykiet pokazuje diff metadanych i wymaga nowej zgody.

### GitHub Actions i analiza CI

Check runs i status contexts są normalizowane. Brak checków ma stan `no_checks`, nie `success`. Monitoring obsługuje `once`, `until_complete` i `manual`, ma konfigurowalny interwał, timeout, anulowanie, limit requestów i backoff przy niskim rate limit.

Log pobierany jest tylko dla wskazanego joba. Przed przekazaniem agentowi runtime usuwa ANSI, normalizuje linie, deduplikuje, zachowuje bloki błędów, ogranicza długość i maskuje tokeny GitHub, Bearer/Basic auth, AWS keys, klucze prywatne, hasła, cookies, authorization headers oraz connection strings. Pełne logi nie są zapisywane w `.agent`.

Klasyfikator rozróżnia test, lint, typecheck, build, zależności, środowisko, timeout, uprawnienia, konfigurację i infrastrukturę. Raport zawiera confidence, diagnostyki z fingerprintami, pliki, lokalne polecenia reprodukcji i rekomendację. Runtime nie uruchamia ponownie workflow.

### Review i prompt injection

Review threads mają ścieżkę/pozycję, stan resolved/outdated i klasyfikację `actionable`, `question`, `suggestion`, `praise`, `informational`, `obsolete` albo `unknown`. Cała treść otrzymuje etykietę `[GITHUB CONTENT — UNTRUSTED]`. Odpowiedź wymaga opublikowanego commita, konkretnej treści i osobnej zgody. Rozwiązanie wątku wymaga kolejnej, odrębnej zgody i istniejącej odpowiedzi.

Komentarze i logi są sprawdzane pod kątem prób ujawnienia sekretów, zmiany promptu/polityki, wykonania poleceń, pobrania skryptu lub force push. Wykrycie emituje `REMOTE_PROMPT_INJECTION_WARNING`; treść nie może zmienić polityki agenta.

### CLI, doctor, audyt i prywatność

```bash
npm run agent -- github status
npm run agent -- github auth status
npm run agent -- github repository
npm run agent -- github permissions
npm run agent -- github rate-limit
npm run agent -- task publish task-20260716-123015-a1b2c3
npm run agent -- task pr create task-20260716-123015-a1b2c3
npm run agent -- task pr checks task-20260716-123015-a1b2c3
npm run agent -- task pr analyze task-20260716-123015-a1b2c3 123456
npm run agent -- task pr threads task-20260716-123015-a1b2c3
npm run agent -- doctor --github-read
```

`--yes` pomija zgodę tylko dla jawnie wpisanej, konkretnej komendy zapisu. Narzędzia modelu mają prefiks `request_*` i nie przyjmują `--yes` ani nie wykonują drugiej fazy operacji.

Audyt trafia do `.agent/history/remote-operations.jsonl` (plik jest ignorowany przez Git). Zawiera czas, sesję, akcję, decyzję, wynik, repozytorium i identyfikatory — bez tokenów, nagłówków, komentarzy, zawartości plików i pełnych logów. Cache użytkownika, repozytorium, uprawnień i etykiet jest krótkotrwały; token nie jest cache’owany na dysku.

Etap 4 dodaje dwa niezależne pakiety:

- `command-runner` — polityka poleceń, walidacja, oczyszczone środowisko, bezpieczne uruchamianie procesów, timeout, abort, limity wyjścia, sprzątanie drzewa procesów i historia;
- `project-verifier` — wykrywanie skryptów projektu, plan weryfikacji, parsery wyników, baseline, klasyfikacja regresji i raporty.

Agent nadal nie otrzymuje terminala ani dowolnego dostępu do PowerShell, Bash lub CMD.

## Wymagania i uruchomienie

- Node.js 22 lub nowszy,
- npm,
- lokalnie uruchomiona Ollama,
- model obsługujący tool calling, domyślnie `qwen3.5:9b`.

```bash
ollama pull qwen3.5:9b
npm install
npm run agent -- doctor
```

W PowerShell, który blokuje `npm.ps1`, użyj `npm.cmd`.

## Automatic installation on Windows

The production installer supports Windows 10/11 x64, Windows PowerShell 5.1, and PowerShell 7+. It installs into `%LOCALAPPDATA%\Algen\LocalCodeAgent`, safely clones or fast-forwards the source repository, builds the existing monorepo and VS Code extension, verifies Ollama and the selected model, and configures only the extension's host, model, and runtime autostart settings. It never installs a separate runtime service.

Chocolatey is preferred when it is already installed; winget is the fallback. The installer does not bootstrap Chocolatey. Run the following from PowerShell to download the installer to a temporary file, execute it in a separate Windows PowerShell process, retain its exit code, and remove it:

```powershell
$p = Join-Path $env:TEMP "install-algen-ollama-agent.ps1"; $r = Invoke-RestMethod -Headers @{ "User-Agent" = "Algen-Installer"; Accept = "application/vnd.github+json" } "https://api.github.com/repos/chmajster/Algen-ollama-agent-local/contents/install.ps1?ref=main"; [IO.File]::WriteAllBytes($p, [Convert]::FromBase64String(($r.content -replace "\s", ""))); & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p; $exitCode = $LASTEXITCODE; Remove-Item $p -Force -ErrorAction SilentlyContinue; exit $exitCode
```

Examples:

```powershell
.\install.ps1 -Model "qwen3.5:27b"
.\install.ps1 -SkipDependencyInstall
.\install.ps1 -SkipModelPull
.\install.ps1 -WhatIf
```

`-WhatIf` prints the planned operations without installing packages, changing the repository, running npm, starting Ollama, pulling a model, changing settings, installing the VSIX, or opening VS Code. Re-running the installer is supported. A dirty worktree is never reset or overwritten, including with `-Force`.

Troubleshooting:

- **Chocolatey and winget unavailable:** install one package manager yourself, or install Git, Node.js 22+, Ollama, and VS Code manually and use `-SkipDependencyInstall`.
- **Chocolatey needs administrator privileges:** accept the UAC prompt. If elevation is prohibited by policy, install dependencies manually and use `-SkipDependencyInstall`. The installer will not repeatedly relaunch itself.
- **`npm.ps1` is blocked:** no policy change is needed; the installer always invokes `npm.cmd`.
- **VS Code CLI missing:** reinstall VS Code with its “Add to PATH” option, or ensure `code.cmd` exists under the standard user or Program Files location. `-SkipVSCodeInstall` only skips package installation; final verification still requires the CLI.
- **Ollama API unavailable:** verify that `<host>/api/version` responds and inspect the timestamped Ollama output/error logs next to the installer log.
- **Port 11434 conflict:** identify the application listening on the port, stop or reconfigure it, or pass a valid alternative `-OllamaHost`. The endpoint must be an Ollama API.
- **Insufficient disk space:** free space for npm dependencies, the VSIX, and the selected model; larger model tags can require many gigabytes.
- **VSIX installation failed:** close no processes; inspect the installer log, verify `code --version`, and retry `code --install-extension <path-to-vsix> --force`.
- **Dirty Git worktree:** commit or stash local changes before retrying. `-Force` deliberately does not discard Git changes.
- **Extension not visible after installation:** use **Developer: Reload Window** in VS Code. The installer opens a new window and never closes existing ones.

Przykłady:

```bash
npm run agent -- --mode write --verify "Dodaj walidację formularza"
npm run agent -- --mode preview --verify "Przygotuj poprawkę błędu TypeScript"
npm run agent -- --mode write --verification-scope workspace "Napraw testy"
npm run agent -- --mode write --no-baseline "Napraw lint"
```

Bez treści zadania CLI przechodzi w tryb interaktywny. `Ctrl+C` anuluje żądanie modelu i aktywny proces oraz kończy program kodem 130.

## Tryby dostępu

| Tryb       | Analiza | ChangeSet i diff | Zapis plików | Bezpieczna weryfikacja          |
| ---------- | ------- | ---------------- | ------------ | ------------------------------- |
| `readonly` | tak     | nie              | nie          | tak                             |
| `preview`  | tak     | tak              | nie          | tak, tylko polecenia bez zapisu |
| `write`    | tak     | tak              | po zgodzie   | tak                             |

Domyślny tryb to `preview`. `--yes` działa wyłącznie z jawnie podanym `--mode write` i pomija potwierdzenia zmian oraz dozwolonych poleceń zapisujących. W etapie 4 wykryte formattery modyfikujące pozostają jednak zablokowane, ponieważ nie omijamy transakcji ChangeSet. Dostępne są ich warianty `--check`/`--verify-no-changes`.

## Architektura wykonywania poleceń

```text
Agent
└── ToolRegistry
    └── ProjectVerifier / aktualny identyfikator polecenia
        └── CommandRunner
            ├── CommandValidator
            ├── CommandPolicy
            ├── EnvironmentSanitizer
            ├── ProcessRunner
            │   ├── OutputLimiter
            │   └── ProcessTreeKiller
            └── CommandHistoryService
```

Model przekazuje jedynie identyfikator wykrytego polecenia oraz powód. Nie wybiera programu, argumentów, `cwd`, środowiska ani timeoutu. Katalog projektu i manifesty są wykrywane ponownie przed wykonaniem, więc nieaktualny identyfikator jest odrzucany.

Proces otrzymuje osobny `executable` i tablicę argumentów. `ProcessRunner` używa `child_process.spawn`, nie przekazuje interaktywnego stdin i zawsze ustawia `shell: false`. Na Windows pliki `.cmd` nie mogą być uruchomione bezpośrednio przez Node. Wąski adapter obsługuje tylko znane wrappery, między innymi `npm.cmd`, `pnpm.cmd`, `mvnw.cmd` i `gradlew.cmd`; waliduje każdy argument i wywołuje kontrolowane `cmd.exe /d /s /c` nadal przez `spawn(..., shell: false)`. Model nie ma dostępu do tego adaptera ani do tekstu polecenia.

## Platformy i wykrywanie programów

Obsługiwane są Windows i Linux. macOS ma zgodność dodatkową.

Detektor platformy zwraca architekturę, separator ścieżek, czułość na wielkość liter oraz dostępne powłoki. Preferencje:

- Windows: `pwsh`, potem Windows PowerShell, na końcu `cmd` tylko dla kontrolowanego wrappera;
- Linux/macOS: `bash`, potem `sh`; `zsh` jest również wykrywany.

Resolver rozpoznaje między innymi Node.js, npm, pnpm, Yarn, Bun, Python, pytest, Ruff, Mypy, Poetry, uv, Go, Cargo, Maven, Gradle, .NET, PHP, Composer, Javę, Git i Docker. Samo znalezienie programu nie oznacza zgody na jego uruchomienie.

Kolejność wyszukiwania:

1. `node_modules/.bin` w workspace,
2. `.venv/bin` lub `.venv/Scripts`,
3. `venv/bin` lub `venv/Scripts`,
4. bezpieczny wrapper w katalogu workspace,
5. `PATH`.

Lokalny plik wykonywalny po `realpath` nadal musi mieścić się w workspace. Rozpoznawane są rozszerzenia `.cmd`, `.exe` i `.bat` na Windows.

## Menedżer pakietów

Dowody są analizowane w kolejności:

```text
pnpm-lock.yaml → pnpm
yarn.lock      → yarn
bun.lock/bun.lockb → bun
package-lock.json → npm
package.json#packageManager
```

Sprzeczne lockfile lub sprzeczne pole `packageManager` dają wynik `unknown` i ostrzeżenie. Runtime nie zgaduje menedżera i nie uruchamia wtedy skryptów Node.js. Brak programu jest raportowany bez próby instalacji.

## Wykrywane technologie i polecenia

| Technologia | Wykrywane bezpieczne warianty                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Node.js     | `test*`, `lint*`, `typecheck`, `type-check`, `check`, `build`, `format:check` z `package.json`; proste npm workspaces `katalog/*` |
| Python      | pytest, `ruff check`, `ruff format --check`, Mypy przy obecności `pyproject.toml`                                                 |
| Rust        | `cargo test`, `cargo clippy`, `cargo fmt --check`, `cargo build`                                                                  |
| Go          | `go test ./...`, `go vet ./...`, `go build ./...` z `GOPROXY=off`                                                                 |
| Java        | Maven/Maven Wrapper i Gradle Wrapper w trybie offline; test i build/verify                                                        |
| .NET        | test, build bez restore oraz `dotnet format --verify-no-changes`; `global.json`, `.sln` lub `.csproj`                             |
| PHP         | skrypt `composer test`, jeżeli istnieje i przechodzi analizę bezpieczeństwa                                                       |

Nieobecne narzędzie pozostaje widoczne jako niedostępne lub zablokowane. Projekt bez bezpiecznych poleceń otrzymuje raport `unavailable`, a częściowy zestaw — `partial`.

Skrypt manifestu nie jest automatycznie zaufany. Detektor analizuje nazwę i treść, blokując operatory powłoki, sieć, instalację, tryb watch oraz operacje wdrożeniowe i destrukcyjne. Skrypty `preinstall`, `install`, `postinstall`, `prepare`, `publish`, `deploy`, `release`, `start`, `serve`, `dev`, `watch`, `clean`, `reset`, `migrate` i podobne nie są dopuszczane przez politykę `verification`.

## Polityki i blokady

Dostępne polityki:

- `disabled` — nie rejestruje narzędzi wykonujących procesy; detekcja, historia i raport pozostają tylko do odczytu;
- `verification` — test, lint, typecheck, build, format check, wersje i diagnostyka;
- `restricted` — szersza baza dozwolonych, nadal kontrolowanych kategorii;
- `custom` — tylko jawnie skonfigurowane komendy; nie oznacza terminala.

W etapie 4 runtime nie przyjmuje od modelu własnej konfiguracji komend, dlatego `custom` nie daje mu dodatkowych poleceń.

Bezwarunkowo blokowane są między innymi:

- `rm`, `rmdir`, `del`, `Remove-Item`, `format`, `mkfs`, `diskpart`, `dd`;
- `shutdown`, `reboot`, `sudo`, `su`, `runas`, rekurencyjne `chmod`/`chown`;
- `curl`, `wget`, SSH/SCP/SFTP/FTP, PowerShell web cmdlets;
- dowolne `cmd /c`, `bash -c`, `sh -c`, PowerShell `-Command`/`-EncodedCommand` pochodzące z polecenia;
- `docker push/login`, `kubectl`, `terraform`, `ansible-playbook`;
- Git `push`, `reset`, `clean`, destrukcyjny `checkout`;
- deploy, publish, release, watch, serwery i procesy w tle;
- ścieżki procesu lub argumentu wychodzące poza workspace;
- `&&`, `||`, `;`, potoki, przekierowania, backticks i `$()` w skryptach.

Polecenia zapisujące, sieciowe, niestandardowe albo z konfiguracji użytkownika wymagają zgody lub są blokowane. Model nie może potwierdzić ich za użytkownika.

## Sieć, instalacja i środowisko

Domyślnie `AGENT_ALLOW_NETWORK=false` i `AGENT_ALLOW_PACKAGE_INSTALL=false`. Polityka odrzuca programy, argumenty i skrypty wskazujące sieć lub instalację. Adaptery uruchamiają narzędzia w trybie offline, gdy ekosystem to obsługuje, na przykład przez `NPM_CONFIG_OFFLINE`, `YARN_ENABLE_NETWORK=false`, `PIP_NO_INDEX`, `CARGO_NET_OFFLINE`, `GOPROXY=off`, Maven/Gradle offline i `COMPOSER_DISABLE_NETWORK`.

Proces nie dziedziczy całego środowiska. Domyślna lista zachowywanych nazw to:

```text
PATH,HOME,USERPROFILE,TEMP,TMP,TMPDIR,SystemRoot,COMSPEC,PATHEXT,LANG,LC_ALL,TERM
```

Usuwane są między innymi tokeny AWS, Azure, Google, GitHub, npm, PyPI, Docker, Terraform i klucze API, `SSH_AUTH_SOCK` oraz `KUBECONFIG`. Wartości środowiska nie trafiają do logów ani historii.

To ograniczenie jest warstwą polityki procesu, a nie pełną izolacją kernela. Testy wykonują kod znajdujący się w lokalnym repozytorium; uruchamiaj agenta wyłącznie na repozytoriach, którym ufasz. Etap 4 nie tworzy kontenera, maszyny wirtualnej ani reguł systemowego firewalla.

## Timeout, abort i wyjście procesu

Domyślne timeouty:

| Kategoria           | Limit |
| ------------------- | ----: |
| wersja              |  10 s |
| diagnostyka         |  30 s |
| lint i format check | 120 s |
| typecheck           | 180 s |
| test                | 300 s |
| build               | 300 s |

Model nie może ich zwiększyć. `AbortSignal` i timeout kończą całe drzewo procesu. POSIX używa osobnej grupy procesów i sekwencji TERM → krótki okres łaski → KILL. Windows używa `taskkill /T /F`, ponieważ wcześniejsze zamknięcie wrappera `.cmd` mogłoby osierocić potomka.

Stdout i stderr są przechwytywane strumieniowo. Limity znaków, linii i bajtów są niezależne. Po przekroczeniu zachowywany jest początek i koniec, dodawany jest marker pominięcia, a wynik ma `outputTruncated: true`. Licznik bajtów obejmuje pełne wyjście, także część pominiętą. Granice wielobajtowego UTF-8 nie tworzą uszkodzonych znaków.

## Architektura weryfikacji

```text
baseline przed zmianą
        │
        ▼
apply_changes → zmienione pliki → zakres/plan
        │                         │
        │                         ▼
        │              lint → typecheck → test → build
        │                         │
        ▼                         ▼
 checkpoint              diagnostyki i test summary
                                  │
                                  ▼
                         porównanie z baseline
                                  │
                    passed / failed / partial / unavailable
```

Plan wybiera najmniejszy bezpieczny zestaw:

- `changed_files` zawęża polecenia pakietowe według katalogów zmienionych plików;
- `affected_packages` powinien uwzględniać zależności i pakiety zależne; jeśli pełny graf nie jest dostępny, runtime konserwatywnie sprawdza cały workspace;
- `workspace` uruchamia wszystkie wykryte dozwolone kroki.

Weryfikacja kontynuuje niezależne kroki po błędzie, aby zebrać pełny raport. Abort zatrzymuje plan. Identyczna pełna weryfikacja jest blokowana, jeżeli zawartość projektu, zakres i lista kroków nie zmieniły się od poprzedniego uruchomienia.

## Baseline i regresje

Przy `AGENT_VERIFICATION_BASELINE=true` CLI wykonuje kontrolowaną weryfikację przed rozpoczęciem zadania. Baseline trafia do `.agent/baselines/<id>.json` i zawiera:

- identyfikator, czas i hash workspace,
- hashe plików źródłowych użyte do wykrywania nieaktualnego stanu,
- kroki bez pełnego stdout/stderr,
- znormalizowane diagnostyki i ich stabilne fingerprinty.

Katalogi runtime, VCS, zależności i artefakty (`.agent`, `.git`, `node_modules`, `dist`, `build`, `coverage`, `target` itd.) nie wpływają na hash źródeł. Baseline jest zapisywany przez plik tymczasowy i atomowe `rename`.

Po zmianie runtime porównuje fingerprint oraz lokalizację diagnostyki:

- identyczna diagnostyka → problem istniejący wcześniej;
- nowa diagnostyka → regresja;
- ten sam punkt z inną treścią → problem zmieniony i, dla błędu, regresja;
- brak wcześniejszej diagnostyki → problem rozwiązany.

Zmiany wykonane przez bieżący ChangeSet są dozwolone przy walidacji baseline. Inna zmiana pliku unieważnia baseline; runtime nie udaje wtedy precyzyjnego porównania.

## Automatyczna pętla naprawcza i rollback

Przy `AGENT_VERIFY_AFTER_APPLY=true` narzędzie `apply_changes` automatycznie uruchamia weryfikację. Wynik wraca do modelu jako dane runtime. Po błędzie model może przeanalizować diagnostykę, utworzyć nowy ChangeSet naprawczy, pokazać diff, zastosować go i ponowić weryfikację.

Licznik prób naprawy jest własnością runtime. Domyślny limit wynosi 3 i nie może zostać zmieniony przez model. Po jego osiągnięciu kolejne `apply_changes` zwraca `REPAIR_ATTEMPT_LIMIT`, a wynik sesji to `max_repair_attempts`.

Opcjonalne `AGENT_ROLLBACK_ON_VERIFICATION_FAILURE=true` przywraca checkpoint ChangeSet natychmiast po nieudanej weryfikacji. Domyślnie opcja jest wyłączona, aby zachować pliki do analizy i przygotowania poprawki.

Fazy ustalane przez runtime:

```text
analysis → baseline → planning → editing → preview → confirmation
→ applying → verification → repair → completed / failed / rolled_back
```

Możliwe wyniki obejmują `verification_passed`, `verification_failed`, `verification_unavailable`, `rolled_back`, `max_repair_attempts` i `command_limit_reached` obok wyników zmian z etapu 3.

## Narzędzia agenta

Nowe narzędzia tylko do odczytu:

- `detect_project_commands` — technologie, menedżer, polecenia dozwolone i blokowane;
- `get_command_history` — filtrowane metadane bez stdout, stderr i środowiska;
- `get_verification_report` — ostatni lub wskazany raport.

Narzędzia wykonawcze, gdy polityka na to pozwala:

- `run_project_command` — wyłącznie aktualny identyfikator z detekcji;
- `run_tests`, `run_linter`, `run_typecheck`, `run_build`, `run_formatter`;
- `run_verification` — kontrolowany plan i zakres.

Narzędzia odczytu workspace oraz transakcyjnych zmian z etapu 3 pozostają dostępne zależnie od trybu: odczyt plików, wyszukiwanie, mapa repozytorium, Git status, przygotowanie patchy, tworzenie/przenoszenie/usuwanie, preview, apply, checkpointy i restore.

Historia komend znajduje się w `.agent/history/commands.jsonl`. Zapisuje program, argumenty, kategorię, `cwd`, decyzję polityki, status, kod wyjścia, czas i informację o skróceniu. Nie zapisuje stdout, stderr, treści plików ani środowiska.

## `doctor`

```bash
npm run agent -- doctor
```

Diagnostyka sprawdza Node.js, dostępność Ollamy i modelu, workspace, Git, powłoki, menedżer pakietów, wykryte i blokowane komendy, możliwość utworzenia krótkiego procesu `node --version`, politykę sieci/instalacji oraz limity. Nie uruchamia pełnych testów, linta ani buildu projektu.

Przed każdym zwykłym uruchomieniem CLI pokazuje model, host Ollamy, workspace, tryb dostępu, stan wykonywania komend, politykę, sieć, instalację, automatyczną weryfikację i limit napraw. Przed procesem pokazuje rzeczywisty program, osobne argumenty, katalog i timeout; po nim status, kod wyjścia i czas.

## Konfiguracja etapu 4

Priorytet wartości:

```text
wbudowane → config/default.json → środowisko → flagi CLI
```

| Zmienna                                  |           Domyślnie |
| ---------------------------------------- | ------------------: |
| `AGENT_COMMAND_EXECUTION_ENABLED`        |              `true` |
| `AGENT_COMMAND_POLICY`                   |      `verification` |
| `AGENT_COMMAND_TIMEOUT_MS`               |            `120000` |
| `AGENT_TEST_TIMEOUT_MS`                  |            `300000` |
| `AGENT_BUILD_TIMEOUT_MS`                 |            `300000` |
| `AGENT_MAX_COMMAND_OUTPUT_CHARS`         |            `100000` |
| `AGENT_MAX_COMMAND_OUTPUT_LINES`         |              `5000` |
| `AGENT_MAX_COMMAND_OUTPUT_BYTES`         |           `1048576` |
| `AGENT_MAX_COMMANDS_PER_SESSION`         |                `30` |
| `AGENT_MAX_PARALLEL_COMMANDS`            |                 `1` |
| `AGENT_ALLOW_NETWORK`                    |             `false` |
| `AGENT_ALLOW_PACKAGE_INSTALL`            |             `false` |
| `AGENT_ALLOW_PACKAGE_SCRIPTS`            |              `true` |
| `AGENT_ALLOW_CUSTOM_COMMANDS`            |             `false` |
| `AGENT_ALLOW_FORMAT_COMMANDS`            |              `true` |
| `AGENT_ALLOW_ENV_OVERRIDES`              |             `false` |
| `AGENT_VERIFICATION_ENABLED`             |              `true` |
| `AGENT_VERIFICATION_BASELINE`            |              `true` |
| `AGENT_MAX_REPAIR_ATTEMPTS`              |                 `3` |
| `AGENT_VERIFY_AFTER_APPLY`               |              `true` |
| `AGENT_ROLLBACK_ON_VERIFICATION_FAILURE` |             `false` |
| `AGENT_VERIFICATION_SCOPE`               | `affected_packages` |

`AGENT_ALLOWED_ENV_VARS` zawiera listę nazw rozdzielonych przecinkami. Pełna konfiguracja odczytu i ChangeSet znajduje się w `.env.example` oraz `config/default.json`.

Flagi CLI `--verify`, `--no-verify`, `--baseline`, `--no-baseline` i `--verification-scope` mogą jedynie zawężać lub przełączać weryfikację. Nie włączają sieci, instalacji ani własnych komend.

## Statystyki i raport końcowy

Runtime, niezależnie od modelu, liczy:

- wykryte, wykonane, zablokowane, anulowane i przeterminowane polecenia;
- pełną liczbę bajtów wyjścia;
- uruchomienia i kroki weryfikacji;
- awarie, regresje i problemy wcześniejsze;
- próby naprawy;
- statystyki odczytu, ChangeSet, checkpointów i rollbacków z wcześniejszych etapów.

`AgentRunResult.verificationSummary` zawiera identyfikator raportu, status, liczbę kroków zaliczonych/niezaliczonych/pominiętych, liczbę nowych i wcześniejszych błędów oraz czas. Wynik końcowy pochodzi z raportu procesu, nie z deklaracji modelu.

## Rozwój i testy

```bash
npm run format:check
npm run typecheck
npm run lint
npm test
npm run build
```

Testy nie wymagają Ollamy, sieci ani instalowania zależności w fixtures. Używają tymczasowych katalogów i kontrolowanych procesów Node.js. Fixtures obejmują projekty Node.js, Python, Rust i projekt z niebezpiecznymi skryptami.

Zakres testów obejmuje platformy i resolvery, lockfile, politykę, środowisko, prawdziwy `spawn`, wrapper `.cmd`, stdin, timeout, `AbortSignal`, całe drzewo procesów, równoległość, UTF-8 i limity wyjścia, detekcję technologii, parsery Vitest/Jest/pytest/ESLint/TypeScript/Rust/Go/.NET, baseline, regresje, rzeczywisty `npm run`, narzędzia agenta, automatyczną weryfikację, limit napraw, statystyki i rollback.

## Ograniczenia

Agent nadal nie może:

- wykonywać dowolnych poleceń ani otwierać interaktywnej powłoki;
- instalować zależności lub używać sieci domyślnie;
- uruchamiać procesów jako administrator;
- uruchamiać watch, serwerów, deploy, release ani publish;
- wykonywać dowolnych operacji Git; jedynym wyjątkiem zdalnym jest zatwierdzony, kontrolowany fast-forward push dokładnej gałęzi tasku;
- bezpośrednio uruchamiać formattera modyfikującego poza ChangeSet;
- wykonywać merge, force push, usuwać remote branch, tworzyć forki, issue, release lub sterować workflow;
- edytować binariów i nieobsługiwanych kodowań.

Wykrywanie npm workspaces obsługuje obecnie proste wzorce `katalog/*`. Brak pełnego grafu zależności powoduje bezpieczne rozszerzenie `affected_packages` do całego workspace. Checkpointy nie są commitami Git. Oczyszczone środowisko i polityka offline ograniczają sieć, ale nie zastępują izolacji systemu operacyjnego dla potencjalnie złośliwego kodu testów.

Komendy `task publish` i `task pr ...` wymagają manifestu ukończonego zadania w `.agent/tasks/<taskId>/manifest.json` oraz istniejącego izolowanego worktree. Integracja remote nie tworzy worktree ani commitów i nie zastępuje warstwy zarządzania zadaniami.
