import { describe, it, expect } from 'vitest';
import { AccountConfig } from '@/lib/configs/account-config.ts';

describe('AccountConfig', () => {
  it('提供默认值', () => {
    const c = new AccountConfig();
    expect(c.pool.pollInterval).toBe(60000);
    expect(c.pool.requestInterval).toBe(2000);
    expect(c.pool.rateLimitCooldown).toBe(300000);
    expect(c.pool.maxFailover).toBe(3);
    expect(c.auth.keys).toEqual([]);
  });

  it('合并传入配置', () => {
    const c = new AccountConfig({
      auth: { keys: ['k1', 'k2'] },
      pool: { apiUrl: 'http://x', apiToken: 'tk', pollInterval: 30000 },
    });
    expect(c.auth.keys).toEqual(['k1', 'k2']);
    expect(c.pool.apiUrl).toBe('http://x');
    expect(c.pool.pollInterval).toBe(30000);
    expect(c.pool.requestInterval).toBe(2000); // 未传仍用默认
  });
});
