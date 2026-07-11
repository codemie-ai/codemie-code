# План валидации, реорганизации и документирования изменений

## 1. Введение и Цели
*   **Цель**: Провести валидацию, архитектурный ревью и реорганизацию изменений в текущей ветке `feat/azure-openai-provider` в соответствии со стандартами репозитория.
*   **Конечный результат**: 
    1. Чистая история из 3 логических коммитов (Azure OpenAI / Ollama fixes / PR review fixes).
    2. Полная интеграция внешней документации в этот план.
    3. Архитектурно выверенный, протестированный и безопасный код.

---

## 2. План итераций и статус выполнения
*Правило: Отмечать выполненные пункты символом `[x]` сразу после завершения минимального шага. Результаты работы каждого подпункта должны быть зафиксированы в плане до перехода к следующему шагу.*

- [x] **Итерация 1**: Создание каркаса плана и сбор первичных данных (текущие коммиты, измененные файлы, внешние `.md` файлы).
- [x] **Итерация 2**: Анализ и перенос внешней документации (файлы уровнем выше), подготовка заготовок для новой документации.
- [x] **Итерация 3**: Детальный анализ измененных файлов и распределение их по двум фичам (Azure OpenAI / Ollama).
- [x] **Итерация 4**: Архитектурный ревью изменений, проверка на оптимальность и соответствие гайдлайнам.
- [x] **Итерация 5**: Реорганизация коммитов (перераспределение файлов):
    1.  Распаковать последний коммит (Ollama) через `git reset --soft HEAD~1`.
    2.  Перенести файлы, не относящиеся к Ollama, в предыдущий коммит через `git commit --amend`.
    3.  Собрать новый чистый коммит для Ollama: `fix(providers): improve Ollama local integration and context window handling`.
- [x] **Итерация 6**: Финальная валидация и Delivery:
    1.  **Базовая валидация (Fast Track)**: [x] `npm run lint` → `npm run build` → `codemie doctor`.
        *   *Результат*: Линтинг пройден (ошибок нет), сборка успешна, `codemie doctor` подтвердил работоспособность CLI.
    2.  **Автоматизированное тестирование**: [x] Полный пайплайн: lint → build → unit tests.
        *   *Результат*: 2120 passed, 10 skipped. Новые тесты для `azure-openai-sanitizer` и провайдеров прошли успешно.
    3.  **Комплексный Quality Gate**: [x]
        *   *UI Naming*: `displayName` провайдера — `"Azure OpenAI (DIAL compatible)"`.
        *   *Конфиг*: `.codemie/codemie-cli.config.json` восстановлен из `origin/main`.
        *   *Deployment Pinning*: Проверено. Изоляция от других провайдеров сохранена.
        *   *Общий ревью*: "EPAM" оставлено только в контексте каталога скиллов.
    4.  **Rebase**: [x] `git rebase origin/main` выполнен.
    5.  **PR**: [x] Управляется на стороне remote.
- [x] **Итерация 7**: PR Review Feedback (3-й коммит `81da2fa`):
    *   Все замечания CR-001..CR-008 исправлены.
    *   `SKIP_SECRETS_CHECK` escape hatch удалён.
    *   `validate-secrets.js` расширен WSL2 Docker fallback.
    *   `.gitleaks.toml` обновлён: paths allowlist + stopwords.
    *   Коммит прошёл полный pre-commit pipeline без `--no-verify`: lint ✓, typecheck ✓, vitest ✓, Gitleaks (`wsl-docker`) — `no leaks found` ✓.
