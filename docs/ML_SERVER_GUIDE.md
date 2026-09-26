# ML-сервер на Kotlin: пошаговая инструкция

Для кого: пишешь ML-сервер сам, с нуля, Kotlin знаешь слабо. **Готового кода здесь нет** — каждый шаг говорит,
что написать, что для этого почитать, где обычно спотыкаются и как проверить результат. Целиком даны только
настройки сборки (Gradle, Docker) и примеры JSON — это конфигурация и формат данных, а не то, чему ты учишься.

Связанные документы: [TZ_ML.md](TZ_ML.md) (что требуется от ML) · [ML_ARCHITECTURE.md](ML_ARCHITECTURE.md) ·
диаграмма агентного цикла [bpmn/05-agentnyj-cikl.bpmn](bpmn/05-agentnyj-cikl.bpmn).

---

## 0. Что мы строим и зачем

Отдельного ML-сервера (Spark) пока нет. Поэтому ML-сервер временно живёт на бесплатном сервере Сбера:
на нём работает **наш ML-сервис на Kotlin**, в нём хранится API-ключ внешней нейронки. Бэк общается только с ним.
В тексте ниже «шлюз» = этот ML-сервис, не отдельное звено.

```
Сейчас:  Бэк (ChatClient) ⇄ [сервер Сбера: ML-сервис на Kotlin + API-ключ] ⇄ API нейронки в интернете
Потом:   Бэк (ChatClient) ⇄ [Spark:        тот же ML-сервис            ] ⇄ vLLM с Qwen на этом же Spark
```

Внутри ML-сервиса:

```
  POST /v1/chat/completions (формат OpenAI)
        │
        ▼
  проверка ключа бэка → алиас → модель + промпт → лимиты, таймауты, выключатель
        → провайдер (адаптер к API нейронки) → убрать <think> → логи → ответ / поток SSE
```

Выбор нейронки: проще всего провайдер с **OpenAI-совместимым API и вызовом инструментов** — тогда нужен только
вариант А из шага 8. С российского IP не работают OpenAI и Anthropic; подходят, например, Cloud.ru Foundation Models
(есть Qwen — ближе всего к будущей модели на Spark), Yandex AI Studio (OpenAI-совместимый режим), GigaChat (свой формат,
нужен адаптер — вариант Б). Адреса и квоты сверить с документацией провайдера.

Ключевое решение: **шлюз говорит с бэком в формате OpenAI API** (`/v1/chat/completions`). Этот же формат у vLLM
на Spark и у Spring AI в бэке. Когда привезут Spark — меняется одна настройка провайдера в шлюзе, бэк не трогаем.

Что шлюз делает:
1. принимает запрос бэка (сообщения + список инструментов), проверяет ключ;
2. по имени модели-**алиаса** (`tpu-assistant`, `tpu-analyze`) подставляет реальную модель, системный промпт и параметры;
3. отправляет в провайдер (сейчас — внешнее API, для тестов — заглушка);
4. возвращает ответ: текст или «вызови инструмент X» (`tool_calls`), обычный или потоком;
5. следит за лимитами и сбоями, пишет логи без текста переписки.

Чего шлюз **не делает**: не вызывает инструменты (это делает ChatClient на бэке), не хранит историю и данные
пользователей, не ходит в сервисы ТПУ.

> ⚠ Пока модель внешняя — **не отправляй реальные данные студентов** (ФИО, оценки, письма). Только тестовые.

---

## 1. Подготовка (1 вечер)

1. **IntelliJ IDEA** Community. JDK отдельно ставить не обязательно — Gradle скачает сам (см. ниже).
2. Проект: https://start.ktor.io → Ktor 3.x, Gradle Kotlin DSL, движок Netty, плагины: *Content Negotiation*,
   *kotlinx.serialization*, *Authentication (Bearer)*, *Status Pages*, *Call Logging*, *Call ID*.
   Package: `ru.tpu.ml`. Скачать, открыть в IDEA. Генератор создаст файлы с примерами — **прежде чем что-то
   менять, пройди по ним и пойми, что делает каждая строка** (это и есть первое знакомство с Ktor).
3. Сверить `build.gradle.kts` (это настройка сборки, её можно брать как есть):

```kotlin
plugins {
    kotlin("jvm") version "2.2.0"
    kotlin("plugin.serialization") version "2.2.0"
    application
}

val ktor = "3.0.3"

application { mainClass.set("ru.tpu.ml.ApplicationKt") }
kotlin { jvmToolchain(21) }
repositories { mavenCentral() }

dependencies {
    // сервер
    implementation("io.ktor:ktor-server-core:$ktor")
    implementation("io.ktor:ktor-server-netty:$ktor")
    implementation("io.ktor:ktor-server-content-negotiation:$ktor")
    implementation("io.ktor:ktor-server-auth:$ktor")
    implementation("io.ktor:ktor-server-status-pages:$ktor")
    implementation("io.ktor:ktor-server-call-logging:$ktor")
    implementation("io.ktor:ktor-server-call-id:$ktor")
    implementation("io.ktor:ktor-serialization-kotlinx-json:$ktor")
    // клиент — чтобы ходить во внешнее API модели
    implementation("io.ktor:ktor-client-core:$ktor")
    implementation("io.ktor:ktor-client-cio:$ktor")
    implementation("io.ktor:ktor-client-content-negotiation:$ktor")
    // логи
    implementation("ch.qos.logback:logback-classic:1.5.12")
    // тесты
    testImplementation("io.ktor:ktor-server-test-host:$ktor")
    testImplementation("io.ktor:ktor-client-mock:$ktor")
    testImplementation(kotlin("test"))
}
```

