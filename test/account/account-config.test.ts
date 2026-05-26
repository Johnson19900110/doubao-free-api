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

  it('环境变量 DOUBAO_AUTH_KEYS 覆盖 auth.keys(逗号分隔、去空格、滤空)', () => {
    const prev = process.env.DOUBAO_AUTH_KEYS;
    process.env.DOUBAO_AUTH_KEYS = 'sk-a, sk-b ,, sk-c ';
    try {
      const c = new AccountConfig({ auth: { keys: ['from-yaml'] } });
      expect(c.auth.keys).toEqual(['sk-a', 'sk-b', 'sk-c']);
    } finally {
      if (prev === undefined) delete process.env.DOUBAO_AUTH_KEYS;
      else process.env.DOUBAO_AUTH_KEYS = prev;
    }
  });

  it('未设环境变量时回退到 yaml 的 auth.keys', () => {
    const prev = process.env.DOUBAO_AUTH_KEYS;
    delete process.env.DOUBAO_AUTH_KEYS;
    try {
      const c = new AccountConfig({ auth: { keys: ['k1'] } });
      expect(c.auth.keys).toEqual(['k1']);
    } finally {
      if (prev !== undefined) process.env.DOUBAO_AUTH_KEYS = prev;
    }
  });
});
