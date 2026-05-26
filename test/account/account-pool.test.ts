import { describe, it, expect } from 'vitest';
import { AccountPool } from '@/lib/account/account-pool.ts';
import { RawAccount } from '@/lib/account/types.ts';

// 内存 FingerprintStore 替身
function makeFpStore() {
  let n = 0;
  const map: Record<string, { deviceId: string; webId: string }> = {};
  return {
    async load() {},
    getOrCreate(phone: string) {
      if (!map[phone]) { n += 1; map[phone] = { deviceId: `d${n}`, webId: `w${n}` }; }
      return { ...map[phone] };
    },
    async save() {},
  };
}

function makePool(opts?: { accounts?: RawAccount[] }) {
  let now = 1000;
  let throwErr = false;
  const fetched = { value: opts?.accounts ?? [] };
  const pool = new AccountPool({
    now: () => now,
    sleep: async () => {},
    fetchAccounts: async () => { if (throwErr) throw new Error('network'); return fetched.value; },
    fingerprintStore: makeFpStore() as any,
    config: { requestInterval: 2000, rateLimitCooldown: 300000, maxFailover: 3 },
  });
  return {
    pool,
    setNow: (v: number) => { now = v; },
    setFetched: (v: RawAccount[]) => { fetched.value = v; },
    setThrow: (v: boolean) => { throwErr = v; },
  };
}

describe('AccountPool.reconcile', () => {
  it('新增账号进池并绑定指纹', async () => {
    const { pool } = makePool({ accounts: [{ phone: '111', token: 't1' }] });
    await pool.reconcile();
    expect(pool.size()).toBe(1);
  });

  it('消失账号(空闲)被移除', async () => {
    const h = makePool({ accounts: [{ phone: '111', token: 't1' }, { phone: '222', token: 't2' }] });
    await h.pool.reconcile();
    expect(h.pool.size()).toBe(2);
    h.setFetched([{ phone: '111', token: 't1' }]);
    await h.pool.reconcile();
    expect(h.pool.size()).toBe(1);
  });

  it('token 变化清除 disabled 与 strikes', async () => {
    const h = makePool({ accounts: [{ phone: '111', token: 't1' }] });
    await h.pool.reconcile();
    // 两次限流 -> disabled（中间跳过冷却）
    const acc = await h.pool.acquire();
    h.pool.release(acc, 'rateLimited');        // strikes=1, 冷却至 301000
    h.setNow(1000 + 300001);                   // 跳过冷却
    const acc2 = await h.pool.acquire();
    h.pool.release(acc2, 'rateLimited');       // strikes=2 -> disabled
    expect(h.pool.status().disabled).toBe(1);
    // token 变化后恢复
    h.setFetched([{ phone: '111', token: 't2' }]);
    await h.pool.reconcile();
    expect(h.pool.status().disabled).toBe(0);
  });

  it('外部接口异常时保留旧池', async () => {
    const h = makePool({ accounts: [{ phone: '111', token: 't1' }] });
    await h.pool.reconcile();
    expect(h.pool.size()).toBe(1);
    h.setThrow(true);
    await expect(h.pool.reconcile()).resolves.toBeUndefined();
    expect(h.pool.size()).toBe(1);
  });

  it('空数组响应保留旧池(防误清空)', async () => {
    const h = makePool({ accounts: [{ phone: '111', token: 't1' }] });
    await h.pool.reconcile();
    h.setFetched([]);
    await h.pool.reconcile();
    expect(h.pool.size()).toBe(1);
  });
});

