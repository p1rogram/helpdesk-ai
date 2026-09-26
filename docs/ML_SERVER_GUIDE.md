# ML-сервер на Kotlin: пошаговая инструкция

Для кого: пишешь ML-сервер сам, с нуля, Kotlin знаешь слабо. Инструкция ведёт по шагам, каждый шаг даёт
работающий результат и проверку. Код дан **каркасами** — ключевые строки и `TODO`, остальное пишешь сам.

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

1. **JDK 21** (Temurin): https://adoptium.net → проверка `java -version`.
2. **IntelliJ IDEA** Community.
3. Проект: https://start.ktor.io → Ktor 3.x, Gradle Kotlin DSL, движок Netty, плагины: *Content Negotiation*,
   *kotlinx.serialization*, *Authentication (Bearer)*, *Status Pages*, *Call Logging*, *Call ID*.
   Package: `ru.tpu.ml`. Скачать, открыть в IDEA.
4. Сверить `build.gradle.kts` (версии — актуальные на момент создания, генератор подставит сам):

```kotlin
plugins {
    kotlin("jvm") version "2.1.0"
    kotlin("plugin.serialization") version "2.1.0"
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

Проверка: `./gradlew run` (Windows: `gradlew.bat run`) стартует без ошибок.

### Что нужно знать из Kotlin (минимум)

| Понятие | Что это | Где встретишь |
|---|---|---|
| `data class` | класс «только данные»: поля, `equals`, `copy()` | модели запросов/ответов |
| `@Serializable` | kotlinx.serialization умеет превратить класс в JSON и обратно | все модели API |
| `@SerialName("max_tokens")` | имя поля в JSON отличается от имени в Kotlin | snake_case OpenAI |
| `String?`, `?:`, `?.` | может быть `null`; «иначе»; «если не null» | необязательные поля |
| `suspend fun` | функция, которая может «ждать» (сеть), не блокируя поток | всё, что ходит в сеть |
| `Flow<T>` | поток значений во времени (`emit`, `collect`) | потоковый ответ модели |
| `interface` | контракт, у которого несколько реализаций | провайдеры моделей |
| `object` | единственный экземпляр (синглтон) | утилиты, заглушки |
| `when` | `switch` на стероидах | выбор провайдера |

Ktor: **плагин** (`install(...)`) — сквозная функция для всех запросов (JSON, авторизация, ошибки);
**маршрут** (`routing { post("/путь") { ... } }`) — обработчик URL; `call` — текущий запрос и ответ.

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

Каждый шаг: **цель → что написать → как проверить → готово, когда**. Не переходи дальше, пока проверка не прошла.

### Шаг 1. `/health` (полчаса)

Цель — сервер отвечает. В `Application.kt`:

```kotlin
fun main() {
    embeddedServer(Netty, port = System.getenv("PORT")?.toInt() ?: 8080, module = Application::module)
        .start(wait = true)
}

fun Application.module() {
    install(ContentNegotiation) { json(AppJson) }   // AppJson объявим в шаге 3
    routing {
        get("/health") { call.respond(mapOf("status" to "ok")) }
    }
}
```

Проверка: `curl http://localhost:8080/health` → `{"status":"ok"}`.

### Шаг 2. Настройки (полчаса)

Все настройки — из переменных окружения, чтобы на сервере Сбера и на Spark был один и тот же jar.

```kotlin
data class Config(
    val port: Int,
    val backendApiKey: String,        // ключ, с которым приходит бэк
    val provider: String,             // mock | openai | gigachat
    val upstreamUrl: String?,         // адрес внешнего API / vLLM
    val upstreamKey: String?,         // ключ внешнего API
    val maxConcurrent: Int,           // одновременных запросов к модели
    val requestTimeoutMs: Long,
) {
    companion object {
        fun fromEnv(): Config = Config(
            port = env("PORT", "8080").toInt(),
            backendApiKey = env("ML_API_KEY"),               // обязательный — без него не стартуем
            provider = env("ML_PROVIDER", "mock"),
            upstreamUrl = System.getenv("UPSTREAM_URL"),
            upstreamKey = System.getenv("UPSTREAM_KEY"),
            maxConcurrent = env("ML_MAX_CONCURRENT", "8").toInt(),
            requestTimeoutMs = env("ML_TIMEOUT_MS", "60000").toLong(),
        )
        private fun env(name: String, default: String? = null): String =
            System.getenv(name) ?: default ?: error("Не задана переменная окружения $name")
    }
}
```