**Проверенная связка версий:** Gradle **9.0.0** (или 8.14.3), Kotlin-плагин **2.2.0** (с 2.1 Gradle 9 не работает),
`jvmToolchain(21)`.

`settings.gradle.kts` обязателен, с плагином, который сам скачает JDK 21 для `jvmToolchain(21)`:

```kotlin
plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "0.10.0"
}
rootProject.name = "ml-server"
```

**На какой Java запускается сам Gradle.** `jvmToolchain(21)` выбирает Java только для компиляции и запуска кода.
Сам Gradle стартует раньше и берёт Java из `JAVA_HOME`/PATH; если там Java 8, Gradle 9 падает с ошибкой «Gradle requires JVM 17».
Чтобы не трогать `JAVA_HOME`, укажи Java для Gradle в файле `C:/Users/<ты>/.gradle/gradle.properties`
(действует на все проекты, не попадает в git):

```properties
org.gradle.java.home=C:/Users/<ты>/.gradle/jdks/eclipse_adoptium-21-amd64-windows.2
```

Путь — любой JDK 17+ на компьютере; установленные IntelliJ лежат в `.jdks`, скачанные Gradle — в `.gradle/jdks`.
Проверка: `./gradlew --version` → строка `Daemon JVM: ...adoptium-21... (from org.gradle.java.home)`.
В IntelliJ то же самое: Settings → Build Tools → Gradle → Gradle JVM.

### Что нужно знать из Kotlin (минимум)

Учебник — https://kotlinlang.org/docs/basic-syntax.html; для каждого понятия ниже там есть страница.
Упражняться удобно в https://play.kotlinlang.org — без проекта, прямо в браузере.

| Понятие | Что это | Где встретишь |
|---|---|---|
| `data class` | класс «только данные»: поля, `equals`, `copy()` | модели запросов/ответов |
| `@Serializable` | kotlinx.serialization умеет превратить класс в JSON и обратно | все модели API |
| `@SerialName("max_tokens")` | имя поля в JSON отличается от имени в Kotlin | snake_case OpenAI |
| `String?`, `?:`, `?.` | может быть `null`; «иначе»; «если не null» | необязательные поля |
| значения по умолчанию `= null` | поле можно не передавать | необязательные поля JSON |
| `suspend fun` | функция, которая может «ждать» (сеть), не блокируя поток | всё, что ходит в сеть |
| `Flow<T>` | поток значений во времени (`emit`, `collect`) | потоковый ответ модели |
| `interface` | контракт, у которого несколько реализаций | провайдеры моделей |
| `object` | единственный экземпляр (синглтон) | заглушка |
| `companion object` | «статические» функции класса | `Config.fromEnv()` |
| функция-расширение `fun Route.x()` | добавить функцию чужому классу | вынести маршруты в отдельный файл |
| `when` | `switch` на стероидах | выбор провайдера |
| `try / catch / finally` | обработка ошибок | выключатель, семафор |

Ktor: **плагин** (`install(...)`) — сквозная функция для всех запросов (JSON, авторизация, ошибки);
**маршрут** (`routing { get("/путь") { … } }`) — обработчик URL; `call` — текущий запрос и ответ.
Документация — https://ktor.io/docs/ (раздел Server для шлюза, раздел Client для шага 8).

### Как работать со шагами

1. Прочитай «Цель» и «Формат» — что должно получиться снаружи.
2. Открой ссылки из «Почитать» — там примеры из документации; пойми их, а не копируй.
3. Напиши по пунктам «Что написать». Имена функций Ktor в «Подсказках» — это то, что искать в документации.
4. Прогони «Проверку». Если упало — читай ошибку **снизу вверх до первой строки со своим пакетом `ru.tpu.ml`**
   и строку `Caused by:` — там причина. Красная подсветка в IDEA: наведи мышь, `Alt+Enter` предложит импорт.
5. Сделал шаг — коммит в git. Сломал следующий — всегда есть куда откатиться.

---

## 2. Структура проекта

```
ml-server/
├─ build.gradle.kts, settings.gradle.kts, Dockerfile
└─ src/
   ├─ main/kotlin/ru/tpu/ml/
   │   ├─ Application.kt            точка входа: плагины + маршруты
   │   ├─ config/Config.kt          настройки из переменных окружения
   │   ├─ api/Models.kt             формат OpenAI: запросы, ответы, куски потока, ошибки
   │   ├─ api/Routes.kt             /health, /v1/models, /v1/chat/completions
   │   ├─ core/ChatService.kt       главный конвейер: алиас → промпт → лимиты → провайдер → постобработка
   │   ├─ core/Aliases.kt           алиасы моделей и системные промпты
   │   ├─ core/ThinkFilter.kt       вырезает <think>…</think>
   │   ├─ core/Resilience.kt        очередь (семафор), таймауты, выключатель
   │   └─ providers/
   │       ├─ LlmProvider.kt        интерфейс
   │       ├─ MockProvider.kt       заглушка без модели — для бэка и тестов
   │       ├─ OpenAiCompatibleProvider.kt   vLLM, Cloud.ru, любое OpenAI-подобное API
   │       └─ GigaChatProvider.kt   если провайдер — GigaChat (адаптер формата)
   ├─ main/resources/
   │   ├─ aliases.json              алиасы: модель, промпт, параметры
   │   ├─ prompts/assistant.md      системный промпт помощника
   │   ├─ prompts/analyze.md        промпт «понять сообщение → JSON»
   │   └─ logback.xml
   └─ test/kotlin/ru/tpu/ml/        тесты
```

Правило зависимостей: `api` → `core` → `providers`. Провайдеры ничего не знают про HTTP-маршруты.

---

## 3. Шаги