describe('AccountPool.acquire', () => {
  it('空池抛 503', async () => {
    const { pool } = makePool({ accounts: [] });
    await expect(pool.acquire()).rejects.toMatchObject({ httpStatusCode: 503 });
  });

  it('轮询依次选中不同账号', async () => {
    const { pool } = makePool({
      accounts: [{ phone: '111', token: 't1' }, { phone: '222', token: 't2' }],
    });
    await pool.reconcile();
    const a = await pool.acquire();
    const b = await pool.acquire();
    expect(a.phone).not.toBe(b.phone);
  });

  it('跳过正在忙的账号', async () => {
    const { pool } = makePool({ accounts: [{ phone: '111', token: 't1' }] });
    await pool.reconcile();
    await pool.acquire(); // 占住 111(未 release)
    await expect(pool.acquire()).rejects.toMatchObject({ httpStatusCode: 429 });
  });

  it('限流冷却中的账号被跳过抛 429', async () => {
    const { pool } = makePool({ accounts: [{ phone: '111', token: 't1' }] });
    await pool.reconcile();
    const a = await pool.acquire();
    pool.release(a, 'rateLimited'); // 进入冷却
    await expect(pool.acquire()).rejects.toMatchObject({ httpStatusCode: 429 });
  });

  it('冷却中(距上次结束<2s)选中时 sleep 补满间隔', async () => {
    let now = 1000;
    let slept = 0;
    const fp = (() => {
      let n = 0; const m: any = {};
      return { async load() {}, getOrCreate(p: string) { if (!m[p]) { n++; m[p] = { deviceId: `d${n}`, webId: `w${n}` }; } return { ...m[p] }; }, async save() {} };
    })();
    const pool = new AccountPool({
      now: () => now,
      sleep: async (ms: number) => { slept = ms; },
      fetchAccounts: async () => [{ phone: '111', token: 't1' }],
      fingerprintStore: fp as any,
      config: { requestInterval: 2000, rateLimitCooldown: 300000, maxFailover: 3 },
    });
    await pool.reconcile();
    const a = await pool.acquire();
    pool.release(a, 'success'); // lastEndTime=1000
    now = 1500; // 距结束 500ms
    await pool.acquire();
    expect(slept).toBe(1500); // 2000 - 500
  });
});

describe('AccountPool.release', () => {
  it('首次限流进冷却', async () => {
    const { pool } = makePool({ accounts: [{ phone: '111', token: 't1' }] });
    await pool.reconcile();
    const a = await pool.acquire();
    pool.release(a, 'rateLimited');
    expect(pool.status().rateLimited).toBe(1);
  });

  it('首次限流 5min 后可重新选中', async () => {
    const h = makePool({ accounts: [{ phone: '111', token: 't1' }] });
    await h.pool.reconcile();
    const a = await h.pool.acquire();
    h.pool.release(a, 'rateLimited');
    await expect(h.pool.acquire()).rejects.toMatchObject({ httpStatusCode: 429 });
    h.setNow(1000 + 300001);
    const b = await h.pool.acquire();
    expect(b.phone).toBe('111');
  });

  it('二次限流标记 disabled', async () => {
    const h = makePool({ accounts: [{ phone: '111', token: 't1' }] });
    await h.pool.reconcile();
    const a = await h.pool.acquire();
    h.pool.release(a, 'rateLimited');     // strikes=1
    h.setNow(1000 + 300001);
    const a2 = await h.pool.acquire();
    h.pool.release(a2, 'rateLimited');    // strikes=2 -> disabled
    expect(h.pool.status().disabled).toBe(1);
  });

  it('success 清零 strikes', async () => {
    const h = makePool({ accounts: [{ phone: '111', token: 't1' }] });
    await h.pool.reconcile();
    const a = await h.pool.acquire();
    h.pool.release(a, 'rateLimited');     // strikes=1
    h.setNow(1000 + 300001);
    const a2 = await h.pool.acquire();
    h.pool.release(a2, 'success');        // strikes=0
    expect(h.pool.status().accounts[0].strikes).toBe(0);
    expect(h.pool.status().rateLimited).toBe(0);
  });

  it('error 不计 strike', async () => {
    const { pool } = makePool({ accounts: [{ phone: '111', token: 't1' }] });
    await pool.reconcile();
    const a = await pool.acquire();
    pool.release(a, 'error');
    expect(pool.status().rateLimited).toBe(0);
    expect(pool.status().disabled).toBe(0);
  });

  it('忙账号在对齐中消失 -> 释放后移除(pendingRemoval)', async () => {
    const h = makePool({ accounts: [{ phone: '111', token: 't1' }, { phone: '222', token: 't2' }] });
    await h.pool.reconcile();
    const a = await h.pool.acquire(); // 选中 111 并占住
    h.setFetched([{ phone: '222', token: 't2' }]); // 111 消失
    await h.pool.reconcile();
    expect(h.pool.size()).toBe(2); // 忙账号延迟移除
    h.pool.release(a, 'success');
    expect(h.pool.size()).toBe(1); // 释放后移除
  });
});