Готово, когда: без `ML_API_KEY` сервер падает с понятным сообщением; `PORT=9000` меняет порт.

### Шаг 3. Модели формата OpenAI (1 вечер) — самый важный шаг

Бэк (Spring AI) и vLLM говорят именно так. Описываешь JSON как `data class`.

```kotlin
val AppJson = Json {
    ignoreUnknownKeys = true   // бэк может прислать поля, которых мы не знаем — не падаем
    explicitNulls = false      // null-поля не пишем в ответ
    encodeDefaults = true
}

@Serializable
data class ChatRequest(
    val model: String,                                   // у нас — алиас: "tpu-assistant"
    val messages: List<ChatMessage>,
    val tools: List<ToolDef>? = null,                    // инструменты, которые бэк разрешил
    @SerialName("tool_choice") val toolChoice: JsonElement? = null,
    val stream: Boolean = false,
    val temperature: Double? = null,
    @SerialName("max_tokens") val maxTokens: Int? = null,
    @SerialName("response_format") val responseFormat: JsonObject? = null,
)

@Serializable
data class ChatMessage(
    val role: String,                                    // system | user | assistant | tool
    val content: String? = null,
    @SerialName("tool_calls") val toolCalls: List<ToolCall>? = null,   // у assistant: «вызови»
    @SerialName("tool_call_id") val toolCallId: String? = null,        // у tool: ответ на какой вызов
)

@Serializable data class ToolDef(val type: String = "function", val function: FunctionDef)
@Serializable data class FunctionDef(val name: String, val description: String? = null, val parameters: JsonObject? = null)
@Serializable data class ToolCall(val id: String, val type: String = "function", val function: FunctionCall)
@Serializable data class FunctionCall(val name: String, val arguments: String)   // ⚠ JSON-СТРОКА, не объект

@Serializable
data class ChatResponse(
    val id: String,
    @SerialName("object") val obj: String = "chat.completion",
    val created: Long,
    val model: String,
    val choices: List<Choice>,
    val usage: Usage? = null,
)
@Serializable data class Choice(val index: Int = 0, val message: ChatMessage, @SerialName("finish_reason") val finishReason: String?)
@Serializable data class Usage(
    @SerialName("prompt_tokens") val promptTokens: Int,
    @SerialName("completion_tokens") val completionTokens: Int,
    @SerialName("total_tokens") val totalTokens: Int,
)

// поток: куски ответа
@Serializable
data class ChatChunk(
    val id: String,
    @SerialName("object") val obj: String = "chat.completion.chunk",
    val created: Long,
    val model: String,
    val choices: List<ChunkChoice>,
    val usage: Usage? = null,
)
@Serializable data class ChunkChoice(val index: Int = 0, val delta: Delta, @SerialName("finish_reason") val finishReason: String? = null)
@Serializable data class Delta(val role: String? = null, val content: String? = null,
                               @SerialName("tool_calls") val toolCalls: List<ToolCallDelta>? = null)
@Serializable data class ToolCallDelta(val index: Int, val id: String? = null, val type: String? = null, val function: FunctionCallDelta? = null)
@Serializable data class FunctionCallDelta(val name: String? = null, val arguments: String? = null)

// ошибки — тоже в формате OpenAI, Spring AI их понимает
@Serializable data class ErrorBody(val error: ErrorInfo)
@Serializable data class ErrorInfo(val message: String, val type: String, val code: String? = null)
```

Как выглядит цикл с инструментом (это надо понимать, иначе дальше будет сложно):

```
1. бэк → шлюз:  messages=[system, user:"что у меня завтра?"], tools=[rasp.day]
2. шлюз → бэк:  message={role:assistant, tool_calls:[{id:"c1", function:{name:"rasp.day", arguments:"{\"date\":\"2026-09-27\"}"}}]}
                finish_reason="tool_calls"
3. бэк сам вызывает MCP rasp.day, затем снова → шлюз:
                messages=[system, user, assistant(tool_calls c1), {role:tool, tool_call_id:"c1", content:"[пары…]"}]
4. шлюз → бэк:  message={role:assistant, content:"Завтра три пары: …"}, finish_reason="stop"
```

Готово, когда: тест «распарсить пример JSON запроса → собрать обратно» проходит (шаг 13).

