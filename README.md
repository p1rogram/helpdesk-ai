# Помоги мне — виртуальная техническая поддержка (Claude + Telegram Mini App + Kafka)

Виртуальный помощник техподдержки для кейса «Помоги мне» (re:actionstack × Актион × ТПУ).
Сфера по умолчанию — **техподдержка ТПУ** (база знаний собрана с help.tpu.ru); вторая сфера
(корпоративная IT-поддержка) загружена рядом, чтобы показать смену сферы без изменения кода.

## Что реализовано (по ТЗ)

| Требование кейса | Где |
|---|---|
| 1. Обращение в свободной форме → суть | `DialogEngine` + `LlmService.analyze()` (structured output) |
| 2. Классификация по каталогу услуг | категории в БД (`categories`), confidence от модели |
| 3. Только необходимые уточняющие вопросы | обязательные поля категории (`clarify[].required`), лимит `MAX_CLARIFICATIONS` — в коде, не в промпте |
| 4. Пошаговое решение | статья базы знаний → `LlmService.solve()` стримит адаптированные шаги; без LLM — шаги статьи дословно |
| 5. Завершение: что было, решено ли, что дальше, нужен ли специалист | шаблоны `resolved` / `escalated` + карточка |
| Передача специалисту | эскалация → событие `ticket.escalated` → Kafka → worker → push в Telegram |
| История обращений / вернуться к предыдущему | `GET /api/tickets`, экран «История» |
| Оценка ответа | `POST /api/tickets/:id/rating`, звёзды после закрытия |
| Автокарточка обращения | `TicketCard` (категория, приоритет, уверенность, тон, поля, статья, номер) |
| Отображение категории | чип в шапке чата |
| Оценка уверенности системы | `confidence` + индикатор; < порога → выбор категории кнопками |
| Поиск по базе знаний | `GET /api/kb/search` (BM25 по каталогу), экран «База знаний» |

Плюс: тон пользователя (мат/раздражение → спокойный ответ, приоритет ↑), off-topic-фильтр,
защита от prompt injection (текст пользователя — данные), LLM-less fallback, prompt caching,
rate limiting, проверка подписи Telegram initData, мультитенантность.

## Архитектура (кратко)

```
Telegram Mini App / Web (React)  ──HTTPS/SSE──▶  API (Fastify)  ──▶  Claude API (server-side key)
                                                  │  DialogEngine = детерминированный state machine
                                                  │  KnowledgeService = каталог из Postgres + BM25
                                                  ▼
                                            Kafka (KRaft) ──▶ worker: notifier (Telegram), analytics
                                                  ▼
                                              PostgreSQL (tickets, messages, catalog, daily_stats)
```

Подробно: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Быстрый старт (без Docker — 2 минуты)

```bash
npm install
cp .env.example .env          # минимум: JWT_SECRET, AUTH_DEV_BYPASS=true; ANTHROPIC_API_KEY — для полного режима
npm run build -w @helpdesk/shared
npm run dev:api               # http://localhost:8080  (встроенный PGlite, шина в памяти)
npm run dev:web               # http://localhost:5173  (гостевой вход, выбор сферы)
```

Без `ANTHROPIC_API_KEY` система работает в детерминированном режиме (классификация по базе знаний,
шаги статей дословно) — демо не зависит от внешнего API.

## Продакшен-стек (сервер)

```bash
cp .env.example .env   # заполнить ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, JWT_SECRET, WEB_APP_URL, DOMAIN
npm run build -w @helpdesk/web
docker compose up -d --build
docker compose --profile tools up -d kafka-ui   # http://server:8090 — визуализация топиков
```

Caddy выдаст HTTPS для `DOMAIN`, Mini App открывается по `https://DOMAIN`. В BotFather:
`/newapp` → URL = `https://DOMAIN`. Масштабирование: `docker compose up -d --scale api=3 --scale worker=2`.

## Смена сферы

Каталог (категории, уточняющие поля, статьи) хранится в БД. Новая сфера = JSON по схеме
`packages/shared/src/catalog.ts` → `POST /api/admin/catalog/import` (или файл в `data/catalog/` —
импортируется при первом старте). Один сервер обслуживает несколько сфер (`?tenant=`).

## Тесты

```bash
npm test -w @helpdesk/api     # подпись Telegram, фильтр контента, поиск, движок диалога (24 теста)
```

## Структура

```
apps/api      Fastify API: auth, tickets (SSE), kb, admin; модули dialog / llm / knowledge / events / safety
apps/worker   Kafka-консьюмеры (уведомления, аналитика) + Telegram-бот (кнопка Mini App)
apps/web      React Mini App: чат со стримингом, кнопки, карточка, история, база знаний
packages/shared  Zod-схемы: каталог, диалог, API, события — единый источник типов
data/catalog  seed-каталоги сфер (tpu.json, it-support.json); data/raw — источник (help.tpu.ru)
deploy        Dockerfiles, Caddyfile; docker-compose.yml — Postgres + Kafka + API + worker + Caddy
```
