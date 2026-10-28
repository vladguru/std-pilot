import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addCheck, resetChecks } from '@/lib/readiness';
import { GET as healthz } from './route';
import { GET as readyz } from '../readyz/route';

describe('/healthz и /readyz', () => {
  beforeEach(() => resetChecks());

  it('/healthz отвечает 200, даже если зависимость не готова', async () => {
    addCheck('db', () => {
      throw new Error('база недоступна');
    });
    expect(healthz().status).toBe(200);
  });

  it('/readyz отвечает 200 без зависимостей', async () => {
    expect((await readyz()).status).toBe(200);
  });

  it('/readyz отвечает 503 и не раскрывает причину', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    addCheck('db', () => {
      throw new Error('секретный пароль базы');
    });
    const response = await readyz();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('секретный');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