Каждый шаг: **цель → почитать → что написать → подсказки и ловушки → проверка**. Не переходи дальше, пока проверка не прошла.

### Шаг 1. `/health` (полчаса)

**Цель:** сервер запускается и на `GET /health` отвечает JSON `{"status":"ok"}`.

**Почитать:** https://ktor.io/docs/server-create-and-configure.html (запуск через `embeddedServer`),
https://ktor.io/docs/server-routing.html, https://ktor.io/docs/server-serialization.html.

**Что написать** в `Application.kt`:
1. функцию `main`, которая запускает встроенный сервер на движке Netty. Порт — из переменной окружения `PORT`,
   если её нет — 8080. Серверу передаётся «модуль» — функция, где настраивается приложение;
2. модуль — функцию-расширение для `Application`. В ней: подключить плагин JSON-сериализации и описать маршруты;
3. маршрут `GET /health`, который отвечает объектом со статусом `ok`.

**Подсказки:** `embeddedServer`, `Netty`, `install(ContentNegotiation)`, `json()`, `routing`, `get`, `call.respond`.
Ответ можно собрать из `mapOf(...)` — его сериализатор уже умеет. Генератор start.ktor.io мог разложить плагины
по файлам `plugins/*.kt` — это нормально, можешь оставить так или собрать в один модуль.

**Ловушка:** если ответишь объектом своего класса без `@Serializable` — будет ошибка сериализации в момент запроса, а не при компиляции.

**Проверка:** `./gradlew run`, затем `curl.exe http://localhost:8080/health` → `{"status":"ok"}`
(в PowerShell — именно `curl.exe`: просто `curl` там другая команда; или открой адрес в браузере).

### Шаг 2. Настройки (полчаса)

**Цель:** все настройки берутся из переменных окружения, чтобы на сервере Сбера и на Spark был один и тот же jar.

**Почитать:** data class, `companion object`, `?:` (elvis), функция `error(...)` — в учебнике Kotlin; `System.getenv`.

**Что написать** в `config/Config.kt`:
1. `data class Config` с полями из таблицы;
2. в `companion object` — функцию `fromEnv()`, которая читает переменные и собирает `Config`;
3. маленькую вспомогательную функцию «прочитать переменную»: есть значение — вернуть; нет, но есть
   значение по умолчанию — вернуть его; нет ничего — остановить запуск с сообщением «Не задана переменная окружения X».

| Поле | Переменная | По умолчанию | Тип |
|---|---|---|---|
| `port` | `PORT` | 8080 | Int |
| `backendApiKey` — ключ, с которым приходит бэк | `ML_API_KEY` | **нет, обязательна** | String |
| `provider` | `ML_PROVIDER` | `mock` (`mock` / `openai` / `gigachat`) | String |
| `upstreamUrl` — адрес API нейронки | `UPSTREAM_URL` | нет | String? |
| `upstreamKey` — ключ API нейронки | `UPSTREAM_KEY` | нет | String? |
| `maxConcurrent` — одновременных запросов к модели | `ML_MAX_CONCURRENT` | 8 | Int |
| `requestTimeoutMs` | `ML_TIMEOUT_MS` | 60000 | Long |

4. В `main` первой строкой получить конфиг, порт брать из него, а сам конфиг передать в модуль
   (модуль станет принимать параметр — подумай, как передать модуль-лямбду, которая вызывает его с конфигом).

**Ловушки:** не печатай ключи в лог даже при старте; `toInt()` на мусоре падает — для начала это нормально.

**Проверка** (PowerShell): без переменной — `./gradlew run` падает с твоим сообщением;
`$env:ML_API_KEY="test"; $env:PORT="9000"; ./gradlew run` → сервер на 9000.

### Шаг 3. Модели формата OpenAI (1 вечер) — самый важный шаг

**Цель:** описать JSON, которым обмениваются бэк и шлюз, как Kotlin-классы, чтобы Ktor сам превращал JSON в объекты и обратно.

**Почитать:** https://kotlinlang.org/docs/serialization.html и
https://github.com/Kotlin/kotlinx.serialization/blob/master/docs/basic-serialization.md (разделы про
`@SerialName`, необязательные поля, значения по умолчанию), там же `json.md` — настройки `Json { … }` и `JsonElement`.

**Формат** — это спецификация, по ней и пишешь классы. Запрос бэка:

```json
{
  "model": "tpu-assistant",
  "messages": [
    {"role": "system", "content": "Пользователь: студент, группа 8К31"},
    {"role": "user", "content": "Что у меня завтра?"}
  ],
  "tools": [{
    "type": "function",
    "function": {
      "name": "rasp_day",
      "description": "Пары группы на дату",
      "parameters": {"type": "object", "properties": {"date": {"type": "string"}}, "required": ["date"]}
    }
  }],
  "stream": false,
  "temperature": 0.2,
  "max_tokens": 800
}
```

Ответ «вызови инструмент»:

```json
{
  "id": "chatcmpl-1", "object": "chat.completion", "created": 1790000000, "model": "tpu-assistant",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant", "content": null,
      "tool_calls": [{"id": "call_1", "type": "function",
                      "function": {"name": "rasp_day", "arguments": "{\"date\":\"2026-09-27\"}"}}]
    },
    "finish_reason": "tool_calls"
  }],
  "usage": {"prompt_tokens": 120, "completion_tokens": 18, "total_tokens": 138}
}
```

Следующий запрос бэка — с результатом инструмента (в `messages` добавились два сообщения):

```json
{"role": "assistant", "content": null, "tool_calls": [ …тот же вызов call_1… ]},
{"role": "tool", "tool_call_id": "call_1", "content": "[{\"time\":\"8:30\",\"subject\":\"Матанализ\",\"room\":\"10-202\"}]"}
```