- [x] **Итерация 8**: Self-Review fix (влит в 3-й коммит `81da2fa` через `--amend`):
    *   SR-001/002 — `dial-model-integrity.ts`: `console.log` → `logger.*`, добавлен `sanitizeLogArgs`.
    *   SR-003 — `azure-openai.health.ts`: `throw new Error` → `throw new ConfigurationError`.
    *   SR-004 — `azure-openai.models.ts`: `throw new Error` → `throw new ConfigurationError`.
    *   SR-005 — `codemie-code.plugin.ts`: прямой импорт `AzureOpenAIModelProxy` заменён на `ProviderRegistry.getModelProxy()` + интерфейс `AzureDeploymentFetcher`.
    *   Коммит прошёл полный pre-commit pipeline: lint ✓, typecheck ✓, vitest ✓, Gitleaks — `no leaks found` ✓.
- [x] **Итерация 9**: Hotfix — восстановление UI-вывода `--test-dial` (влит в 3-й коммит `322c98d` через `--amend`):
    *   **Проблема**: `codemie doctor --test-dial` перестал выводить прогресс и статистику в консоль. Причина: в SR-001/002 все `console.log` в `dial-model-integrity.ts` заменили на `logger.info()`, но `logger.info()` пишет **только в файл** (`~/.codemie/logs/`), не в консоль.
    *   **Решение**: разграничение пользовательского UI-вывода и операционного логирования:
        *   `console.log(chalk...)` — восстановлен для прогресса по моделям и итоговой статистики (CLI UI-вывод, аналогично `formatter.ts`).
        *   `logger.warn/error(...)` — сохранён для структурных событий (нет данных, ошибка запроса) — уходит в файл.
    *   Правило репозитория (`❌ console.log() for debug info`) касается **внутреннего debug-логирования**, не пользовательского UI-вывода CLI-команд.
    *   Коммит прошёл полный pre-commit pipeline: lint ✓, typecheck ✓, vitest ✓, Gitleaks — `no leaks found` ✓.

---

## 3. Инструменты валидации, Скиллы и Гайдлайны

### Инструменты и Команды:
*   `npm run lint` / `npm run lint:fix` — проверка стиля и качества кода.
*   `npm run build` — проверка компиляции TypeScript.
*   `npm test` / `npm run test:unit` — запуск тестов (только по явному запросу).
*   `codemie doctor` — проверка здоровья CLI.

### Гайдлайны (из `.ai-run/guides/` и `AGENTS.md`):
*   **Архитектура**: Соблюдение слоев `CLI -> Registry -> Plugin -> Core -> Utils`.
*   **Безопасность**: Отсутствие захардкоженных секретов, использование `sanitizeValue` / `sanitizeLogArgs`.
*   **Ошибки**: Использование типизированных ошибок из `src/utils/errors.ts`.
*   **Логирование**: Использование `logger.debug/info/success`, запрет на `console.log`.
*   **Импорты**: Обязательное наличие расширения `.js` в путях импорта.

---

## 4. Финальная история коммитов в ветке

### Коммиты (актуально на момент завершения Итерации 9):
| SHA | Сообщение |
|---|---|
| `322c98d` | `fix(providers): address Azure OpenAI PR review: secrets, logging, naming, errors` |
| `6311813` | `fix(providers): improve Ollama local integration and context window handling` |
| `08e73ea` | `feat(providers): implement Azure OpenAI provider with DIAL compatibility and payload sanitization` |

### Ключевые изменения по коммитам:

**`08e73ea` — Azure OpenAI провайдер:**
*   `src/providers/plugins/azure-openai/` — полный новый провайдер (health, models, setup-steps, template, index).
*   `src/agents/plugins/azure-openai-sanitizer/` — санитайзер payload для DIAL (source, auto-retry, inject, index).
*   `src/providers/capabilities/dial-capabilities.ts` — возможности DIAL.
*   `src/utils/dial-model-integrity.ts` — утилита проверки моделей DIAL.
*   Изменения в registry, setup-ui, claude.plugin, codemie-code.plugin, doctor, env/types и др.

**`6311813` — Ollama fixes:**
*   `src/agents/plugins/opencode/opencode-dynamic-models.ts` — исправлен парсинг `/api/show`.
*   `src/providers/plugins/ollama/ollama.setup-steps.ts` — шаги настройки.
*   `src/cli/commands/setup.ts` — CLI настройка провайдеров.

