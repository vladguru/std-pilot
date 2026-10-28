import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// Образец сквозного теста: идентификатор критерия приёмки (AC-NN из SPEC.md) указывается в имени теста.
// Замените его тестами по критериям проекта.
test('AC-00 образец: главная страница открывается и доступна', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test('AC-00 образец: /healthz и /readyz отвечают', async ({ request }) => {
  expect((await request.get('/healthz')).ok()).toBe(true);
  expect((await request.get('/readyz')).ok()).toBe(true);
});
