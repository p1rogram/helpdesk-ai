/**
 * AI: Personal-data hygiene for the knowledge corpus (152-ФЗ). Crawled pages name officials,
 * managers, coaches and club leaders; the assistant needs their roles and office contacts, not
 * their identities. Removed before chunking:
 *   - full names in either order ("Иванова Анна Петровна", "Анна Петровна Иванова"),
 *   - initial forms ("Иванова А. П.", "А. П. Иванов"),
 *   - first name + surname pairs ("Данил Казаков", "Новикова Юлия") - a first-name list plus
 *     Russian surname endings,
 *   - mobile numbers (+7 9xx …): on a university site they belong to people, not to offices.
 * Landline numbers, e-mails, addresses and hours stay.
 */
const PATRONYMIC = '(?:ович|евич|ьич|ич|овна|евна|ична|инична|ьевна)(?:а|у|е|ем|ой|ы)?';
const WORD = '[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?';
const END = '(?![а-яё])';

// AI: The 200 most common Russian first names (nominative + common oblique forms via stems).
const FIRST_NAMES = `
Александр Алексей Анатолий Андрей Антон Аркадий Арсений Артём Артем Артур Борис Вадим Валентин Валерий
Василий Виктор Виталий Владимир Владислав Вячеслав Геннадий Георгий Герман Глеб Григорий Даниил Данил
Данила Денис Дмитрий Евгений Егор Захар Иван Игнат Игорь Илья Кирилл Константин Лев Леонид Макар Максим
Марк Матвей Михаил Никита Николай Олег Павел Пётр Петр Роман Руслан Савелий Семён Семен Сергей Станислав
Степан Тимофей Тимур Фёдор Федор Филипп Эдуард Юрий Яков Ярослав
Александра Алёна Алена Алина Алиса Алла Анастасия Ангелина Анна Антонина Арина Валентина Валерия Варвара
Вера Вероника Виктория Галина Дарья Диана Ева Евгения Екатерина Елена Елизавета Жанна Зоя Инна Ирина
Карина Кира Кристина Ксения Лариса Лидия Лилия Любовь Людмила Маргарита Марина Мария Милана Надежда
Наталья Наталия Нина Оксана Олеся Ольга Полина Раиса Регина Светлана София Софья Таисия Тамара Татьяна
Ульяна Юлия Яна
`
  .trim()
  .split(/\s+/);
// AI: Stems cover declension: "Данил" also matches "Данила", "Юли" matches "Юлия/Юлии".
const FIRST_NAME = `(?:${[...new Set(FIRST_NAMES.map((n) => n.slice(0, Math.max(3, n.length - 1))))].join('|')})[а-яё]{0,3}`;
const SURNAME =
  '[А-ЯЁ][а-яё]+(?:ов|ова|ев|ева|ёв|ёва|ин|ина|ын|ына|ский|ская|цкий|цкая|ко|ук|юк|ич|ых|их)';

// AI: Streets and "named after" objects keep the name: "ул. Аркадия Иванова, 8", "корпус имени Кижнера".
const NOT_A_PLACE =
  '(?<!(?:ул\\.|улица|пр\\.|проспект|пер\\.|переулок|пл\\.|площадь|им\\.|имени|музей|кабинет)\\s{0,2})';

const FULL_NAME = new RegExp(
  `${NOT_A_PLACE}${WORD}\\s+${WORD}\\s+${WORD}${PATRONYMIC}${END}`,
  'gu',
);
const FULL_NAME_INVERTED = new RegExp(
  `${NOT_A_PLACE}${WORD}\\s+${WORD}${PATRONYMIC}\\s+${WORD}${END}`,
  'gu',
);
const INITIALS = new RegExp(
  `${NOT_A_PLACE}(?:${WORD}\\s+[А-ЯЁ]\\.\\s?[А-ЯЁ]\\.|[А-ЯЁ]\\.\\s?[А-ЯЁ]\\.\\s?${WORD})`,
  'gu',
);
const NAME_SURNAME = new RegExp(
  `${NOT_A_PLACE}(?:${FIRST_NAME}\\s+${SURNAME}|${SURNAME}\\s+${FIRST_NAME})${END}`,
  'gu',
);
const MOBILE =
  /\+?7[-\s(]*9\d\d[-\s)]*\d{3}[-\s]*\d{2}[-\s]*\d{2}|\b8[-\s(]*9\d\d[-\s)]*\d{3}[-\s]*\d{2}[-\s]*\d{2}/g;

export const PERSONAL_DATA_PATTERNS = {
  FULL_NAME,
  FULL_NAME_INVERTED,
  INITIALS,
  NAME_SURNAME,
  MOBILE,
};

export function redactNames(text: string): string {
  return (
    text
      .replace(FULL_NAME, '')
      .replace(FULL_NAME_INVERTED, '')
      .replace(INITIALS, '')
      .replace(NAME_SURNAME, '')
      .replace(MOBILE, '')
      // AI: tidy what the name used to hold together
      .replace(/\s*\(\s*\)/g, '')
      .replace(/\(\s*,\s*/g, '(')
      .replace(/[—–-]\s*,\s*/g, '— ')
      .replace(/:\s*,\s*/g, ': ')
      .replace(/,\s*,/g, ',')
      .replace(/(?:по\s+)?(?:тел\.?|телефон)[:\s]*(?=[,;.\n]|$)/giu, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/ +\n/g, '\n')
  );
}

/** AI: What the CI gate and the tests look for; returns the offending fragments. */
export function findPersonalData(text: string): string[] {
  return [FULL_NAME, FULL_NAME_INVERTED, INITIALS, NAME_SURNAME, MOBILE].flatMap((re) =>
    [...text.matchAll(re)].map((m) => m[0]),
  );
}