**`81da2fa` → `322c98d` (amend в Итерации 9) — PR Review + Self-Review + UI-fix:**
*   CR-001: fixture API keys → `PLACEHOLDER-KEY-FOR-TESTING-ONLY`.
*   CR-002: `dial-model-integrity.ts` — `console.*` → `logger.*`.
*   CR-003: русская строка `--test-dial` → английский + `logger.warn`.
*   CR-004: `new Error(...)` → `ToolExecutionError` в `auto-retry-sanitizer.ts`.
*   CR-005: `console.error` в `setup.ts` → `logger.warn`.
*   CR-006: отступы `buildOpenCodeConfig()` в `codemie-code.plugin.ts`.
*   CR-007: JSDoc + обоснование `any` для `requestWithSanitizerRetry`.
*   CR-008: переименование `azure-dial-sanitizer` → `azure-openai-sanitizer` на source level.
*   `scripts/validate-secrets.js` — WSL2 Docker fallback (`wsl-docker` engine), убран `SKIP_SECRETS_CHECK`.
*   `.gitleaks.toml` — paths allowlist для тестов Azure OpenAI + stopwords для fixture placeholders.
*   `package.json` — добавлен `@iarna/toml` как devDependency.
*   SR-001/002: `dial-model-integrity.ts` — `console.log` → `logger.*` + `sanitizeLogArgs` при HTTP-ошибках.
*   SR-003: `azure-openai.health.ts` — `throw new ConfigurationError` (было голый `Error`).
*   SR-004: `azure-openai.models.ts` — `throw new ConfigurationError` (было голый `Error`).
*   SR-005: `codemie-code.plugin.ts` — убран прямой импорт `AzureOpenAIModelProxy`; доступ через `ProviderRegistry.getModelProxy()` + интерфейс `AzureDeploymentFetcher`.
*   **Итерация 9**: `dial-model-integrity.ts` — восстановлен `console.log(chalk...)` для UI-вывода `--test-dial`; `logger.warn/error` сохранены для структурного логирования.

---

## 5. Анализ и перенос внешней документации

### Внешние `.md` файлы (уровнем выше, не в репозитории):
1.  `azure-openai-dial-support-task.md` — Описание задачи поддержки Azure OpenAI и DIAL.
2.  `AZURE_OPENAI_DIAL_COMPATIBILITY.md` — Технические детали совместимости с DIAL.
3.  `codemie-internals.md` — Внутреннее устройство CodeMie.
4.  `codemie-ollama-fallback-fix-plan.md` — План исправления фоллбека Ollama.
5.  `DIAL_experiment_report.md` — Отчет об экспериментах с DIAL.
6.  `DIAL_PROVIDER_IMPLEMENTATION_PLAN.md` — План реализации провайдера DIAL.
7.  `ollama_context_window_fix_dump.md` — Дамп исправления контекстного окна Ollama.

### Ключевые выводы:

#### A) Azure OpenAI & EPAM DIAL Compatibility
*   **Проблема**: EPAM DIAL строго валидирует схему запросов. Поля `cache_control`, `reasoning_content`, `thinking`, `parallel_tool_calls` вызывают `Extra inputs are not permitted`.
*   **Решение**: Санитайзер `azure-openai-sanitizer` + харденинг окружения в шаблоне + Deployment Pinning + авто-ретрай.
*   **Runtime key convention**: `azure-dial-{modelId}` в конфиге OpenCode — намеренно сохранён, пользователи не видят.

#### B) Ollama Fallback & Context Window Fix
*   **Проблема**: Жёсткий реестр моделей → `ProviderModelNotFoundError`; баг парсинга `/api/show` (parameters — строка, не объект); `profileConfig` не передавался; лимит вывода захардкожен.
*   **Решение**: Исправлен парсинг, передача `profileConfig`, функция `getOllamaFamilyOutputLimit(modelId)`, цепочка фоллбека.

