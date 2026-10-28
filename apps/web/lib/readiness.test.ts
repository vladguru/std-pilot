import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import { addCheck, failingDependency, resetChecks } from './readiness';

describe('failingDependency', () => {
  beforeEach(() => resetChecks());

  it('без зависимостей все готово', async () => {
    expect(await failingDependency()).toBeNull();
  });

  it('называет первую неготовую зависимость', async () => {
    addCheck('cache', () => undefined);
    addCheck('db', () => Promise.reject(new Error('нет соединения')));
    expect(await failingDependency()).toBe('db');
  });

  it('повторная регистрация заменяет проверку', async () => {
    addCheck('db', () => {
      throw new Error('старая');
    });
    addCheck('db', () => undefined);
    expect(await failingDependency()).toBeNull();
  });

  it('свойство: неготова ровно та зависимость, которая падает', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 1 }),
        async (names) => {
          resetChecks();
          const broken = names[names.length - 1]!;
          for (const name of names) {
            addCheck(name, () => {
              if (name === broken) throw new Error('сбой');
            });
          }
          expect(await failingDependency()).toBe(broken);
        },
      ),
    );
  });
});