Ответ текстом — как выше, но `"message": {"role": "assistant", "content": "Завтра три пары: …"}` и `"finish_reason": "stop"`.

Кусок потока (шаг 7) — у него `object: "chat.completion.chunk"`, а вместо `message` — `delta` с частью текста:

```json
{"id": "chatcmpl-1", "object": "chat.completion.chunk", "created": 1790000000, "model": "tpu-assistant",
 "choices": [{"index": 0, "delta": {"content": "Завтра "}, "finish_reason": null}]}
```

Если модель в потоке вызывает инструмент, в `delta` приходит `tool_calls` — у каждого элемента есть ещё `index`,
а `id`, `name`, `arguments` могут приходить частями.

Ошибка: `{"error": {"message": "Неизвестная модель: gpt-4", "type": "invalid_request_error"}}`.

**Что написать** в `api/Models.kt`:
1. общий настроенный `Json` (назови `AppJson`) с тремя опциями — найди их в `json.md` и пойми, зачем каждая:
   - игнорировать неизвестные поля — бэк может прислать поля, которых у нас нет, и мы не должны падать;
   - не писать `null`-поля в ответ;
   - писать значения по умолчанию (иначе потеряется `"object": "chat.completion"`);
2. `@Serializable data class` на каждый объект из примеров:

| Класс | Поля |
|---|---|
| `ChatRequest` | `model`, `messages`, `tools`, `tool_choice`, `stream`, `temperature`, `max_tokens`, `response_format` |
| `ChatMessage` | `role`, `content`, `tool_calls`, `tool_call_id` |
| `ToolDef` / `FunctionDef` | `type`, `function` / `name`, `description`, `parameters` |
| `ToolCall` / `FunctionCall` | `id`, `type`, `function` / `name`, `arguments` |
| `ChatResponse`, `Choice`, `Usage` | по примеру ответа |
| `ChatChunk`, `ChunkChoice`, `Delta` | по примеру куска потока |
| `ToolCallDelta`, `FunctionCallDelta` | как `ToolCall`, но + `index`, и все поля необязательные |
| `ErrorBody`, `ErrorInfo` | `error` / `message`, `type`, `code` |

3. В шаге 1 заменить `json()` на `json(AppJson)` — теперь сервер использует твои настройки.

**Правила и ловушки:**
- поля в `snake_case` (`max_tokens`, `tool_calls`, `finish_reason`…) называешь по-котлиновски (`maxTokens`) и ставишь `@SerialName`;
- `object` — ключевое слово Kotlin, поле назови иначе и поставь `@SerialName("object")`;
- **`arguments` — строка с JSON внутри, не объект.** Сделаешь объектом — Spring AI на бэке не разберёт ответ;
- всё, чего в каком-то сообщении может не быть, — тип с `?` и `= null` (`content` у вызова инструмента — `null`);
- `parameters`, `tool_choice`, `response_format` мы не разбираем, а пересылаем как есть — для них тип «любой JSON» (`JsonObject` / `JsonElement`);
- имя инструмента в API — только латиница, цифры, `_` и `-`: `rasp.day` из каталога передаётся как `rasp_day`.

Как выглядит цикл с инструментом (это надо понимать, иначе дальше будет сложно):

```
1. бэк → шлюз:  messages=[system, user:"что у меня завтра?"], tools=[rasp_day]
2. шлюз → бэк:  message={role:assistant, tool_calls:[{id:"call_1", function:{name:"rasp_day", arguments:"{\"date\":\"2026-09-27\"}"}}]}
                finish_reason="tool_calls"
3. бэк сам вызывает MCP rasp_day, затем снова → шлюз:
                messages=[system, user, assistant(tool_calls call_1), {role:tool, tool_call_id:"call_1", content:"[пары…]"}]
4. шлюз → бэк:  message={role:assistant, content:"Завтра три пары: …"}, finish_reason="stop"
```

**Проверка:** тест (шаг 13): взять пример запроса выше строкой → `AppJson.decodeFromString<ChatRequest>(…)` →
обратно в строку → поля на месте, `arguments` осталось строкой, `null`-полей в выводе нет.

### Шаг 4. Ключ бэка (полчаса)

**Цель:** шлюзом может пользоваться только бэк — он присылает заголовок `Authorization: Bearer <ML_API_KEY>`.

**Почитать:** https://ktor.io/docs/server-bearer-auth.html.

**Что написать:**
1. класс-«принципал» (кто вошёл) — достаточно одного поля с именем;
2. подключить плагин аутентификации с bearer-провайдером под именем `backend`: если токен совпал с `config.backendApiKey` —
   вернуть принципала, иначе `null` (Ktor сам ответит 401);
3. `/health` оставить **снаружи** защиты (его опрашивает мониторинг), всё остальное — внутри блока `authenticate("backend")`.

**Ловушка:** сравнивать ключи через `==` можно, но правильнее `MessageDigest.isEqual(...)` — время сравнения не зависит
от того, сколько символов совпало (защита от подбора по времени).

**Проверка:** запрос без ключа → 401, с `-H "Authorization: Bearer test"` → проходит.

### Шаг 5. Провайдер-заглушка (1 вечер)

**Цель:** шлюз отвечает «как модель», но без модели. Нужно, чтобы **бэк начал интеграцию сразу**, не дожидаясь внешнего API, и для тестов.

**Почитать:** `interface`, `object`, `when` — учебник Kotlin; https://kotlinlang.org/docs/flow.html (построитель `flow { }`, `emit`).

