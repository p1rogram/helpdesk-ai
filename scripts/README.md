# Сбор данных для базы знаний

Два скрипта. Результат — сырые страницы/статьи в `data/raw/`. Используются дважды: как источник
для статей каталога (`data/catalog/tpu.json`, выверяются вручную) и напрямую как RAG-корпус —
API индексирует `data/raw` при старте (`RAG_INGEST_ON_BOOT`) или по `POST /api/admin/rag/ingest`.

## 1. Публичные страницы tpu.ru (без входа)

```bash
node scripts/crawl-site.mjs \
  --start https://tpu.ru/student --start https://tpu.ru/university --start https://tpu.ru/education \
  --allow https://tpu.ru/student --allow https://tpu.ru/university --allow https://tpu.ru/education \
  --max 400 --delay 400 --out data/raw/tpu-site.jsonl
```

### Как ограничить обход подкаталогом

`--allow` задаёт границу: краулер не выйдет за указанный префикс. Сравнение идёт **по границе пути**,
поэтому `--allow https://tpu.ru/student` берёт `/student` и `/student/faq/`, но не `/students-club`.
Слэш в конце можно писать или не писать — результат одинаковый.

```bash
# только раздел /student и всё, что под ним
node scripts/crawl-site.mjs --start https://tpu.ru/student --allow https://tpu.ru/student --max 200 --out data/raw/student.jsonl

# несколько разделов сразу
node scripts/crawl-site.mjs   --start https://tpu.ru/student --start https://tpu.ru/education   --allow https://tpu.ru/student --allow https://tpu.ru/education --max 300 --out data/raw/tpu.jsonl

# раздел целиком, но без новостей и архива (--deny вырезает подразделы)
node scripts/crawl-site.mjs --start https://tpu.ru/student --allow https://tpu.ru/student   --deny https://tpu.ru/student/news --deny https://tpu.ru/student/archive --max 200 --out data/raw/student.jsonl

# другой поддомен — это отдельный запуск со своим --allow
node scripts/crawl-site.mjs --start https://lib.tpu.ru --allow https://lib.tpu.ru --max 100 --out data/raw/lib.jsonl
```

- Если `--allow` не указать, границей станут домены стартовых ссылок (весь `tpu.ru`) — так собирать долго.
- Ссылки за пределы области всё равно записываются в поле `links`, но не обходятся — по ним видно,
  куда стоит запустить следующий проход.
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

## 3. Внутренние документы (регламенты, приказы)

Файлы, которых нет на сайте, кладутся в `data/raw/docs/*.md` с заголовком:

```
---
title: Стипендии программы ТОП ИТ
source: https://itr.tpu.ru/top-it/     # ссылка, которую увидит пользователь
audience: internal                     # internal — только после входа; public — и гостям
---
# Текст документа в Markdown; заголовки становятся разделами фрагментов
```

Из .docx текст удобно вытащить любым конвертером (pandoc, python-docx), затем убрать шапку приказа
и превратить пункты в разделы: чем чище структура, тем точнее поиск.
