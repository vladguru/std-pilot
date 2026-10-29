// Хук Claude Code SessionStart (стандарт агента, файл принадлежит стандарту): ставит зависимости проекта командой
// `make deps`, если такая цель есть. Команда идемпотентна; время ограничено 10 минутами. Сбой — одна строка в журнале
// (.git/std-hooks.log, вне отслеживаемых файлов) и в сообщении агенту; код выхода всегда 0. Самодостаточный файл.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEPS_TIMEOUT_MS = 600000;

function logPath(cwd) {
  return existsSync(join(cwd, '.git')) ? join(cwd, '.git', 'std-hooks.log') : join(tmpdir(), 'std-hooks.log');
}

function hasTarget(cwd, target) {
  try {
    return new RegExp(`^${target}:`, 'm').test(readFileSync(join(cwd, 'Makefile'), 'utf8'));
  } catch {
    return false;
  }
}

/** Выполняет `make deps`; возвращает { ran, ok, line }, line — строка о сбое либо null. */
export function runDeps({ cwd, spawnSync: run = spawnSync }) {
  if (!hasTarget(cwd, 'deps')) return { ran: false, ok: true, line: null };
  const result = run('make', ['deps'], { cwd, stdio: 'ignore', timeout: DEPS_TIMEOUT_MS, windowsHide: true });
  if (result.error === undefined && result.status === 0) return { ran: true, ok: true, line: null };
  let line;
  if (result.error?.code === 'ETIMEDOUT') line = 'std-session: make deps не завершился за 10 минут и остановлен; зависимости могут быть установлены не полностью.';
  else if (result.error) line = 'std-session: не удалось запустить make deps; установите зависимости вручную.';
  else line = `std-session: make deps завершился с ошибкой (код ${result.status}); установите зависимости вручную и проверьте вывод команды.`;
  try {
    appendFileSync(logPath(cwd), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // журнал необязателен
  }
  return { ran: true, ok: false, line };
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, ''));
  } catch {
    // без ввода работаем от текущего каталога
  }
  if (typeof input !== 'object' || input === null) input = {};
  if (input.source === 'compact') return; // контекст сжат, зависимости уже стоят
  const cwd = process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === 'string' && input.cwd) || process.cwd();
  const { line } = runDeps({ cwd });
  if (line !== null) process.stdout.write(`${line}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch {
    // сбой установки зависимостей не должен мешать запуску сессии
  }
  process.exitCode = 0;
}