**Что написать:**
1. `providers/LlmProvider.kt` — интерфейс с тремя членами:
   - `name` — строка для логов и `/health`;
   - `complete` — принимает `ChatRequest`, возвращает `ChatResponse`, `suspend` (будет ждать сеть);
   - `stream` — принимает `ChatRequest`, возвращает `Flow<ChatChunk>`. Сама функция **не** `suspend`:
     `Flow` ничего не делает, пока его не начнут читать (`collect`), ожидание происходит внутри него.
2. `providers/MockProvider.kt` — `object`, реализующий интерфейс. Правила `complete`:
   - последнее сообщение с ролью `tool` → текст «По данным инструмента: <первые 200 символов content>»;
   - в последнем сообщении пользователя есть «распис» и в `tools` есть `rasp_day` → ответ с `tool_calls`
     (`id` = `call_1`, имя `rasp_day`, `arguments` = строка `{"date":"2026-09-27"}`), `content` = `null`;
   - иначе → «Заглушка: вы написали „…“».

   Остальные поля ответа: `id` — `"mock-"` + что-то уникальное; `created` — **секунды** (не миллисекунды);
   `model` — как в запросе; `finish_reason` — `tool_calls`, если есть вызов, иначе `stop`; `usage` — нули.
3. `stream` в заглушке: получить готовый ответ через `complete`, затем выдать куски — первый с `delta.role = "assistant"`,
   дальше текст по 10 символов, последний — пустая `delta` и `finish_reason`. Для вызова инструмента — один кусок
   с целым `tool_calls` (не забудь `index = 0`) и `finish_reason = "tool_calls"`.

**Подсказка:** между кусками `delay(50)` — тогда в шаге 7 будет видно, что поток действительно идёт по кускам.

**Проверка:** юнит-тест на три правила `complete` (шаг 13).

### Шаг 6. `/v1/chat/completions` без потока (полвечера)

**Цель:** бэк отправляет запрос и получает ответ заглушки.

**Почитать:** https://ktor.io/docs/server-requests.html (`call.receive`),
https://ktor.io/docs/server-routing.html — раздел про группировку маршрутов в функции-расширения.

**Что написать:**
1. `core/ChatService.kt` — класс, который получает провайдер в конструкторе. Методы `complete` и `stream` пока просто
   передают запрос провайдеру. Здесь позже появятся алиасы, лимиты и постобработка — поэтому маршруты не зовут провайдер напрямую;
2. `api/Routes.kt` — функция-расширение для `Route`, которая описывает маршруты, и подключить её внутри `authenticate("backend")`:
   - `GET /v1/models` → `{"object":"list","data":[{"id":"tpu-assistant","object":"model"},{"id":"tpu-analyze","object":"model"}]}`;
   - `POST /v1/chat/completions` → прочитать тело как `ChatRequest`; если `stream = true` — шаг 7, иначе ответить результатом `chatService.complete`.
3. В `main`: выбрать провайдер по `config.provider` (пока есть только заглушка) и создать `ChatService`.

**Подсказка:** экранировать JSON в командной строке PowerShell мучительно. Положи тело в файл `req.json` и отправляй так:
```bash
curl.exe -s http://localhost:8080/v1/chat/completions -H "Authorization: Bearer test" -H "Content-Type: application/json" --data-binary "@req.json"
```

**Проверка:** `{"model":"tpu-assistant","messages":[{"role":"user","content":"привет"}]}` → `choices[0].message.content`;
пример запроса из шага 3 с «расписание» в тексте → `tool_calls`.

### Шаг 7. Потоковый ответ SSE (1 вечер)

**Цель:** ответ «печатается» — бэк просит `"stream": true` и получает куски по мере готовности.

**Формат** (Server-Sent Events): каждая строка — `data: ` + JSON-кусок из шага 3, после каждой пустая строка, в конце `[DONE]`:

```
data: {"id":"chatcmpl-1","object":"chat.completion.chunk",…,"choices":[{"index":0,"delta":{"role":"assistant"}}]}

data: {…,"choices":[{"index":0,"delta":{"content":"Завтра "}}]}

data: {…,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

```

**Почитать:** https://ktor.io/docs/server-responses.html (ответ «писателем» — `respondTextWriter`), `collect` у Flow.
Есть и готовый плагин https://ktor.io/docs/server-server-sent-events.html — можно им, но с `respondTextWriter`
проще контролировать точный формат.

**Что написать** (ветка `stream = true` в маршруте):
1. заголовок `Cache-Control: no-cache`;
2. ответ с типом `text/event-stream`, внутри которого читаешь `chatService.stream(req)` и каждый кусок пишешь по формату выше;
3. после последнего куска — `data: [DONE]`.

**Ловушки:**
- после каждой записи — `flush()`, иначе всё придёт одной пачкой в конце;
- кодируй через `AppJson`, а не «голый» `Json` — иначе в куски попадут `null`-поля;
- если ошибка случилась посреди потока, код ответа уже не поменять (заголовки ушли) — запиши кусок `data: {"error":{…}}` и закончи поток.

**Проверка:** `curl.exe -N …` с `"stream": true` — строки появляются по одной, последняя `data: [DONE]`.

### Шаг 8. Настоящий провайдер (1–2 вечера)

**Цель:** шлюз ходит в настоящую нейронку.

**Почитать** (раздел Client): https://ktor.io/docs/client-create-and-configure.html,
https://ktor.io/docs/client-serialization.html, https://ktor.io/docs/client-timeout.html,
https://ktor.io/docs/client-bearer-auth.html (нам хватит простого заголовка — функция `bearerAuth`),
https://ktor.io/docs/client-responses.html (раздел про потоковое чтение ответа).

**Вариант А — OpenAI-совместимое API** (vLLM на Spark, Cloud.ru Foundation Models, другие): запрос почти пересылается как есть.

