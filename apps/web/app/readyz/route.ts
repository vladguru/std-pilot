import { failingDependency } from '@/lib/readiness';

// 200, когда все зависимости готовы, иначе 503. Причина пишется в журнал, а не в ответ.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const failing = await failingDependency();
  if (failing !== null) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'сервис не готов', dependency: failing }));
    return new Response('not ready\n', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response('ready\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
