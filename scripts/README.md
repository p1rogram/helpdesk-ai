# Сбор данных для базы знаний

Два скрипта. Результат — сырые страницы/статьи в `data/raw/`. Дальше из них делаются статьи
каталога (`data/catalog/tpu.json`) — вручную или с помощью модели — и они попадают в БД при импорте.

## 1. Публичные страницы tpu.ru (без входа)

```bash
node scripts/crawl-site.mjs \
  --start https://tpu.ru/student --start https://tpu.ru/university --start https://tpu.ru/education \
  --allow https://tpu.ru/student --allow https://tpu.ru/university --allow https://tpu.ru/education \
  --max 400 --delay 400 --out data/raw/tpu-site.jsonl
```

- `--start` — откуда начинать, `--allow` — внутри каких префиксов ходить (иначе разбежится по всему сайту).
- Можно запускать повторно: уже собранные URL пропускаются, файл дополняется.
- Полезные разделы: `/student`, `/education`, `/university/campus` (если есть), `lib.tpu.ru`,
  `abiturient.tpu.ru`, `staff.tpu.ru/html` (инструкции для сотрудников), `tpu.ru/anticorruption`.

Формат строки: `{"url","title","h1","text","headings","links","fetchedAt"}`.

## 2. База знаний help.tpu.ru (нужен вход)

```bash
npm i -D playwright
npx playwright install chromium
node scripts/crawl-help-tpu.mjs --out data/raw/help-tpu.json
```

Откроется Chrome — войдите под своей учётной записью ТПУ и нажмите Enter в терминале. Скрипт
соберёт все статьи базы знаний (заголовок, услуги, категории, текст, ссылки) и каталог услуг.
Только чтение, никаких заявок не создаёт.

## Что потом

Пришлите `data/raw/*.json*` — из них формируются статьи каталога: `id`, `categoryId`, `title`,
`symptoms` (как люди описывают проблему), `steps` (пошагово), `source` (ссылка). Схема —
`packages/shared/src/catalog.ts`. Эти же тексты станут корпусом для векторного поиска (RAG).