**Что написать:**
1. **один** `HttpClient` на всё приложение (движок CIO), создаётся в `main`: JSON через `AppJson`; таймауты —
   соединение 5 с, запрос — `config.requestTimeoutMs`, тишина в сокете 30 с;
2. исключение `UpstreamException` с HTTP-кодом нейронки и сообщением — им провайдер сообщает «API ответило ошибкой»;
3. `providers/OpenAiCompatibleProvider.kt` — класс с `baseUrl`, `apiKey` (может не быть) и клиентом:
   - `complete`: `POST {baseUrl}/chat/completions`, заголовок с ключом (если он есть), тело — запрос с `stream = false`
     (сделай копию запроса с изменённым полем — `copy()` у data class). Ответ не 2xx → `UpstreamException` с кодом и
     первыми 300 символами тела. Иначе — разобрать тело как `ChatResponse`;
   - `stream`: то же с `stream = true`, но ответ читать **построчно по мере прихода**: строки, не начинающиеся с `data:`,
     пропускать; убрать префикс; `[DONE]` → закончить; остальное разобрать как `ChatChunk` и отдать в свой `Flow`;
4. в `main` выбрать провайдер по `config.provider` через `when`: `mock` → заглушка, `openai` → этот класс.

**Подсказки:** `HttpClient(CIO)`, `install(HttpTimeout)`, `post`, `preparePost(...).execute { }`, `bodyAsChannel()`,
`readUTF8Line()`, `status.isSuccess()`, `body<T>()`, `bodyAsText()`.

**Ловушки:**
- у сервера и клиента плагин называется одинаково — `ContentNegotiation`; в одном файле импортируй один из них под другим
  именем (`import … as ClientContentNegotiation`);
- обычный `post` дочитывает ответ целиком — для потока нужен `preparePost(...).execute { }`;
- договорись, где `/v1`: в `UPSTREAM_URL` (`http://spark:8000/v1`) или в коде — и запиши в README;
- ключ нейронки — только в `UPSTREAM_KEY`, в код и git не попадает.

**Проверка:** с настоящим ключом запрос из шага 6 возвращает ответ модели, пример из шага 3 — `tool_calls`;
с неверным ключом — ошибка, в которой видно код нейронки (401/403).

**Вариант Б — GigaChat.** Формат отличается от OpenAI, поэтому `GigaChatProvider` — **адаптер**: переводит наш
формат в формат GigaChat и обратно. Отличия (сверить с документацией developers.sber.ru перед началом):

| | OpenAI (наш формат) | GigaChat |
|---|---|---|
| Авторизация | постоянный ключ | OAuth-токен на 30 мин: `POST https://ngw.devices.sberbank.ru:9443/api/v2/oauth`, заголовки `Authorization: Basic <ключ авторизации>`, `RqUID: <uuid>`, тело `scope=GIGACHAT_API_PERS` (или `_CORP`) |
| Адрес | `…/chat/completions` | `https://gigachat.devices.sberbank.ru/api/v1/chat/completions` |
| Инструменты в запросе | `tools: [{type, function:{…}}]` | `functions: [{name, description, parameters}]` |
| Вызов в ответе | `tool_calls: [{id, function:{name, arguments: "<строка JSON>"}}]` | `function_call: {name, arguments: {объект}}` |
| Результат инструмента | `{role:"tool", tool_call_id, content}` | `{role:"function", name, content}` |
| Сертификат | обычный | нужен корневой сертификат Минцифры в truststore JVM |

Что писать в адаптере:
1. `TokenCache`: хранит токен и время истечения, обновляет за минуту до конца (`Mutex`, чтобы два запроса не обновляли одновременно).
2. `toGiga(req)`: `tools` → `functions`; сообщения `role=tool` → `role=function` с `name` (имя берёшь из предыдущего `tool_calls` по `tool_call_id`).
3. `fromGiga(resp)`: `function_call` → `tool_calls` с придуманным `id` (`"call_" + UUID`) и `arguments` → строка (закодировать объект в JSON-строку).
4. Поток — тот же SSE, но с `function_call` в дельте; для начала поток можно делать «одним куском», а честный стрим — потом.

### Шаг 9. Алиасы и промпты (1 вечер) — «обработка промптов»

**Цель:** бэк не знает, какая сейчас модель и какой у неё системный промпт. Он шлёт `model: "tpu-assistant"`,
шлюз подставляет всё остальное.

Файл `resources/aliases.json` (это данные, не код):

```json
{
  "tpu-assistant": { "model": "GigaChat-2-Max", "prompt": "prompts/assistant.md", "temperature": 0.2, "maxTokens": 800,  "thinking": false },
  "tpu-analyze":   { "model": "GigaChat-2-Pro", "prompt": "prompts/analyze.md",   "temperature": 0.0, "maxTokens": 300,  "json": true }
}
```

Когда переедете на Spark — меняется только `"model": "Qwen/Qwen3-30B-A3B-FP8"`.

**Что написать** в `core/Aliases.kt`:
1. класс настроек алиаса (поля как в JSON) и загрузку файла при старте: файл из ресурсов → `Map<String, …>`; промпты
   прочитать один раз и держать в памяти (ресурсы читаются через `this::class.java.getResource(...)`);
2. функцию `resolve(req)`, которая возвращает новый запрос для провайдера:
   1. найти алиас по `req.model`, иначе ошибка 400 «неизвестная модель»;
   2. в промпте подставить переменные `{{date}}`, `{{weekday}}`, `{{org}}`;
   3. **в начало** `messages` поставить этот системный промпт; системные сообщения бэка (контекст: группа, роль) — сразу после него;
   4. `model` заменить на реальное имя; `temperature`, `max_tokens` — из алиаса, если бэк не прислал свои
      (а `max_tokens` бэка не может превысить алиас);
   5. `json: true` → добавить `response_format: {"type":"json_object"}` (если провайдер умеет) и в промпт — «ответь одним JSON»;
