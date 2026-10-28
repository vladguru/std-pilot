// Отвечает, пока процесс жив; зависимости не проверяет.
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return new Response('ok\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
