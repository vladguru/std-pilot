// Хук Claude Code PostToolUse (стандарт агента, файл принадлежит стандарту): форматирует файл, который агент
// только что изменил, — gofmt для Go, ruff format для Python, prettier для веб-файлов. Программа должна быть найдена;
// ошибки форматирования никогда не блокируют работу (код выхода всегда 0). Самодостаточный файл.
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const PRETTIER_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.scss', '.html', '.vue']);
const PRETTIER_CONFIGS = [
  '.prettierrc', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml', '.prettierrc.json5', '.prettierrc.toml',
  '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs', 'prettier.config.ts',
];
const WINDOWS = process.platform === 'win32';

/** Путь к программе из PATH либо null. */
export function which(name, env = process.env) {
  const extensions = WINDOWS ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Что запустить для файла: { command, args } либо null, если форматировать нечем или незачем.
 * prettier запускается, только если он установлен в проекте или в проекте есть его настройки:
 * иначе он переформатировал бы код по своим умолчаниям.
 */
export function planFormat(file, { projectDir, which: find = which, exists = existsSync }) {
  const ext = extname(file).toLowerCase();
  if (ext === '.go') {
    const command = find('gofmt');
    return command ? { command, args: ['-w', file] } : null;
  }
  if (ext === '.py') {
    const command = find('ruff');
    return command ? { command, args: ['format', file] } : null;
  }
  if (!PRETTIER_EXTENSIONS.has(ext)) return null;
  const local = join(projectDir, 'node_modules', '.bin', WINDOWS ? 'prettier.cmd' : 'prettier');
  if (exists(local)) return { command: local, args: ['--write', file] };
  if (!PRETTIER_CONFIGS.some(name => exists(join(projectDir, name)))) return null;
  const command = find('prettier');
  return command ? { command, args: ['--write', file] } : null;
}

function run({ command, args }, cwd) {
  const cmdScript = WINDOWS && /\.(cmd|bat)$/i.test(command);
  // Файл .cmd Windows запускает только через оболочку; имя файла с метасимволами оболочки не форматируется.
  if (cmdScript && args.some(a => /["&|<>^%!]/.test(a))) return;
  spawnSync(cmdScript ? `"${command}"` : command, cmdScript ? args.map(a => `"${a}"`) : args, { cwd, stdio: 'ignore', timeout: 30000, shell: cmdScript, windowsHide: true });
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, ''));
  } catch {
    return;
  }
  if (typeof input !== 'object' || input === null || !TOOLS.has(input.tool_name)) return;
  const file = input.tool_input?.file_path;
  if (typeof file !== 'string' || file === '' || !existsSync(file)) return;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === 'string' && input.cwd) || process.cwd();
  const plan = planFormat(file, { projectDir });
  if (plan !== null) run(plan, projectDir);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch {
    // форматирование — удобство, а не проверка: любой сбой игнорируется
  }
  process.exitCode = 0;
}
