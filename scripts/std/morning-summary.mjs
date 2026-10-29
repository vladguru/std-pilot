#!/usr/bin/env node
// Утренняя сводка ночной смены (спека, п. 5). Детерминированный скрипт: рабочий процесс std-morning.yml запускает его
// каждые 30 минут, а он сам решает, пора ли публиковать — по поясу и времени из профиля AGENTS.md ветки main, не более
// одной сводки в сутки. Комментарий публикует github-actions[bot]: так владелец получает уведомление GitHub, даже если
// агент и владелец работают под одной учётной записью (собственные комментарии не уведомляют).
// Из issue и комментариев берутся только номера, заголовки и ссылки; заголовки усекаются и экранируются. Код веток PR не читается.
// Usage (CI): node scripts/std/morning-summary.mjs [--dry-run] [--force] [--now <ISO>]
//   env GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_API_URL (по умолчанию https://api.github.com), STD_MORNING_FORCE=1
import { parseArgs } from 'node:util';
import { listAll, makeApi, STATUS_CONTEXT } from './approval.mjs';
import { isMain, isTimeZone, normalizeTime, parseNightShift } from './common.mjs';

export const USAGE_MARK = '<!-- night-usage -->';
const BOT = 'github-actions[bot]';
const DEFAULT_TIME = '07:30';
const WINDOW_END = 12 * 60;
const NIGHT_HOURS = 12;
const RUN_HOURS = 24;
const MAX_ITEMS = 15;
const MAX_TITLE = 100;
const HOUR = 3600 * 1000;
const WORKFLOWS = [['std-nightly', 'Ночной прогон'], ['std-ci', 'CI на main']];
const RUN_STATES = { success: 'успешно', failure: 'ошибка', cancelled: 'отменён', timed_out: 'превышено время', skipped: 'пропущен', action_required: 'требует действия' };
const APPROVAL = { success: 'пройдено', failure: 'ожидает одобрения', pending: 'проверяется' };
const LINK = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull|actions\/runs)\/\d+$/;
const BIDI = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

function parts(now, tz) {
  if (!isTimeZone(tz)) throw new Error(`неизвестный часовой пояс: ${tz}`);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(now).map(x => [x.type, x.value]));
  return p;
}