### Шаг 4. Ключ бэка (полчаса)

Шлюз доступен только бэку. Проверяем заголовок `Authorization: Bearer <ML_API_KEY>`.

```kotlin
data class BackendPrincipal(val name: String)

install(Authentication) {
    bearer("backend") {
        authenticate { cred -> if (cred.token == config.backendApiKey) BackendPrincipal("backend") else null }
    }
}
routing {
    get("/health") { … }                       // без ключа — для мониторинга
    authenticate("backend") {
        // сюда — /v1/models и /v1/chat/completions
    }
}
```

Сравнение ключей в идеале — через `MessageDigest.isEqual(a.toByteArray(), b.toByteArray())` (защита от атаки по времени).

Проверка: запрос без ключа → 401, с ключом → проходит.

### Шаг 5. Провайдер-заглушка (1 вечер)

Интерфейс — контракт для всех моделей:

```kotlin
interface LlmProvider {
    val name: String
    suspend fun complete(req: ChatRequest): ChatResponse
    fun stream(req: ChatRequest): Flow<ChatChunk>
}
```

`MockProvider` — модель-имитация. Нужна, чтобы **бэк начал интеграцию сразу**, не дожидаясь внешнего API, и для тестов.
Правила заглушки:
- в последнем сообщении пользователя есть «распис» и в `tools` есть `rasp.day` → вернуть `tool_calls` с `rasp.day`;
- последнее сообщение с ролью `tool` → вернуть текст «По данным инструмента: <первые 200 символов>»;
- иначе → «Заглушка: вы написали „…“».

```kotlin
object MockProvider : LlmProvider {
    override val name = "mock"
    override suspend fun complete(req: ChatRequest): ChatResponse {
        val last = req.messages.last()
        val msg = when {
            last.role == "tool" -> ChatMessage("assistant", content = "По данным инструмента: ${last.content?.take(200)}")
            // TODO: правило про расписание → ChatMessage("assistant", toolCalls = listOf(ToolCall(id = "call_1", function = FunctionCall("rasp.day", """{"date":"2026-09-27"}"""))))
            else -> ChatMessage("assistant", content = "Заглушка: вы написали «${last.content}»")
        }
        val reason = if (msg.toolCalls != null) "tool_calls" else "stop"
        return ChatResponse(id = "mock-" + System.nanoTime(), created = System.currentTimeMillis() / 1000,
            model = req.model, choices = listOf(Choice(message = msg, finishReason = reason)),
            usage = Usage(0, 0, 0))
    }
    override fun stream(req: ChatRequest): Flow<ChatChunk> = flow {
        // TODO: взять complete(req), текст порезать на куски по 10 символов, каждый — emit(ChatChunk(... Delta(content = кусок)))
        // последний кусок — с finishReason
    }
}
```

### Шаг 6. `/v1/chat/completions` без потока (полвечера)

```kotlin
authenticate("backend") {
    get("/v1/models") { /* TODO: список алиасов в формате {"object":"list","data":[{"id":"tpu-assistant","object":"model"}]} */ }
    post("/v1/chat/completions") {
        val req = call.receive<ChatRequest>()
        if (req.stream) { /* шаг 7 */ } else call.respond(chatService.complete(req))
    }
}
```

`ChatService.complete` пока просто вызывает `provider.complete(req)`. Позже в нём появятся алиасы, лимиты, постобработка.

Проверка:
```bash
curl -s http://localhost:8080/v1/chat/completions -H "Authorization: Bearer test" -H "Content-Type: application/json" -d "{\"model\":\"tpu-assistant\",\"messages\":[{\"role\":\"user\",\"content\":\"привет\"}]}"
```
Готово, когда: приходит JSON с `choices[0].message.content`; с `tools=[rasp.day]` и текстом «расписание» — `tool_calls`.

### Шаг 7. Потоковый ответ SSE (1 вечер)

Помощник показывает ответ «печатающимся» — бэк просит `stream: true`. Формат: строки `data: {json}\n\n`, в конце `data: [DONE]`.

```kotlin
call.response.header(HttpHeaders.CacheControl, "no-cache")
call.respondTextWriter(contentType = ContentType.Text.EventStream) {
    chatService.stream(req).collect { chunk ->
        write("data: ${AppJson.encodeToString(chunk)}\n\n")
        flush()                                  // ⚠ без flush куски придут пачкой в конце
    }
    write("data: [DONE]\n\n")
    flush()
}
```

