#!/usr/bin/env node
// Smoke test of a running system: /healthz and /readyz answer 200 (spec 7, 11). A sleeping free-tier service needs retries.
// Usage: node scripts/std/smoke.mjs <адрес> [--retries 10] [--delay 3000]
import { parseArgs } from 'node:util';
import { fail, isMain } from './common.mjs';

const PATHS = ['/healthz', '/readyz'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** @returns {Promise<{ ok: boolean, problems: string[] }>} */
export async function smoke(baseUrl, { retries = 10, delayMs = 3000 } = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  let problems = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    problems = [];
    for (const path of PATHS) {
      try {
        const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30_000) });
        if (res.status !== 200) problems.push(`${path}: код ${res.status}`);
      } catch (err) {
        problems.push(`${path}: ${err.cause?.code ?? err.message}`);
      }
    }
    if (problems.length === 0) return { ok: true, problems };
    if (attempt < retries) await sleep(delayMs);
  }
  return { ok: false, problems };
}

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { retries: { type: 'string', default: '10' }, delay: { type: 'string', default: '3000' } } });
  if (positionals.length !== 1) throw new Error('нужен адрес системы, например http://localhost:8080');
  const result = await smoke(positionals[0], { retries: Number(values.retries), delayMs: Number(values.delay) });
  if (result.ok) console.log(`Дымовой тест ${positionals[0]}: /healthz и /readyz отвечают`);
  else fail([`Дымовой тест ${positionals[0]} не пройден:`, ...result.problems.map(p => `  ${p}`)]);
}

if (isMain(import.meta.url)) main(process.argv.slice(2)).catch(err => { console.error(`Ошибка: ${err.message}`); process.exitCode = 1; });