3. в `ChatService` вызывать `resolve` перед провайдером; в ответе бэку вернуть `model` = алиас, а не реальное имя;
4. `/v1/models` строить из списка алиасов.

В промпт `assistant.md` — роль, правила (отвечать по данным инструментов, не выдумывать, по-русски, коротко),
что делать, если инструмент вернул ошибку. **Версия промпта** — первой строкой (`# v3 · 26.09`) и в логах.

**Проверка:** тест: запрос с `model: "tpu-assistant"` → у провайдера первым сообщением стоит промпт, `model` — реальное имя;
`model: "gpt-4"` → 400.

### Шаг 10. Постобработка ответа (полвечера)

- **`<think>…</think>`** (рассуждения Qwen3 и похожих моделей) — вырезать. В обычном ответе — регулярным выражением
  (подумай, почему нужен «нежадный» вариант `.*?` и флаг, чтобы точка ловила перевод строки). В потоке — маленький автомат
  `ThinkFilter`: получает кусок текста, возвращает то, что можно показать; пока внутри `<think>` — копит и ничего не отдаёт.
  Учти, что тег может прийти разорванным между кусками (`<thi` + `nk>`): хвост куска, похожий на начало тега, придержи до следующего.
- **JSON-режим**: если алиас `json: true`, проверить, что `content` парсится как JSON; если нет — один повтор с
  припиской «верни только JSON», потом ошибка 502.
- **Аргументы инструментов**: проверить, что `arguments` — валидный JSON. Если модель прислала мусор — вернуть
  бэку как есть не надо: один повтор, потом ответ текстом «не удалось выполнить действие».

**Проверка:** тесты `ThinkFilter` из шага 13.

### Шаг 11. Надёжность (1–2 вечера)

**Цель:** модель медленная или упала — шлюз не зависает, не копит бесконечную очередь и честно отвечает ошибкой.

**Почитать:** https://kotlinlang.org/api/kotlinx.coroutines/kotlinx-coroutines-core/kotlinx.coroutines.sync/-semaphore/
(семафор), `withTimeoutOrNull` в документации корутин, `AtomicInteger` (счётчик из многих корутин сразу),
https://ktor.io/docs/server-status-pages.html.

**Что написать** в `core/Resilience.kt` — класс с одной функцией-обёрткой: принимает `suspend`-блок (вызов провайдера)
и выполняет его под защитой:
1. **выключатель открыт** (запомненное «до какого времени не ходить к модели» ещё не наступило) → сразу `OverloadedException` «модель временно недоступна»;
2. **очередь**: взять разрешение семафора (на `maxConcurrent` мест), ждать не дольше 10 с; не дождался → `OverloadedException` «очередь переполнена»;
3. выполнить блок; успех → счётчик ошибок подряд обнулить;
4. `UpstreamException` или таймаут → счётчик +1; дошёл до 5 → открыть выключатель на 60 с и обнулить счётчик; исключение пробросить дальше;
5. в `finally` вернуть разрешение семафору — **только если его взяли**.

Правила повторов:
- `complete` — один повтор при 5xx/таймауте провайдера; при 4xx — без повтора;
- поток — без повторов (часть ответа уже ушла); для потока разрешение держится, пока поток не закончится.

Ошибки → формат OpenAI через плагин `StatusPages` (на каждое исключение — свой код и `ErrorBody`):

| Исключение | HTTP | `error.type` |
|---|---|---|
| тело не парсится, неизвестный алиас | 400 | `invalid_request_error` |
| нет/неверный ключ | 401 | `authentication_error` |
| `OverloadedException` | 503 | `overloaded` |
| таймаут | 504 | `timeout` |
| `UpstreamException` | 502 | `upstream_error` |

`/health` отдаёт ещё `provider`, `circuit: closed|open`, `inFlight` — бэк и консоль оператора будут это показывать.

**Ловушки:** обычный `var` для счётчика из параллельных запросов считает неверно; `CancellationException` (бэк оборвал
запрос) — не ошибка модели, её не считать и не глушить.

**Проверка:** `ML_MAX_CONCURRENT=1` и `delay` в заглушке — второй параллельный запрос ждёт первого;
`UPSTREAM_URL` на несуществующий адрес — 5 запросов дают 502, шестой сразу 503, через минуту снова пробует.

### Шаг 12. Логи (полвечера)

**Почитать:** https://ktor.io/docs/server-call-id.html, https://ktor.io/docs/server-call-logging.html.

`CallId` — берёт `X-Request-Id` от бэка или создаёт свой, кладёт в каждую строку лога. На каждый запрос одна строка:
`requestId, alias, model, provider, stream, tools=N, toolCalls=M, promptTokens, completionTokens, ms, status`.
**Никогда не логируй `messages` и `content`** — там переписка студентов.

### Шаг 13. Тесты (параллельно с шагами)

**Почитать:** https://ktor.io/docs/server-testing.html (`testApplication`), https://ktor.io/docs/client-testing.html (`MockEngine`).

- **сериализация**: пример запроса из шага 3 (JSON-строка) → `ChatRequest` → обратно; `arguments` остаётся строкой;
- **маршруты**: `testApplication { … }` с `MockProvider`: 401 без ключа; обычный ответ; ответ с `tool_calls`; поток заканчивается `[DONE]`;
- **провайдер**: `HttpClient(MockEngine)` отдаёт заготовленный ответ внешнего API — проверяешь разбор и ошибки;
- **ThinkFilter**: тег разорван между кусками; несколько блоков подряд;
- **GigaChat-адаптер**: `tools` ↔ `functions`, `tool` ↔ `function`, `arguments` объект ↔ строка.

