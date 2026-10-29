// Хук Claude Code SessionStart (стандарт агента, файл принадлежит стандарту): ставит зависимости проекта командой
// `make deps`, если такая цель есть. Команда идемпотентна; время ограничено 10 минутами. Сбой — одна строка в журнале
// (.git/std-hooks.log, вне отслеживаемых файлов) и в сообщении агенту; код выхода всегда 0. Самодостаточный файл.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEPS_TIMEOUT_MS = 600000;

// ---- доверие к коду ветки ----------------------------------------------------------------------------------------------
// Хук запускает make, а Makefile лежит в ветке, которую правит агент. Поэтому запуск разрешён, только если среда
// доверенная: облако (CLAUDE_CODE_REMOTE), репозиторий без удалённого origin либо ограничители (Makefile, make/,
// .mise.toml, scripts/std, package.json, pnpm-workspace.yaml, .claude) не отличаются от origin/main.
const GUARDED_PATHS = ['Makefile', 'make', '.mise.toml', 'scripts/std', 'package.json', 'pnpm-workspace.yaml', '.claude'];
const GIT_OPTIONS = { encoding: 'utf8', timeout: 15000, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } };

export function isTrusted({ cwd, env = process.env }) {
  if (env.CLAUDE_CODE_REMOTE) return true;
  const git = args => spawnSync('git', args, { cwd, ...GIT_OPTIONS });
  const origin = git(['config', '--get', 'remote.origin.url']);
  if (origin.error) return false;
  if (origin.status === 1) return true; // удалённого origin нет
  if (origin.status === 128 && /not a git repository/i.test(origin.stderr ?? '')) return true; // это не репозиторий
  if (origin.status !== 0) return false;
  if (git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']).status !== 0) return false;
  if (git(['diff', '--quiet', '--no-ext-diff', '--no-textconv', 'refs/remotes/origin/main', '--', ...GUARDED_PATHS]).status !== 0) return false;
  // Новый файл (например, make/evil.mk) подхватывается Makefile, а git diff его не видит.
  const fresh = git(['ls-files', '--others', '--exclude-standard', '--', ...GUARDED_PATHS, ':(exclude).claude/settings.local.json']);
  return fresh.status === 0 && (fresh.stdout ?? '').trim() === '';
}

function logPath(cwd) {
  return existsSync(join(cwd, '.git')) ? join(cwd, '.git', 'std-hooks.log') : join(tmpdir(), 'std-hooks.log');
}

function hasTarget(cwd, target) {
  try {
    return readFileSync(join(cwd, 'Makefile'), 'utf8').split('\n').some(line => line.startsWith(`${target}:`));
  } catch {
    return false;
  }
}

/** Выполняет `make deps`; возвращает { ran, ok, line }, line — строка о сбое либо null. */
export function runDeps({ cwd, spawnSync: run = spawnSync, env = process.env }) {
  if (!hasTarget(cwd, 'deps')) return { ran: false, ok: true, line: null };
  if (!isTrusted({ cwd, env })) {
    return { ran: false, ok: true, line: 'std-session: make deps пропущен: ограничители (Makefile, make/, scripts/std, .claude и другие) отличаются от origin/main либо origin/main недоступен, код ветки не считается доверенным. Проверьте изменения и установите зависимости вручную.' };
  }
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