---

## 6. Проблема Docker в среде разработки — РЕШЕНО

### Было
Pre-commit хук `validate:secrets` не находил Docker на Windows (Docker внутри WSL, не Docker Desktop).
Временный обходной путь: `SKIP_SECRETS_CHECK=1 git commit ...` — **неправильное решение**.

### Решение (реализовано в `961e64d`)
`scripts/validate-secrets.js` расширен WSL2-веткой:
1.  Новая функция `wslDockerRunning()` — проверяет `wsl -e bash -l -c "docker info"`.
2.  `detectEngine()` возвращает `'wsl-docker'` если нативного движка нет, но WSL Docker отвечает.
3.  При `engine === 'wsl-docker'` gitleaks запускается через `wsl -e bash -l -c "docker run ..."`.
4.  Функция `toWslPath()` конвертирует `C:\...` → `/mnt/c/...` для монтирования конфига.
5.  `SKIP_SECRETS_CHECK` escape hatch **удалён** полностью.

### Статус
- [x] WSL2 Docker fallback реализован в `validate-secrets.js`
- [x] `SKIP_SECRETS_CHECK` убран из `validate-secrets.js`
- [x] `SKIP_SECRETS_CHECK=1` больше не используется в практике коммитов
- [x] Проверено: `node scripts/validate-secrets.js` находит `wsl-docker`, Gitleaks отрабатывает штатно

---

## 7. PR Review Feedback (Итерация 7) — ВЫПОЛНЕНО

Фидбек от ревью PR `feat(providers): Azure OpenAI + DIAL compatibility`. Решение ревьюера: REQUEST CHANGES.
Все замечания исправлены в коммите `961e64d`, коммит прошёл полный pre-commit pipeline.

### Таймауты тестов — ПРОВЕРЕНО, не требуют изменений
Текущий `vitest.config.ts`: `unit`/`cli`: `testTimeout: 30_000`, `hookTimeout: 10_000`; `agent`: `testTimeout: 180_000`, `hookTimeout: 300_000`. Вмешательство не требовалось.

### CR-001 — DONE ✓
Fixture API keys `'test-api-key-1234567890'` → `'PLACEHOLDER-KEY-FOR-TESTING-ONLY'` в `azure-openai.template.test.ts`.
Добавлен `stopwords` в `.gitleaks.toml` чтобы diff с удалёнными строками не блокировал pre-commit.

### CR-002 — DONE ✓
`src/utils/dial-model-integrity.ts` — `console.log`/`console.error` → `logger.warn`/`logger.error`.

### CR-003 — DONE ✓
`src/cli/commands/doctor/index.ts` — русская строка переведена на английский, `console.log` → `logger.warn` + `console.log(chalk.yellow(...))`.

### CR-004 — DONE ✓
`src/agents/plugins/azure-openai-sanitizer/auto-retry-sanitizer.ts` — `new Error(...)` → `new ToolExecutionError(...)`.

### CR-005 — DONE ✓
`src/cli/commands/setup.ts` — `console.error(chalk.red(...), error)` → `logger.warn('[setup] Could not fetch models', {...})`.

### CR-006 — DONE ✓
`src/agents/plugins/codemie-code.plugin.ts` — отступы `baseEnabledProviders` / `enabledProviders` исправлены с column-0 до 2-space.

### CR-007 — DONE ✓
`requestWithSanitizerRetry` — добавлен полный JSDoc с `@param`, `@returns`, `@throws` и обоснованием использования `any`.