Команда: `./gradlew test`.

### Шаг 14. Сборка и запуск на сервере (1 вечер)

Dockerfile — конфигурация сборки, его можно брать как есть:

```dockerfile
FROM gradle:8-jdk21 AS build
WORKDIR /src
COPY . .
RUN gradle installDist --no-daemon

FROM eclipse-temurin:21-jre
COPY --from=build /src/build/install/ml-server /app
EXPOSE 8080
HEALTHCHECK CMD curl -fsS http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["/app/bin/ml-server"]
```

```bash
docker build -t ml-server .
docker run -d --name ml-server -p 8080:8080 --restart unless-stopped \
  -e ML_API_KEY=... -e ML_PROVIDER=gigachat -e UPSTREAM_KEY=... ml-server
```

На сервере: порт 8080 открыть **только для IP бэка** (firewall), ключи — через переменные окружения, не в коде и не в git.

---

## 4. Контракт с бэком (отдать команде бэка)

| | |
|---|---|
| Адрес | `http://<ml-сервер>:8080` |
| Авторизация | `Authorization: Bearer <ML_API_KEY>` |
| `POST /v1/chat/completions` | формат OpenAI; `model` — алиас (`tpu-assistant`, `tpu-analyze`); `tools` — разрешённые инструменты; `stream` — true/false |
| `GET /v1/models` | список алиасов |
| `GET /health` | `{status, provider, circuit, inFlight}` — без ключа |
| Ошибки | формат OpenAI `{error:{message,type}}`, коды 400/401/502/503/504 |
| Трассировка | заголовок `X-Request-Id` пробрасывается в логи |

Настройка бэка на Spring AI (OpenAI-стартер) — шлюз для него выглядит как OpenAI:

```properties
spring.ai.openai.base-url=http://ml-server:8080
spring.ai.openai.api-key=${ML_API_KEY}
spring.ai.openai.chat.options.model=tpu-assistant
```

Когда привезут Spark: в шлюзе `ML_PROVIDER=openai`, `UPSTREAM_URL=http://spark:8000/v1`, в `aliases.json` —
новые имена моделей. Бэк не меняется.

---

## 5. Порядок и сроки

| Неделя | Шаги | Что можно показать |
|---|---|---|
| 1 | 1–6 | бэк подключён к шлюзу, ходит в заглушку, получает `tool_calls` |
| 2 | 7–8 | поток SSE; настоящая модель через внешнее API |
| 3 | 9–11 | алиасы и промпты, `<think>` вырезается, лимиты и выключатель |
| 4 | 12–14 | логи, тесты, Docker на сервере Сбера |

После недели 1 команда бэка уже не ждёт тебя: они работают с заглушкой, ты параллельно подключаешь модель.

## 6. Переезд на Spark

Код ML-сервиса не меняется — меняются настройки и место запуска.

1. **Модель на Spark.** Поднять vLLM с Qwen3-30B-A3B: OpenAI-совместимый адрес `http://localhost:8000/v1` на самом Spark
   (кто поднимает и сколько памяти нам — согласовать с админами; см. [TZ_ML.md](TZ_ML.md) §2).
2. **Образ под ARM.** Spark — ARM (aarch64). Собрать образ ML-сервиса под `linux/arm64`:
   `docker buildx build --platform linux/arm64 -t ml-server:arm64 .` (или собрать прямо на Spark).
   Базовые образы `gradle:8-jdk21` и `eclipse-temurin:21-jre` есть под arm64.
3. **Запуск на Spark** с другими переменными:
   `ML_PROVIDER=openai`, `UPSTREAM_URL=http://localhost:8000/v1`, `UPSTREAM_KEY` не нужен (или ключ vLLM, если включат).
4. **Алиасы.** В `aliases.json` — `"model": "Qwen/Qwen3-30B-A3B-FP8"`. Для Qwen3 выключить рассуждения там, где не нужны:
   добавить в алиас параметр, который шлюз передаёт в vLLM как `"chat_template_kwargs": {"enable_thinking": false}`.
5. **Промпты и проверка качества.** Другая модель — другое поведение: прогнать eval-набор (30–50 обращений),
   сравнить со старой моделью, поправить промпты. Результат — в `docs/EVAL.md`.
6. **Бэк.** Поменять только адрес: `spring.ai.openai.base-url=http://<spark>:8080`. Ключ `ML_API_KEY` тот же.
   Бэк должен видеть Spark по сети вуза — согласовать с ИТ-службой.
7. **Сервер Сбера** оставить на неделю как запасной: если на Spark что-то не так — вернуть адрес на бэке обратно.
   Потом выключить и удалить ключ внешней нейронки. ⚠ Как постоянный запасной вариант не использовать:
   на Spark пойдут реальные данные студентов, а во внешнее API их отправлять нельзя.

Проверка переезда: `/health` на Spark показывает `provider: openai`, e2e-сценарий «что у меня завтра» проходит
с `tool_calls`, поток SSE идёт кусками, в логах — модель Qwen.

## 7. Частые ошибки

- `arguments` сделать объектом, а не строкой — Spring AI не распарсит ответ;
- забыть `flush()` в потоке — ответ приходит целиком в конце;
- создавать `HttpClient` на каждый запрос — утечка соединений и медленно;
- блокирующие вызовы (`Thread.sleep`, `runBlocking`) внутри маршрутов — используй `delay`, `suspend`;
- ловить `CancellationException` в `catch (e: Exception)` и глушить — ломает отмену корутин; перебрасывай её;
- логировать тело запроса «для отладки» — в логах окажется переписка студентов;
- ключи в `application.conf` в git — только переменные окружения.
