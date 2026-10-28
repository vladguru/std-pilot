import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it('объединяет классы и отбрасывает ложные значения', () => {
    expect(cn('p-2', false && 'hidden', 'font-bold')).toBe('p-2 font-bold');
  });

  it('последний конфликтующий класс Tailwind побеждает', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });
});
