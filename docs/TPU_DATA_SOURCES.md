# Источники данных ТПУ — что можно подгружать

Справочник по итогам обхода порталов 18–19.09.2026. Пометки: **✓** — видел/проверил на реальном сервере,
**◐** — стандартная возможность платформы (у ТПУ должна быть, не проверял), **?** — предположение.
Личные данные при обходе не читались и не сохранялись — только структура, каталоги и технические сигнатуры.

## oauth.tpu.ru — единая авторизация (OpenID Connect) ✓

| Данные | Откуда | Доступ |
|---|---|---|
| `sub`, ФИО (`name`, `given_name`, `family_name`, `middle_name`), `preferred_username`, `email`, `phone_number`, `birthdate`, `gender`, `picture`, `locale`, `address` | `userinfo_endpoint` (discovery: `/.well-known/openid-configuration`) | регистрация клиента; scopes `openid profile email phone address` |
| группа, роль, школа — **в claims нет** | → api.tpu.ru | |

Endpoints: `authorize` → `https://oauth.tpu.ru/authorize`, `token` → `/access-token`, `userinfo` → `/openid-connect/userinfo`,
`jwks` → `/certificates/jwks`; grant `authorization_code`, подпись `RS256`.

## api.tpu.ru — RESTful API v2 (на нём работает lk.tpu.ru) ✓

| Данные | Эндпоинт / признак | Уверенность |
|---|---|---|
| профиль сессии: роль, группа, школа | `/v2/client/user/auth/info` | ✓ вызов есть |
| меню и страницы ЛК по роли | `/v2/portal/menu`, `/v2/portal/page/{id}` | ✓ |
| дерево услуг МФЦ (виды заявлений) | `/v2/client/service/service/tree` | ✓ |
| мои заявления и статусы | `/v2/client/service/application/list` | ✓ |
| создание заявления | `…/application/create` | ? |
| успеваемость, посещаемость (в т.ч. по СКУД) | `academic_performance`, `skud` | ✓ страницы |
| стипендия (статус, дата) | `salary_student` | ✓ |
| мои приказы | `my_orders` | ✓ |
| мероприятия и записи | `events` | ✓ |
| опросы | `poll` | ✓ |
| портфолио, публикации, командировки | `portfolio`, `publications`, `km` | ✓ |
| правила доступа приложений (37): `rasp.info.group`, `object.request`, `event.*`, `tpu.all/fakultet/kafedra`, `exam.*` | кабинет → Правила | ✓ |
| регистрация приложения: ключ + публичный SSL-ключ, IP, платформы, разработчики | кабинет → Приложения → Добавить | ✓ |

## rasp.tpu.ru — расписание ✓

| Данные | Как | Доступ |
|---|---|---|
| поиск группы / аудитории / преподавателя → id, хэш | `GET /select/search/main.html?q=…&page_limit=25&page=1` → JSON | публично |
| расписание группы по неделям: пары, время, тип (ЛК/ЛБ/ПР), преподаватель, корпус, аудитория, способ проведения | `/gruppa_{id}/{год}/{неделя}/view.html` (HTML) | публично |
| расписание аудитории, преподавателя | аналогичные страницы | публично |
| iCal-экспорт группы | форма «Формат iCal» на странице группы | публично |
| чёт/нечёт, номер недели, даты обновления и изменений, сессия | страница группы | публично |
| сетка звонков, календарные графики, мероприятия (медосмотр и т.п.), корпуса, школы, диспетчеры | главная | публично |
| праздники | `POST /portal/data/holiday/list.html` | ✓ |
| кнопка «Подключиться» к вебинару | при входе (`my-rasp.tpu.ru`, oauth) | вход |
| **Открытое API** | заявка на raspisanie@tpu.ru (ФИО, телефон, логин, описание, скриншоты, цель, группа) | тестовый режим |

## help.tpu.ru — Naumen Service Desk ✓

| Данные | Как | Доступ |
|---|---|---|
| каталог услуг (9 групп) с описаниями | портал, `/sd/services/portalrest/exec` | вход |
| мои запросы: номер, услуга, дата, тип, статус, описание, комментарии | «Мои запросы» | вход |
| создание запроса, поля услуги, вложения | Naumen REST `/sd/services/rest/create/…` с accessKey | ключ (коннектор `NaumenHelpdesk` есть) |
| статус/история запроса | `…/rest/get/…`, `…/find/…` | ключ |

## stud.lms.tpu.ru — Moodle ✓ (веб-сервисы включены)

Токен: `login/token.php?service=moodle_mobile_app` (отвечает `invalidlogin` → сервис включён).
Вызовы: `webservice/rest/server.php?wstoken=…&wsfunction=…&moodlewsrestformat=json`.

