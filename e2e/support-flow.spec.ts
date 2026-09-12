import { expect, test } from '@playwright/test';

/**
 * AI: Один сквозной сценарий вместо десятка мелких: он ловит именно то, что не видят unit-тесты -
 * сборку фронта, проксирование /api, SSE-поток ответа, переключение вкладок и консоль оператора.
 */
test('студент задаёт вопрос, зовёт специалиста, оператор отвечает', async ({ page }) => {
  await page.goto('/');

  // AI: Вход демо-студентом.
  await page.getByRole('button', { name: 'Я студент или сотрудник ТПУ' }).click();
  await page.getByPlaceholder('Ваше имя').fill('Студент e2e');
  await page.getByRole('button', { name: 'Войти' }).click();

  // AI: Приветствие помощника и поле ввода.
  const composer = page.getByPlaceholder('Опишите проблему…');
  await expect(composer).toBeVisible();

  // AI: Проблема -> помощник сначала предлагает решение сам.
  await composer.fill('не работает wi-fi в общежитии 12, комната 305');
  await composer.press('Enter');
  await expect(page.getByText('Попробуйте по шагам')).toBeVisible();

  // AI: Решение уже предлагалось - просьба о специалисте принимается и создаёт заявку.
  await composer.fill('свяжи с оператором');
  await composer.press('Enter');
  await expect(page.getByText(/Заявка №[0-9A-F]{8} создана/)).toBeVisible();
  await expect(page.getByPlaceholder('Написать специалисту…')).toBeVisible();

  // AI: Консоль оператора: сводка, обращение в очереди, взять себе, ответить.
  await page.goto('/#/operator');
  await expect(page.getByText('в очереди сейчас')).toBeVisible();
  await expect(page.getByText('Ждут специалиста')).toBeVisible();
  await page
    .locator('.item', { hasText: 'не работает wi-fi в общежитии 12' })
    .filter({ hasText: 'ждёт ответа' })
    .click();
  await page.getByRole('button', { name: 'Взять себе' }).click();
  await expect(page.getByRole('button', { name: 'Взять себе' })).toHaveCount(0);

  const reply = page.getByPlaceholder('Ответ пользователю (уйдёт в чат и push в Telegram)…');
  await reply.fill('Проверил точку доступа в общежитии 12 - перезапустил, попробуйте снова.');
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(
    page.getByText('Проверил точку доступа в общежитии 12').filter({ visible: true }),
  ).toBeVisible();

  // AI: Пользователь видит ответ и имя специалиста в чате.
  // AI: Экраны вкладок остаются смонтированными - ищем только видимый экземпляр.
  await page.goto('/#/chat');
  await expect(
    page.getByText('Проверил точку доступа в общежитии 12').filter({ visible: true }),
  ).toBeVisible();
  await expect(page.getByText(/У специалиста: /)).toBeVisible();
});
