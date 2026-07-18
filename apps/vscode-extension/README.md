# Local Code Agent for VS Code

Rozszerzenie uruchamia lokalny runtime agenta oraz udostępnia widoki `Agent Orchestration` i opcjonalny `GitHub`.

Tryb `Orchestrated` tworzy kontrolowany graf lokalnych specjalistów do planowania, analizy repozytorium, architektury, implementacji, testów, security i niezależnego review. Widok pokazuje stan sesji, węzły, agentów oraz wynik review. Plan i wynik wymagają osobnych poleceń `Approve orchestration`; model nie może wykonać zatwierdzenia. Specjaliści przygotowują ChangeSet, ale nigdy go nie stosują ani nie publikują.

Ustawienia `localCodeAgent.orchestration.*` kontrolują tryb domyślny, limity i widoczność aktywności. Krytyczne bramki planu, wyniku, security i niezależnego review są zawsze włączone; próba ustawienia ich na `false` jest ignorowana.

Integracja jest domyślnie wyłączona (`localCodeAgent.remote.enabled=false`). Komenda `Local Code Agent: Connect GitHub` korzysta z systemowej sesji `vscode.authentication`. Token jest przesyłany wyłącznie w pamięci do osobnego procesu runtime; nie trafia do Webview, ustawień ani logów. `SecretStorage` zawiera tylko nazwę ostatniego konta.

Widok GitHub pokazuje konto, zweryfikowane repozytorium, uprawnienia i powiązane Pull Request. Dostępne komendy pozwalają zweryfikować remote, opublikować dokładną gałąź ukończonego tasku, utworzyć Draft PR, odświeżyć checki, otworzyć PR oraz osobno zatwierdzić odpowiedź i rozwiązanie review thread.

Publikowanie gałęzi, tworzenie Pull Request i wysyłanie komentarzy są operacjami zewnętrznymi. Każda z nich wymaga jawnej decyzji użytkownika.

Agent nie wykonuje merge, force push ani usuwania zdalnych gałęzi. Ustawienia workspace próbujące włączyć te operacje są ignorowane; krytyczne wartości runtime pozostają zablokowane.

Treści issue, PR, review i logów CI są oznaczane jako niezaufane. Token nie jest przekazywany do modelu ani Webview.