/** Local date ("ГГГГ-ММ-ДД") and minutes since local midnight of `now` in the zone `tz`. */
export function localMinutes(now, tz) {
  const p = parts(now, tz);
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** True from `summaryTime` until 12:00 local time, unless a summary of this local date was already posted. */
export function shouldPost({ now, tz, summaryTime, lastPostedDate = null }) {
  const time = normalizeTime(summaryTime);
  if (!time) throw new Error(`время сводки должно быть в формате ЧЧ:ММ: ${summaryTime}`);
  const local = localMinutes(now, tz);
  if (local.date === lastPostedDate) return false;
  const [h, m] = time.split(':').map(Number);
  return local.minutes >= h * 60 + m && local.minutes < WINDOW_END;
}

function formatLocal(date, tz) {
  const p = parts(date, tz);
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}

// Titles are data: control and invisible characters go, the length is limited, Markdown is escaped, a mention gets a
// zero-width space after "@", the web address loses its scheme separator — nothing of a title can become markup or a link.
function clean(title) {
  const chars = [...String(title ?? '').replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ').replace(BIDI, '').replace(/\s+/g, ' ').trim()];
  let text = chars.length > MAX_TITLE ? `${chars.slice(0, MAX_TITLE - 1).join('').trimEnd()}…` : chars.join('');
  if (text === '') text = '(без заголовка)';
  return text
    .replace(/[\\`*_[\]()<>#|~&!]/g, '\\$&')
    .replace(/:\/\//g, '\\:\\/\\/')
    .replace(/www\./gi, 'www\\.')
    .replace(/@/g, '@\u200B');
}

const names = item => (item.labels ?? []).map(l => (typeof l === 'string' ? l : l?.name));
const hasLabel = (item, name) => names(item).includes(name);
const ref = item => (LINK.test(item.html_url ?? '') ? `[#${item.number}](${item.html_url})` : `#${item.number}`);
const valid = item => Number.isInteger(item?.number);
const groups = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function limited(lines) {
  if (lines.length <= MAX_ITEMS) return lines;
  return [...lines.slice(0, MAX_ITEMS), `- и ещё ${lines.length - MAX_ITEMS}`];
}

function pickNumber(body, label, max) {
  // Без динамического RegExp: строка вида «- Метка: 123» после необязательных маркеров списка.
  const wanted = label.toLowerCase();
  for (const raw of body.split('\n')) {
    const line = raw.replace(/^[ \t>*+-]+/, '').toLowerCase();
    if (!line.startsWith(wanted)) continue;
    const afterLabel = line.slice(wanted.length);
    const rest = afterLabel.replace(/^[ \t]*:[ \t]*/, '');
    if (rest === afterLabel) continue; // нет двоеточия
    const m = /^\d[\d   _]*/.exec(rest);
    if (!m) continue;
    const n = Number(m[0].replace(/\D/g, ''));
    return Number.isSafeInteger(n) && n <= max ? n : null;
  }
  return null;
}

/** Numbers of the usage comment of the night session; free text of the comment never reaches the summary. */
export function parseUsage(body) {
  if (typeof body !== 'string' || !body.includes(USAGE_MARK)) return null;
  return {
    tokens: pickNumber(body, 'Токены за ночь', 1e12),
    budgetPercent: pickNumber(body, 'Ночной бюджет израсходован', 999),
    lightPercent: pickNumber(body, 'Доля лёгких моделей', 100),
    tasks: pickNumber(body, 'Заданий выполнено', 9999),
  };
}

function usageLine(usage, now, tz) {
  const at = Date.parse(usage?.created_at);
  if (!Number.isFinite(at) || now - at > NIGHT_HOURS * HOUR) return null;
  const u = parseUsage(usage.body);
  if (!u) return null;
  const items = [
    u.tokens !== null && `токены за ночь: ${groups(u.tokens)}`,
    u.budgetPercent !== null && `ночной бюджет израсходован: ${u.budgetPercent}%`,
    u.lightPercent !== null && `доля лёгких моделей: ${u.lightPercent}%`,
    u.tasks !== null && `заданий выполнено: ${u.tasks}`,
  ].filter(Boolean);
  if (items.length === 0) return null;
  return `- ${items.join('; ')} (данные сессии на ${formatLocal(new Date(at), tz)})`;
}

function runLine(label, run, now, tz) {
  if (!run) return `- ${label}: нет запусков за сутки`;
  const state = run.status !== 'completed' ? 'выполняется' : (RUN_STATES[run.conclusion] ?? 'результат неизвестен');
  const when = formatLocal(new Date(run.created_at), tz);
  return LINK.test(run.html_url ?? '') ? `- ${label}: ${state} ([запуск](${run.html_url}), ${when})` : `- ${label}: ${state} (${when})`;
}

/**
 * Markdown text of the summary. Sections in the fixed order: ожидает владельца, готово, в работе, остановлено,
 * ночные прогоны, расход. `issues` are open issues (items with `pull_request` are ignored), `pulls` are open and recently
 * closed PRs (an open PR may carry `approval`: state of the status «std/согласование»), `runs` are workflow runs with
 * `workflow` (null — no access to runs), `usage` is the latest comment with the usage marker.
 */
export function buildSummary({ now, tz, issues = [], pulls = [], runs = [], usage = null }) {
  const { date } = localMinutes(now, tz);
  const [y, mo, d] = date.split('-');
  const plain = issues.filter(i => valid(i) && !i.pull_request && i.state !== 'closed');
  const open = pulls.filter(p => valid(p) && p.state === 'open');
  const line = (kind, item, tail = '') => `- ${kind} ${ref(item)}: ${clean(item.title)}${tail}`;

  const waiting = [
    ...plain.filter(i => hasLabel(i, 'нужен-ответ')).map(i => line('Вопрос', i)),
    ...open.filter(p => hasLabel(p, 'на-согласовании')).map(p => line('PR', p, ` — согласование: ${APPROVAL[p.approval] ?? 'статус неизвестен'}`)),
  ];
  const done = pulls
    .filter(p => valid(p) && p.merged_at && now - Date.parse(p.merged_at) <= NIGHT_HOURS * HOUR && Date.parse(p.merged_at) <= now.getTime() + HOUR)
    .sort((a, b) => a.merged_at.localeCompare(b.merged_at))
    .map(p => line('PR', p, ` — слит ${formatLocal(new Date(p.merged_at), tz)}`));
  const working = [
    ...plain.filter(i => (hasLabel(i, 'в-работе') || hasLabel(i, 'на-ревью')) && !hasLabel(i, 'стоп')).map(i => line('Задание', i)),
    ...open.filter(p => !hasLabel(p, 'на-согласовании')).map(p => line('PR', p)),
  ];
  const stopped = [
    ...plain.filter(i => hasLabel(i, 'стоп')).map(i => line('Задание', i)),
    ...plain.filter(i => hasLabel(i, 'пауза')).map(i => line('Пауза объявлена, issue', i)),
  ];
  const nightly = runs === null
    ? ['- нет данных о запусках']
    : WORKFLOWS.map(([workflow, label]) => {
      const latest = runs
        .filter(r => r.workflow === workflow && Number.isFinite(Date.parse(r.created_at)) && now - Date.parse(r.created_at) <= RUN_HOURS * HOUR)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      return runLine(label, latest, now, tz);
    });
  const spending = usageLine(usage, now, tz) ?? 'нет данных';

  const sections = [
    ['Ожидает владельца', waiting.length ? limited(waiting) : ['нет']],
    ['Готово', done.length ? limited(done) : ['нет']],
    ['В работе', working.length ? limited(working) : ['нет']],
    ['Остановлено', stopped.length ? limited(stopped) : ['нет']],
    ['Ночные прогоны', nightly],
    ['Расход', [spending]],
  ];
  const out = [`<!-- std-morning ${date} -->`, `## Утренняя сводка ${d}.${mo}.${y}`, ''];
  for (const [name, items] of sections) out.push(`### ${name}`, '', ...items, '');
  return `${out.join('\n').trimEnd()}\n`;
}

async function readProfile(api, repo) {
  const file = await api(`repos/${repo}/contents/AGENTS.md?ref=refs/heads/main`);
  return Buffer.from(file.content, 'base64').toString('utf8');
}

const optional = async (promise, fallback) => {
  try {
    return await promise;
  } catch {
    return fallback;
  }
};

/**
 * Publishes the summary when it is time. Reads only the default branch (profile) and the API data of issues, PRs and runs.
 * @returns {Promise<{ posted: boolean, reason?: string, body?: string, number?: number, notes: string[] }>}
 */
export async function run({ api, repo, now = new Date(), force = false, dryRun = false }) {
  const notes = [];
  const night = parseNightShift(await readProfile(api, repo));
  let tz = night.tz;
  if (!tz) {
    tz = 'UTC';
    notes.push('в профиле AGENTS.md ветки main не задан часовой пояс (строка «Ночная смена», «часовой пояс <Зона>»): использован UTC');
  }
  const summaryTime = night.summaryTime ?? DEFAULT_TIME;
  const local = localMinutes(now, tz);
  if (!force && !shouldPost({ now, tz, summaryTime, lastPostedDate: null })) {
    return { posted: false, reason: `сводка публикуется с ${summaryTime} до 12:00 по времени ${tz}, сейчас ${formatLocal(now, tz)}`, notes };
  }

  const found = await api(`repos/${repo}/issues?labels=${encodeURIComponent('сводки')}&state=open&sort=created&direction=asc&per_page=30`);
  const issue = found.find(i => !i.pull_request);
  if (!issue) throw new Error('не найден открытый issue с меткой «сводки»: выполните sync --github');
  const since = new Date(now.getTime() - 48 * HOUR).toISOString();
  const comments = await listAll(api, `repos/${repo}/issues/${issue.number}/comments?since=${since}`);
  const marker = `<!-- std-morning ${local.date} -->`;
  if (comments.some(c => c.user?.login === BOT && (c.body ?? '').startsWith(marker))) {
    return { posted: false, reason: `сводка за ${local.date} уже опубликована`, notes };
  }

  const [items, openPulls, closedPulls, nightlyRuns, ciRuns] = await Promise.all([
    listAll(api, `repos/${repo}/issues?state=open`),
    listAll(api, `repos/${repo}/pulls?state=open`),
    api(`repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`),
    optional(api(`repos/${repo}/actions/workflows/std-nightly.yml/runs?per_page=5`).then(r => r.workflow_runs ?? []), null),
    optional(api(`repos/${repo}/actions/workflows/std-ci.yml/runs?branch=main&per_page=5`).then(r => r.workflow_runs ?? []), null),
  ]);
  for (const pr of openPulls) {
    if (!names(pr).includes('на-согласовании')) continue;
    const status = await optional(api(`repos/${repo}/commits/${pr.head.sha}/status`), null);
    pr.approval = status?.statuses?.find(s => s.context === STATUS_CONTEXT)?.state ?? null;
  }
  const runs = nightlyRuns === null && ciRuns === null
    ? null
    : [...(nightlyRuns ?? []).map(r => ({ ...r, workflow: 'std-nightly' })), ...(ciRuns ?? []).map(r => ({ ...r, workflow: 'std-ci' }))];
  const usage = comments
    .filter(c => (c.body ?? '').includes(USAGE_MARK))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] ?? null;

  const body = buildSummary({ now, tz, issues: items, pulls: [...openPulls, ...closedPulls], runs, usage });
  if (dryRun) return { posted: false, reason: 'пробный запуск: публикация пропущена', body, number: issue.number, notes };
  await api(`repos/${repo}/issues/${issue.number}/comments`, { method: 'POST', body: { body } });
  return { posted: true, body, number: issue.number, notes };
}

// The token goes only to GitHub or to a local test server.
function apiBase(value) {
  const base = value || 'https://api.github.com';
  if (!/^(?:https:\/\/api\.github\.com|http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5})$/.test(base)) throw new Error('адрес API GitHub не поддерживается');
  return base;
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { 'dry-run': { type: 'boolean' }, force: { type: 'boolean' }, now: { type: 'string' } } });
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  try {
    if (!token || !repo) throw new Error('нужны GITHUB_REPOSITORY и GITHUB_TOKEN');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY должен иметь вид владелец/имя');
    const now = values.now ? new Date(values.now) : new Date();
    if (Number.isNaN(now.getTime())) throw new Error('--now: неверная дата');
    const result = await run({
      api: makeApi(token, apiBase(process.env.GITHUB_API_URL)), repo, now,
      force: Boolean(values.force) || process.env.STD_MORNING_FORCE === '1', dryRun: Boolean(values['dry-run']),
    });
    for (const note of result.notes) console.log(`Примечание: ${note}`);
    if (result.posted) console.log(`Сводка опубликована в issue #${result.number}`);
    else console.log(`Сводка не опубликована: ${result.reason}`);
    if (values['dry-run'] && result.body) console.log(`\n${result.body}`);
  } catch (err) {
    const text = String(err.message ?? err);
    console.error(`Ошибка: ${token ? text.split(token).join('***') : text}`);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) await main(process.argv.slice(2));
