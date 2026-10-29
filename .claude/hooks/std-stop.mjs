// Хук Claude Code Stop (стандарт агента, файл принадлежит стандарту): перед завершением хода запускает быструю проверку
// `make check-std`, если такая цель есть и в рабочем дереве есть изменённые файлы. При ошибке — код 2 и краткая причина:
// агент исправляет и завершает ход снова. Повторный запуск в том же ходе (stop_hook_active) всегда пропускается,
// поэтому цикла нет. Зависшая проверка (2 минуты) агента не держит. Самодостаточный файл.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const CHECK_TIMEOUT_MS = 120000;
const MAX_MESSAGE = 1500;

function hasTarget(cwd) {
  try {
    return /^check-std:/m.test(readFileSync(join(cwd, 'Makefile'), 'utf8'));
  } catch {
    return false;
  }
}

// Пути из `git status --porcelain -z`: «XY путь\0», у переименования следом идёт прежний путь.
function changedFiles(cwd, run) {
  const r = run('git', ['-c', 'core.quotepath=off', 'status', '--porcelain', '-z'], { cwd, encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return [];
  const parts = r.stdout.split('\0').filter(Boolean);
  const files = [];
  for (let k = 0; k < parts.length; k++) {
    const entry = parts[k];
    files.push(entry.slice(3));
    if (/^[RC]/.test(entry)) k++; // прежний путь переименования не проверяется
  }
  return files;
}

function tail(text) {
  const clean = text.replace(/\r/g, '').trim();
  return clean.length > MAX_MESSAGE ? `…${clean.slice(-MAX_MESSAGE)}` : clean;
}

/** @returns {{ block: boolean, message?: string }} */
export function runStop({ input, cwd, spawnSync: run = spawnSync }) {
  if (input?.stop_hook_active === true) return { block: false };
  if (!hasTarget(cwd)) return { block: false };
  const files = changedFiles(cwd, run);
  if (files.length === 0) return { block: false };
  const result = run('make', ['check-std'], {
    cwd,
    encoding: 'utf8',
    timeout: CHECK_TIMEOUT_MS,
    windowsHide: true,
    env: { ...process.env, STD_CHANGED_FILES: files.join('\n') },
  });
  if (result.error || result.status === 0 || result.status === null) return { block: false };
  const output = tail(`${result.stdout ?? ''}${result.stderr ?? ''}`);
  return { block: true, message: `std-stop: make check-std завершился с ошибкой (код ${result.status}). Исправьте замечания и завершите работу снова.${output ? `\n${output}` : ''}` };
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, ''));
  } catch {
    return 0;
  }
  if (typeof input !== 'object' || input === null) return 0;
  const cwd = process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === 'string' && input.cwd) || process.cwd();
  const result = runStop({ input, cwd });
  if (!result.block) return 0;
  process.stderr.write(`${result.message}\n`);
  return 2;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    process.exitCode = main();
  } catch {
    process.exitCode = 0;
  }
}