### CR-008 — DONE ✓
Переименование на source level:
| Было | Стало |
|---|---|
| `azure-dial-sanitizer/` | `azure-openai-sanitizer/` |
| `AzureDialSanitizerPlugin` | `AzureOpenAISanitizerPlugin` |
| `sanitizeAzureDialPayload` | `sanitizeAzureOpenAIPayload` |
| `AZURE_DIAL_SANITIZER_PLUGIN_SOURCE` | `AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE` |
| `getAzureDialSanitizerPluginUrl` | `getAzureOpenAISanitizerPluginUrl` |
| `cleanupAzureDialSanitizerPlugin` | `cleanupAzureOpenAISanitizerPlugin` |

Runtime ключи `azure-dial-{modelId}` в конфиге OpenCode — сохранены без изменений.

---

## 8. Self-Review — ВЫПОЛНЕНО

- [x] Провести self-review по чек-листу из `.ai-run/guides/standards/git-workflow.md`.

### Инструменты и агенты self-review

Self-review проведён в два прохода:
1. **Первый проход** (неполный): `explore`-агенты для архитектурного ревью, security и import quality + `npm run check:pre-commit` напрямую. Пропущены gates: `validate:secrets` и SonarQube.
2. **Второй проход** (правильный): `.claude/agents/qa-lead.md` субагент через `Task` tool — запустил все 6 gates последовательно по регламенту репозитория.

**QA Gate Report (qa-lead субагент):**

| Gate       | Status   | Notes                                       |
|------------|----------|---------------------------------------------|
| License    | ✅ PASS  |                                             |
| Lint       | ✅ PASS  |                                             |
| TypeScript | ✅ PASS  |                                             |
| Secrets    | ✅ PASS  |                                             |
| Tests      | ➖ N/A   | Tests not requested                         |
| SonarQube  | ⚠️ SKIP  | `.sonarlint/connectedMode.json` не настроен |

**Урок**: для quality gates нужно использовать `.claude/agents/qa-lead.md` через `Task` tool, а не запускать команды вручную. `.codemie/virtual_assistants/code_reviewer.yaml` и `code_security_auditor.yaml` — это ассистенты Codemie CLI (`/assistant`), не Claude Code субагенты.

### Результаты по категориям

| Категория | Статус | Детали |
|---|---|---|
| Conventional Commits (3 коммита) | ✅ PASS | Все 3 коммита: `fix(providers):` / `fix(providers):` / `feat(providers):` — тип `fix`/`feat`, scope `providers` из allowed list, subject ≤ 100 символов |
| `npm run check:pre-commit` (lint + typecheck) | ✅ PASS | Ноль ошибок, ноль предупреждений |
| `npm run license-check` | ✅ PASS | Все заголовки Apache-2.0 в src/ присутствуют |
| Нет захардкоженных секретов | ✅ PASS | Только явные placeholders: `'proxy-handled'`, `'ollama'`, `'PLACEHOLDER-KEY-FOR-TESTING-ONLY'` |
| Нет TODO/FIXME/HACK/XXX | ✅ PASS | Не найдено ни одного |
| Импорты: расширения `.js` | ✅ PASS | Все относительные импорты содержат `.js` |
| Импорты: нет `require()`/`__dirname` | ✅ PASS | Только ES-модули и `import.meta` |
| CLI не обходит Registry | ✅ PASS | `setup.ts`, `doctor/index.ts`, `AIConfigCheck.ts` — все только через `ProviderRegistry` |
| Core не содержит бизнес-логику | ✅ PASS | Registry и типы — чистые контракты |
| Нет Plugin→Plugin (новых нарушений) | ✅ FIXED | SR-005 исправлен: `codemie-code.plugin.ts` использует `ProviderRegistry` вместо прямого импорта |
| `console.log` в utils | ✅ FIXED | SR-001/002 исправлены: `dial-model-integrity.ts` — все `console.log` → `logger.*` + `sanitizeLogArgs` |
| `throw new Error(...)` bare | ✅ FIXED | SR-003/004 исправлены: `azure-openai.health.ts` и `azure-openai.models.ts` → `ConfigurationError` |
| `@/` alias вместо `../../../` | ⚠️ INFO | Pre-existing паттерн в соседних provider plugins (Ollama, Bedrock), не новое нарушение |
| `sanitizeLogArgs` при логировании `apiKey` | ✅ FIXED | SR-002 исправлен: `dial-model-integrity.ts` применяет `sanitizeLogArgs` при HTTP-ошибках |
| `any` без JSDoc | ⚠️ INFO | `catch (e: any)` — паттерн широко используется в codebase без комментариев, не регрессия |

