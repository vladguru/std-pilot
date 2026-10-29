#!/usr/bin/env node
// Определения расписаний ночной смены (спека, п. 5): две сессии агента (22:00 и 03:00 местного времени) — облачные
// routines Claude Code с cron в UTC. Скрипт только печатает определения (имя, cron, модель, текст запроса из
// .agents/night-shift.md); ничего не создаёт и в сеть не ходит. Создаёт routine агент по разрешению владельца.
// Usage: node scripts/std/night-schedule.mjs [--tz <Зона>] [--repo <владелец/имя>] [--project <каталог>] [--json]
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { git, isMain, isTimeZone, normalizeTime, parseNightShift, readText } from './common.mjs';

export const MODEL = 'claude-sonnet-5-5';
export const DEFAULT_SESSIONS = ['22:00', '03:00'];
const MIN_GAP = 60;
const DAY = 24 * 60;
const FALLBACK_PROMPT = 'Ты — ночная сессия агента проекта. Прочитай AGENTS.md и .agents/night-shift.md и выполни скилл std-night (.agents/skills/std-night/SKILL.md).';
const PROMPT_BLOCK = /<!-- routine-prompt:begin -->\n([\s\S]*?)\n<!-- routine-prompt:end -->/;

function offsetMinutes(tz, at) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(at).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return Math.round((asUtc - Math.floor(at.getTime() / 60000) * 60000) / 60000);
}

function formatOffset(minutes) {
  const abs = Math.abs(minutes);
  return `UTC${minutes < 0 ? '−' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** Warning for zones with summer time: the cron in UTC is right only until the next change of the clocks. */
export function dstWarning(tz, now = new Date()) {
  const year = now.getUTCFullYear();
  const winter = offsetMinutes(tz, new Date(Date.UTC(year, 0, 1)));
  const summer = offsetMinutes(tz, new Date(Date.UTC(year, 6, 1)));
  if (winter === summer) return null;
  return `Часовой пояс ${tz} переходит на летнее и зимнее время (сейчас ${formatOffset(offsetMinutes(tz, now))}): расписание в UTC верно до ближайшего перевода часов, определения нужно пересчитать дважды в год и обновить routine.`;
}

/** The request text between the markers of .agents/night-shift.md, or null. */
export function extractPrompt(text) {
  return PROMPT_BLOCK.exec(String(text).replace(/\r\n/g, '\n'))?.[1].trim() || null;
}

function checkSessions(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) throw new Error('не заданы времена сессий');
  const times = sessions.map(s => {
    const time = normalizeTime(s);
    if (!time) throw new Error(`время сессии должно быть в формате ЧЧ:ММ: ${s}`);
    return time;
  });
  const minutes = times.map(t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))).sort((a, b) => a - b);
  for (let i = 0; i < minutes.length; i++) {
    const gap = minutes.length === 1 ? DAY : (minutes[(i + 1) % minutes.length] - minutes[i] + DAY) % DAY;
    if (gap < MIN_GAP) throw new Error('интервал между сессиями должен быть не меньше 1 часа');
  }
  return times;
}

/**
 * Local times of the sessions → cron expressions in UTC (daily). The offset of the zone is taken at `now`.
 * @returns {{ name: string, cron: string, model: string, prompt: string, warning?: string }[]}
 */
export function nightRoutines({ tz, now = new Date(), sessions = DEFAULT_SESSIONS, repo, promptText }) {
  if (!isTimeZone(tz)) throw new Error(`неизвестный часовой пояс: ${tz}`);
  const times = checkSessions(sessions);
  const offset = offsetMinutes(tz, now);
  const warning = dstWarning(tz, now);
  return times.map(time => {
    const local = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const utc = (((local - offset) % DAY) + DAY) % DAY;
    const prompt = [repo ? `Репозиторий проекта: ${repo}.` : null, `Время сессии по часовому поясу проекта: ${time} (${tz}).`, promptText?.trim() || FALLBACK_PROMPT].filter(Boolean).join('\n');
    return {
      name: `Ночная смена${repo ? ` ${repo}` : ''} ${time}`,
      cron: `${utc % 60} ${Math.floor(utc / 60)} * * *`,
      model: MODEL,
      prompt,
      ...(warning ? { warning } : {}),
    };
  });
}

function defaultRepo(projectRoot) {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const url = git(['remote', 'get-url', 'origin'], projectRoot).trim();
    return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null;
  } catch {
    return null;
  }
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { tz: { type: 'string' }, repo: { type: 'string' }, project: { type: 'string' }, json: { type: 'boolean' } } });
  const projectRoot = resolve(values.project ?? '.');
  const profile = parseNightShift(readText(join(projectRoot, 'AGENTS.md')) ?? '');
  const tz = values.tz ?? profile.tz;
  if (!tz) throw new Error('часовой пояс не задан в профиле AGENTS.md (строка «Ночная смена»): укажите --tz <Зона>, например --tz Europe/Minsk');
  const repo = values.repo ?? defaultRepo(projectRoot);
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('репозиторий должен иметь вид владелец/имя');
  const shift = readText(join(projectRoot, '.agents/night-shift.md'));
  if (shift === null) throw new Error('не найден .agents/night-shift.md: выполните sync');
  const promptText = extractPrompt(shift);
  if (!promptText) throw new Error('в .agents/night-shift.md нет блока с текстом запроса (между <!-- routine-prompt:begin --> и <!-- routine-prompt:end -->)');
  const sessions = profile.sessions.length > 0 ? profile.sessions : DEFAULT_SESSIONS;
  const routines = nightRoutines({ tz, now: new Date(), sessions, repo, promptText });
  const warnings = [...new Set(routines.map(r => r.warning).filter(Boolean))];
  if (values.json) {
    console.log(JSON.stringify({ timezone: tz, repo, sessions, routines: routines.map(({ warning, ...r }) => r), warnings }, null, 2));
    return;
  }
  console.log(`Ночная смена: часовой пояс ${tz} (${formatOffset(offsetMinutes(tz, new Date()))}), сессии ${sessions.join(' и ')}${repo ? `, репозиторий ${repo}` : ''}`);
  for (const w of warnings) console.log(`Предупреждение: ${w}`);
  console.log('Определения только напечатаны: расписания не созданы. Создаёт их агент после согласия владельца (.agents/night-shift.md).');
  routines.forEach((r, i) => {
    console.log(`\nRoutine ${i + 1}\n  Имя: ${r.name}\n  Расписание (cron, UTC): ${r.cron}\n  Модель: ${r.model}\n  Текст запроса:`);
    for (const l of r.prompt.split('\n')) console.log(`    ${l}`);
  });
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`Ошибка: ${err.message}`);
    process.exitCode = 1;
  }
}
