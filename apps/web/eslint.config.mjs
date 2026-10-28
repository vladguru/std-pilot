// Правила ESLint. Файл — ограничитель: изменяется с согласия владельца.
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const config = [
  ...nextVitals,
  ...nextTypescript,
  { ignores: ['.next/**', 'coverage/**', 'next-env.d.ts'] },
];

export default config;