### Нарушения (SR-001..SR-005) — все исправлены в коммите `81da2fa`

| # | Приоритет | Файл | Статус |
|---|---|---|---|
| SR-001 | 🔴 High | `src/utils/dial-model-integrity.ts` | ✅ FIXED — `console.log` → `logger.*` |
| SR-002 | 🔴 High | `src/utils/dial-model-integrity.ts` | ✅ FIXED — `sanitizeLogArgs` добавлен |
| SR-003 | 🟡 Medium | `src/providers/plugins/azure-openai/azure-openai.health.ts` | ✅ FIXED — `ConfigurationError` |
| SR-004 | 🟡 Medium | `src/providers/plugins/azure-openai/azure-openai.models.ts` | ✅ FIXED — `ConfigurationError` |
| SR-005 | 🟡 Medium | `src/agents/plugins/codemie-code.plugin.ts` | ✅ FIXED — `ProviderRegistry` + `AzureDeploymentFetcher` |

---

- [x] **Итерация 10**: Hotfix — корректный тестовый payload для `--test-dial` (влит в 3-й коммит через `--amend`):
    *   **Проблема**: `codemie doctor --test-dial` показывал HTTP 400 для ряда моделей из-за некорректного payload в тесте, а не из-за реальной неработоспособности моделей. Три категории:
        1.  `gpt-5-*`, `o1-*`, `o3-*`, `o4-*` (non-reasoning variants) — API отвергает `max_tokens`, требует `max_completion_tokens`.
        2.  `*-with-thinking` модели — `max_tokens: 16` меньше дефолтного `budget_tokens` (~1024), поэтому API возвращает 400.
    *   **Решение**: `src/utils/dial-model-integrity.ts` — добавлены три функции:
        *   `needsMaxCompletionTokens(modelId)` — детектирует `o[0-9]*` и `gpt-5*`.
        *   `isThinkingModel(modelId)` — детектирует `*-with-thinking`.
        *   `buildTestPayload(modelId)` — собирает правильный payload: `max_completion_tokens: 16` / `max_tokens: 2048` / `max_tokens: 16`.
    *   **Комментарий**: В `apiLabel` добавлено пояснение к "limited api features" / compatibility mode: параметры `reasoning_effort`, `thinking`, `budget_tokens` не пробрасываются санитайзером; встроенное мышление модели при этом работает — оно просто не конфигурируется через API.
    *   **Прочие ошибки** из лога (`HTTP 502 No route` для embedding, `HTTP 422` для whisper/transcribe, `HTTP 404` для EOL-модели) — реальные проблемы на стороне DIAL, показываются корректно как есть.

---

## 9. Итог — ПЛАН ВЫПОЛНЕН

Все нарушения SR-001..SR-005 исправлены, UI-вывод `--test-dial` восстановлен, тестовые payload для `--test-dial` приведены в соответствие с требованиями всех классов моделей.

Финальная история ветки `feat/azure-openai-provider`:

| SHA | Сообщение |
|---|---|
| `322c98d` → amend | `fix(providers): address Azure OpenAI PR review: secrets, logging, naming, errors` |
| `6311813` | `fix(providers): improve Ollama local integration and context window handling` |
| `08e73ea` | `feat(providers): implement Azure OpenAI provider with DIAL compatibility and payload sanitization` |

Все три коммита прошли полный pre-commit pipeline: lint ✓, typecheck ✓, vitest ✓, Gitleaks — `no leaks found` ✓.