Проверка: `curl -N ... -d "{...,\"stream\":true}"` — строки появляются по одной, не все сразу.

### Шаг 8. Настоящий провайдер (1–2 вечера)

**Вариант А — OpenAI-совместимое API** (vLLM на Spark, Cloud.ru Foundation Models, другие): запрос почти пересылается как есть.

```kotlin
class OpenAiCompatibleProvider(private val baseUrl: String, private val apiKey: String?, private val client: HttpClient) : LlmProvider {
    override val name = "openai"

    override suspend fun complete(req: ChatRequest): ChatResponse {
        val resp = client.post("$baseUrl/chat/completions") {
            apiKey?.let { bearerAuth(it) }
            contentType(ContentType.Application.Json)
            setBody(req.copy(stream = false))
        }
        if (!resp.status.isSuccess()) throw UpstreamException(resp.status.value, resp.bodyAsText().take(300))
        return resp.body()
    }

    override fun stream(req: ChatRequest): Flow<ChatChunk> = flow {
        client.preparePost("$baseUrl/chat/completions") {
            apiKey?.let { bearerAuth(it) }
            contentType(ContentType.Application.Json)
            setBody(req.copy(stream = true))
        }.execute { resp ->
            if (!resp.status.isSuccess()) throw UpstreamException(resp.status.value, resp.bodyAsText().take(300))
            val channel = resp.bodyAsChannel()
            while (!channel.isClosedForRead) {
                val line = channel.readUTF8Line() ?: break
                if (!line.startsWith("data:")) continue
                val data = line.removePrefix("data:").trim()
                if (data == "[DONE]") break
                emit(AppJson.decodeFromString<ChatChunk>(data))
            }
        }
    }
}

class UpstreamException(val status: Int, message: String) : RuntimeException(message)
```

HTTP-клиент создаётся **один раз** на всё приложение:

```kotlin
val http = HttpClient(CIO) {
    install(io.ktor.client.plugins.contentnegotiation.ContentNegotiation) { json(AppJson) }
    install(HttpTimeout) { connectTimeoutMillis = 5_000; requestTimeoutMillis = config.requestTimeoutMs; socketTimeoutMillis = 30_000 }
}
```

`baseUrl` для vLLM — `http://spark:8000/v1`.

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
3. `fromGiga(resp)`: `function_call` → `tool_calls` с придуманным `id` (`"call_" + UUID`) и `arguments` → строка (`AppJson.encodeToString(obj)`).
4. Поток — тот же SSE, но с `function_call` в дельте; для начала поток можно делать «одним куском», а честный стрим — потом.

### Шаг 9. Алиасы и промпты (1 вечер) — «обработка промптов»

Бэк не должен знать, какая сейчас модель и какой у неё системный промпт. Он шлёт `model: "tpu-assistant"`,
шлюз подставляет всё остальное. Файл `resources/aliases.json`:

```json
{
  "tpu-assistant": { "model": "GigaChat-2-Max", "prompt": "prompts/assistant.md", "temperature": 0.2, "maxTokens": 800,  "thinking": false },
  "tpu-analyze":   { "model": "GigaChat-2-Pro", "prompt": "prompts/analyze.md",   "temperature": 0.0, "maxTokens": 300,  "json": true }
}
```

Когда переедете на Spark — меняется только `"model": "Qwen/Qwen3-30B-A3B-FP8"`.

Логика `Aliases.resolve(req)`:
1. найти алиас по `req.model`, иначе 400 «неизвестная модель»;
2. прочитать промпт (один раз при старте, держать в памяти), подставить переменные `{{date}}`, `{{weekday}}`, `{{org}}`;
3. **в начало** `messages` поставить этот системный промпт; системные сообщения бэка (контекст: группа, роль) — сразу после него;
4. `temperature`, `max_tokens` — из алиаса, если бэк не прислал свои (а `max_tokens` бэка не может превысить алиас);
5. `json: true` → добавить `response_format: {"type":"json_object"}` (если провайдер умеет) и в промпт — «ответь одним JSON».

В промпт `assistant.md` — роль, правила (отвечать по данным инструментов, не выдумывать, по-русски, коротко),
что делать, если инструмент вернул ошибку. **Версия промпта** — первой строкой (`# v3 · 26.09`) и в логах.