| Данные | Функция |
|---|---|
| мои курсы: идут / прошли / будущие | `core_course_get_enrolled_courses_by_timeline_classification` |
| содержимое курса | `core_course_get_contents` |
| задания: сроки, статус сдачи, оценка | `mod_assign_get_assignments`, `mod_assign_get_submission_status` |
| тесты: сроки, попытки | `mod_quiz_get_quizzes_by_courses`, `mod_quiz_get_user_attempts` |
| ближайшие события/дедлайны | `core_calendar_get_calendar_upcoming_view`, `core_calendar_get_action_events_by_timesort` |
| оценки | `gradereport_user_get_grade_items` |
| уведомления, сообщения | `message_popup_get_popup_notifications`, `core_message_get_messages` |
| форумы | `mod_forum_get_forum_discussions` |
| посещаемость (если модуль есть) | `mod_attendance_*` |
| последний доступ, преподаватели курса | `core_enrol_get_users_courses`, `core_enrol_get_enrolled_users` |
| профиль, группы в курсах | `core_user_get_users_by_field`, `core_group_get_course_user_groups` |

Фильтр «живых» курсов: курс ∩ дисциплины расписания текущего семестра; дедлайны просроченные > 14 дней не показывать; см. обсуждение в переписке.

## ex2.tpu.ru / mail.tpu.ru — SOGo ✓

| Данные | Как | Замечание |
|---|---|---|
| письма, вложения, непрочитанные | IMAP | пароль пользователя — не рекомендуется |
| календарь, приглашения | CalDAV `/SOGo/dav/` (401 → есть) | то же |
| контакты, адресная книга | CardDAV | то же |

## cloud.tpu.ru — Nextcloud 33.0.9 ✓

| Данные | Как |
|---|---|
| файлы, папки, загрузка/скачивание | WebDAV `/remote.php/dav/files/{user}/` |
| шаринг, публичные ссылки | OCS Share API |
| квота | OCS `/ocs/v1.php/cloud/user` |
| активность, уведомления | OCS Activity / Notifications |
| авторизация | app-password или OAuth2 ◐ |

## devdocs.tpu.ru — BookStack «Документация ТПУ» ✓

| Данные | Как |
|---|---|
| полки → книги → главы → страницы (HTML/Markdown) | REST `/api/shelves`, `/api/books`, `/api/pages/{id}`; docs: `/api/docs` ✓ |
| поиск | `/api/search` |
| `updated_at` для переиндексации RAG | поля объектов |
| вложения, картинки | `/api/attachments`, `/api/image-gallery` |
| доступ | API-токен на чтение |

## codelab.tpu.ru — GitLab ✓

Проекты, репозитории, CI-пайплайны, раннеры, Container Registry, issues — REST API v4 (токен пользователя).
Для проекта: CI/CD внутри контура вуза, registry образов.

## aichat.tpu.ru — «портал ИИ ТПУ» ✓ (по виду Open WebUI)

Если Open WebUI — OpenAI-совместимые `/api/models`, `/api/chat/completions` с ключом пользователя ◐.
Возможный провайдер модели вместо собственного vLLM — уточнить у владельца.

## Прочие сервисы (ссылки из ЛК; API не проверял)

| Сервис | Что там | Как |
|---|---|---|
| print.tpu.ru (MyQ) | баланс, очередь печати, отправка на печать | MyQ REST API ◐ |
| netflow.tpu.ru/stat | трафик TPUNet | веб; API ? |
| staff.tpu.ru/personal | справочник: ФИО, подразделение, телефон, почта, кабинет | публичный веб |
| maps.tpu.ru | карта кампуса | сейчас 502 |
| wildfly.tpu.ru/pay | оплата услуг | только ссылка |
| exam.tpu.ru | результаты тестирования | oauth; правила `exam.*` в api.tpu.ru |
| lib.tpu.ru | НТБ, удалённый доступ | веб; OPAC/API ◐ |
| up.tpu.ru | руководители ООП | публичный веб |
| portal.tpu.ru | старый портал: тьютор, согласие ПД, антиплагиат, ВКР, отправка работ, Приоритет 2030, ЦОР | веб |
| tpu.ru/sveden, tpu.ru/tpu-life | сведения, медцентр, бассейн, клубы | публичный веб → RAG |
| vap.tpu.ru | RDWeb | ссылка |
| oopt.tpu.ru, dis.tpu.ru, eor.lms.tpu.ru | распределение, диссоветы, заочное обучение | ссылка / второй Moodle |

## Кросс-сервисные данные (получаются сложением)

- «где ты сейчас» (аудитория, корпус) = группа (oauth/api) + расписание (rasp) + время;
- «живой» курс Moodle = курс ∩ дисциплины расписания семестра;
- инцидент = N обращений одной категории из одного корпуса за окно времени (наша БД);
- преподаватель → контакт = пара в rasp → ФИО → staff.tpu.ru;
- «не у тебя, а у всех» = статус системы от ИТ-службы (консоль оператора) + инцидент.
