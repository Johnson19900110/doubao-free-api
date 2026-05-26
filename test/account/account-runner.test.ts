import { describe, it, expect, vi } from 'vitest';
import {
  runNonStream,
  isRateLimitCode,
  isDisableCode,
  RATE_LIMIT_CODE,
  DISABLE_CODE,
} from '@/api/controllers/account-runner.ts';

function fakePool(accounts: string[]) {
  const released: Array<{ phone: string; outcome: string }> = [];
  let i = 0;
  return {
    released,
    size: () => accounts.length,
    acquire: vi.fn(async () => {
      const phone = accounts[i % accounts.length];
      i += 1;
      return { phone } as any;
    }),
    release: vi.fn((acc: any, outcome: string) => released.push({ phone: acc.phone, outcome })),
  };
}

describe('account-runner', () => {
  it('isRateLimitCode 识别限流码', () => {
    expect(isRateLimitCode(RATE_LIMIT_CODE)).toBe(true);
    expect(isRateLimitCode(0)).toBe(false);
  });

  it('isDisableCode 识别风控禁用码', () => {
    expect(isDisableCode(DISABLE_CODE)).toBe(true);
    expect(isDisableCode(RATE_LIMIT_CODE)).toBe(false);
    expect(isDisableCode(0)).toBe(false);
  });

  it('风控禁用码触发换号重试并按 disabled 释放', async () => {
    const pool = fakePool(['a', 'b']);
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ code: DISABLE_CODE })
      .mockResolvedValueOnce({ code: 0, content: 'ok' });
    const r = await runNonStream(pool as any, fn);
    expect(r.content).toBe('ok');
    expect(pool.released).toEqual([
      { phone: 'a', outcome: 'disabled' },
      { phone: 'b', outcome: 'success' },
    ]);
  });

  it('首个账号成功直接返回', async () => {
    const pool = fakePool(['a', 'b']);
    const fn = vi.fn(async () => ({ code: 0, content: 'ok' }));
    const r = await runNonStream(pool as any, fn);
    expect(r.content).toBe('ok');
    expect(pool.released).toEqual([{ phone: 'a', outcome: 'success' }]);
  });

  it('成功结果最外层附带 account(账号手机号)', async () => {
    const pool = fakePool(['13800000000', 'b']);
    const fn = vi.fn(async () => ({ code: 0, content: 'ok' }));
    const r = await runNonStream(pool as any, fn);
    expect(r.account).toBe('13800000000');
  });

  it('换号成功后 account 为最终成功账号', async () => {
    const pool = fakePool(['a', 'b']);
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ code: RATE_LIMIT_CODE })
      .mockResolvedValueOnce({ code: 0, content: 'ok' });
    const r = await runNonStream(pool as any, fn);
    expect(r.account).toBe('b');
  });

  it('限流码触发换号重试', async () => {
    const pool = fakePool(['a', 'b']);
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ code: RATE_LIMIT_CODE })
      .mockResolvedValueOnce({ code: 0, content: 'ok' });
    const r = await runNonStream(pool as any, fn);
    expect(r.content).toBe('ok');
    expect(pool.released).toEqual([
      { phone: 'a', outcome: 'rateLimited' },
      { phone: 'b', outcome: 'success' },
    ]);
  });

  it('抛错按 error 释放并重试', async () => {
    const pool = fakePool(['a', 'b']);
    const fn = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ code: 0 });
    await runNonStream(pool as any, fn);
    expect(pool.released[0]).toEqual({ phone: 'a', outcome: 'error' });
  });

  it('重试耗尽抛最后错误', async () => {
    const pool = fakePool(['a']);
    const fn = vi.fn().mockRejectedValue(new Error('always'));
    await expect(runNonStream(pool as any, fn)).rejects.toThrow('always');
  });
});