### Шаг 10. Постобработка ответа (полвечера)

- **`<think>…</think>`** (рассуждения Qwen3 и похожих моделей) — вырезать. В обычном ответе — регуляркой
  `Regex("(?s)<think>.*?</think>")`. В потоке — маленький автомат `ThinkFilter`: получает кусок текста, возвращает
  то, что можно показать; пока внутри `<think>` — копит и ничего не отдаёт. Учти, что тег может прийти разорванным
  между кусками (`<thi` + `nk>`).
- **JSON-режим**: если алиас `json: true`, проверить, что `content` парсится как JSON; если нет — один повтор с
  припиской «верни только JSON», потом ошибка 502.
- **Аргументы инструментов**: проверить, что `arguments` — валидный JSON. Если модель прислала мусор — вернуть
  бэку как есть не надо: один повтор, потом ответ текстом «не удалось выполнить действие».

### Шаг 11. Надёжность (1–2 вечера)

```kotlin
class Resilience(maxConcurrent: Int) {
    private val permits = Semaphore(maxConcurrent)            // kotlinx.coroutines.sync.Semaphore
    private var failures = 0
    @Volatile private var openUntil = 0L

    suspend fun <T> guard(block: suspend () -> T): T {
        if (System.currentTimeMillis() < openUntil) throw OverloadedException("модель временно недоступна")
        val acquired = withTimeoutOrNull(10_000) { permits.acquire() }
            ?: throw OverloadedException("очередь к модели переполнена")
        try {
            val r = block()
            failures = 0
            return r
        } catch (e: UpstreamException) {
            if (++failures >= 5) { openUntil = System.currentTimeMillis() + 60_000; failures = 0 }
            throw e
        } finally { permits.release() }
    }
}
class OverloadedException(msg: String) : RuntimeException(msg)
```

- `complete` — один повтор при 5xx/таймауте провайдера; при 4xx — без повтора;
- поток — без повторов (часть ответа уже ушла);
- ошибки → формат OpenAI через `StatusPages`:

| Исключение | HTTP | `error.type` |
|---|---|---|
| тело не парсится, неизвестный алиас | 400 | `invalid_request_error` |
| нет/неверный ключ | 401 | `authentication_error` |
| `OverloadedException` | 503 | `overloaded` |
| таймаут | 504 | `timeout` |
| `UpstreamException` | 502 | `upstream_error` |

`/health` отдаёт ещё `provider`, `circuit: closed|open`, `inFlight` — бэк и консоль оператора будут это показывать.

### Шаг 12. Логи (полвечера)

`CallId` — берёт `X-Request-Id` от бэка или создаёт свой, кладёт в каждую строку лога. На каждый запрос одна строка:
`requestId, alias, model, provider, stream, tools=N, toolCalls=M, promptTokens, completionTokens, ms, status`.
**Никогда не логируй `messages` и `content`** — там переписка студентов.

### Шаг 13. Тесты (параллельно с шагами)

- **сериализация**: пример запроса Spring AI (JSON-строка) → `ChatRequest` → обратно; `arguments` остаётся строкой;
- **маршруты**: `testApplication { … }` с `MockProvider`: 401 без ключа; обычный ответ; ответ с `tool_calls`; поток заканчивается `[DONE]`;
- **провайдер**: `HttpClient(MockEngine)` отдаёт заготовленный ответ внешнего API — проверяешь разбор и ошибки;
- **ThinkFilter**: тег разорван между кусками; несколько блоков подряд;
- **GigaChat-адаптер**: `tools` ↔ `functions`, `tool` ↔ `function`, `arguments` объект ↔ строка.

Команда: `./gradlew test`.

### Шаг 14. Сборка и запуск на сервере (1 вечер)

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

## 6. Частые ошибки

- `arguments` сделать объектом, а не строкой — Spring AI не распарсит ответ;
- забыть `flush()` в потоке — ответ приходит целиком в конце;
- создавать `HttpClient` на каждый запрос — утечка соединений и медленно;
- блокирующие вызовы (`Thread.sleep`, `runBlocking`) внутри маршрутов — используй `delay`, `suspend`;
- ловить `CancellationException` в `catch (e: Exception)` и глушить — ломает отмену корутин; перебрасывай её;
- логировать тело запроса «для отладки» — в логах окажется переписка студентов;
- ключи в `application.conf` в git — только переменные окружения.
