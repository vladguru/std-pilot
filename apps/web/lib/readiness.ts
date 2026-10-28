/** Проверка одной зависимости: завершается без ошибки, если зависимость готова. */
export type Check = () => Promise<void> | void;

const checks = new Map<string, Check>();

/** Регистрирует проверку готовности; повторная регистрация под тем же именем заменяет прежнюю. */
export function addCheck(name: string, check: Check): void {
  checks.set(name, check);
}

/** Сбрасывает проверки (для тестов). */
export function resetChecks(): void {
  checks.clear();
}

/** Имя первой неготовой зависимости или null, если готовы все. */
export async function failingDependency(): Promise<string | null> {
  for (const [name, check] of checks) {
    try {
      await check();
    } catch {
      return name;
    }
  }
  return null;
}
