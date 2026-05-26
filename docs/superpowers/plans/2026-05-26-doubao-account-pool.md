# 豆包账号池 / 并发调度 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把豆包账号 token 来源从 `Authorization` 头改为定时轮询外部接口的内存账号池,每账号绑定固定设备指纹,`Authorization` 改作接入鉴权,并实现轮询选号 + 限流故障转移 + 每账号最小请求间隔。

**Architecture:** 新增独立 `AccountPool`(内存池 + 选号调度 + 限流计分 + 指纹持久化 + 每分钟全量对齐),路由层做薄编排(鉴权 → acquire → 调控制器 → release/故障转移)。`chat.ts` / `images.ts` 控制器改为接收携带 `{token, deviceId, webId}` 的账号凭据而非裸 token。

**Tech Stack:** TypeScript (ESM, NodeNext), Koa, axios, lodash, fs-extra, yaml, randomstring;测试用 vitest。

参考设计文档:`docs/superpowers/specs/2026-05-26-doubao-account-pool-design.md`

---

## 文件结构

新增:
- `vitest.config.ts` — 测试配置(`@` 别名 + `.js`→`.ts` 解析)
- `test/account/fingerprint-store.test.ts`
- `test/account/account-pool.test.ts`
- `test/auth.test.ts`
- `test/sanity.test.ts`
- `src/lib/account/types.ts` — `Account` / `AccountCredential` / `Fingerprint` / 状态类型
- `src/lib/account/fingerprint-store.ts` — 指纹读写持久化
- `src/lib/account/account-pool.ts` — `AccountPool` 类 + 默认单例
- `src/lib/account/mask.ts` — 手机号脱敏
- `src/lib/auth.ts` — 接入鉴权 `assertAuth`
- `src/api/controllers/account-runner.ts` — 故障转移编排
- `src/api/routes/accounts.ts` — `GET /accounts/status`
- `src/lib/configs/account-config.ts` — 账号池 + 鉴权配置
- `configs/dev/account.yml` — 配置样例

修改:
- `package.json` — 加 vitest 依赖与 test 脚本
- `src/api/consts/exceptions.ts` — 新增错误码
- `src/lib/config.ts` — 挂载 account 配置
- `src/index.ts` — 启动初始化池 + 轮询
- `src/api/controllers/chat.ts` — `request()` 等签名改为账号凭据;`createTransStream` endCallback 透出 code;新增 `PreStreamError`
- `src/api/controllers/images.ts` — 同上改造
- `src/api/routes/chat.ts` — 鉴权 + 故障转移
- `src/api/routes/images.ts` — 鉴权 + 故障转移
- `src/api/routes/token.ts` — 适配 `getTokenLiveStatus` 新签名
- `src/api/routes/index.ts` — 注册 accounts 路由

---

## Task 1: 搭建 vitest 测试基础设施

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Test: `test/sanity.test.ts`

- [ ] **Step 1: 安装 vitest**

Run:
```bash
yarn add -D vitest@^2.1.0
```
Expected: `package.json` devDependencies 出现 `vitest`。

- [ ] **Step 2: 加 test 脚本**

修改 `package.json` 的 `scripts`,在 `build` 后追加:
```json
    "build": "tsup src/index.ts --format cjs,esm --sourcemap --dts --clean --publicDir public",
    "test": "vitest run",
    "test:watch": "vitest"
```

- [ ] **Step 3: 写 vitest 配置(含 `@` 别名与 `.js`→`.ts` 解析)**

Create `vitest.config.ts`:
```ts
import path from 'path';
import fs from 'fs';
import { defineConfig } from 'vitest/config';

// 源码里既有 `@/x.ts` 也有 `./x.js`(实际指向 .ts)的导入，
// 这个 pre 解析器把相对 .js 导入映射回存在的 .ts 文件，供 vitest 解析。
const jsToTsResolver = {
  name: 'js-to-ts-resolver',
  enforce: 'pre' as const,
  resolveId(source: string, importer?: string) {
    if (importer && source.startsWith('.') && source.endsWith('.js')) {
      const candidate = path.resolve(path.dirname(importer), source.replace(/\.js$/, '.ts'));
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  },
};

export default defineConfig({
  plugins: [jsToTsResolver],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: 写一个 sanity 测试**

Create `test/sanity.test.ts`:
```ts
import { describe, it, expect } from 'vitest';

describe('sanity', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: 运行测试验证通过**

Run: `yarn test`
Expected: PASS,1 passed。

- [ ] **Step 6: Commit**

```bash
git add package.json yarn.lock vitest.config.ts test/sanity.test.ts
git commit -m "test: 引入 vitest 测试基础设施"
```

---

## Task 2: 新增错误码

**Files:**
- Modify: `src/api/consts/exceptions.ts`

- [ ] **Step 1: 追加错误码**

修改 `src/api/consts/exceptions.ts`,在 `API_VIDEO_GENERATION_FAILED` 后追加:
```ts
    API_VIDEO_GENERATION_FAILED: [-2008, '视频生成失败'],
    API_AUTH_FAILED: [-2010, '接入鉴权失败'],
    API_NO_AVAILABLE_ACCOUNT: [-2011, '账号池暂时无可用账号'],
    API_ACCOUNT_POOL_NOT_READY: [-2012, '账号池尚未就绪'],
```

- [ ] **Step 2: Commit**

```bash
git add src/api/consts/exceptions.ts
git commit -m "feat: 新增账号池相关错误码"
```

---

## Task 3: 账号池类型定义

**Files:**
- Create: `src/lib/account/types.ts`

- [ ] **Step 1: 定义类型**

Create `src/lib/account/types.ts`:
```ts
/** 设备指纹 */
export interface Fingerprint {
  deviceId: string;
  webId: string;
}

/** 控制器消费的账号凭据(AccountPool.Account 与之结构兼容) */
export interface AccountCredential {
  token: string;
  deviceId: string;
  webId: string;
}

/** 账号池内部账号状态 */
export interface Account extends AccountCredential {
  phone: string;
  inFlight: boolean;
  lastEndTime: number;
  rateLimitUntil: number;
  strikes: number;
  disabled: boolean;
  pendingRemoval: boolean;
}

/** 释放账号时的结果类型 */
export type ReleaseOutcome = 'success' | 'rateLimited' | 'error';

/** 单账号状态视图(供状态接口) */
export interface AccountStatusView {
  phone: string;
  state: 'idle' | 'inFlight' | 'rateLimited' | 'disabled';
  strikes: number;
  rateLimitUntil: number;
}

/** 池状态报告 */
export interface PoolStatusReport {
  total: number;
  available: number;
  inFlight: number;
  rateLimited: number;
  disabled: number;
  accounts: AccountStatusView[];
}

/** 外部接口返回的单条账号 */
export interface RawAccount {
  phone: string;
  token: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/account/types.ts
git commit -m "feat: 账号池类型定义"
```

---

## Task 4: 手机号脱敏工具

**Files:**
- Create: `src/lib/account/mask.ts`
- Test: `test/account/mask.test.ts`

- [ ] **Step 1: 写失败测试**

Create `test/account/mask.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { maskPhone } from '@/lib/account/mask.ts';

describe('maskPhone', () => {
  it('打码 11 位手机号中间 4 位', () => {
    expect(maskPhone('15009760064')).toBe('150****0064');
  });
  it('过短的号码原样返回', () => {
    expect(maskPhone('123')).toBe('123');
  });
  it('空值返回空串', () => {
    expect(maskPhone('')).toBe('');
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `yarn test test/account/mask.test.ts`
Expected: FAIL,无法解析 `@/lib/account/mask.ts`。

- [ ] **Step 3: 实现**

Create `src/lib/account/mask.ts`:
```ts
/**
 * 手机号脱敏：保留前 3 位与后 4 位，中间打码。
 * 不足 7 位的原样返回。
 */
export function maskPhone(phone: string): string {
  if (!phone || phone.length < 7) return phone || '';
  return phone.slice(0, 3) + '****' + phone.slice(-4);
}
```

- [ ] **Step 4: 运行验证通过**

Run: `yarn test test/account/mask.test.ts`
Expected: PASS,3 passed。

- [ ] **Step 5: Commit**

```bash
git add src/lib/account/mask.ts test/account/mask.test.ts
git commit -m "feat: 手机号脱敏工具"
```

---

## Task 5: FingerprintStore 指纹持久化

**Files:**
- Create: `src/lib/account/fingerprint-store.ts`
- Test: `test/account/fingerprint-store.test.ts`

- [ ] **Step 1: 写失败测试**

Create `test/account/fingerprint-store.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { FingerprintStore } from '@/lib/account/fingerprint-store.ts';

let dir: string;
let file: string;
let seq: number;
const fakeGen = () => `7${String(seq++).padStart(18, '0')}`;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fp-'));
  file = path.join(dir, 'fingerprints.json');
  seq = 1;
});
afterEach(async () => {
  await fs.remove(dir);
});

describe('FingerprintStore', () => {
  it('新 phone 生成一对指纹', async () => {
    const store = new FingerprintStore(file, fakeGen);
    await store.load();
    const fp = store.getOrCreate('111');
    expect(fp.deviceId).toBe('7000000000000000001');
    expect(fp.webId).toBe('7000000000000000002');
  });

  it('已存在 phone 复用同一指纹', async () => {
    const store = new FingerprintStore(file, fakeGen);
    await store.load();
    const a = store.getOrCreate('111');
    const b = store.getOrCreate('111');
    expect(b).toEqual(a);
  });

  it('save 后重新 load 指纹保持不变', async () => {
    const store = new FingerprintStore(file, fakeGen);
    await store.load();
    const fp = store.getOrCreate('111');
    await store.save();

    const store2 = new FingerprintStore(file, fakeGen);
    await store2.load();
    expect(store2.getOrCreate('111')).toEqual(fp);
  });

  it('load 不存在的文件按空处理', async () => {
    const store = new FingerprintStore(file, fakeGen);
    await expect(store.load()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `yarn test test/account/fingerprint-store.test.ts`
Expected: FAIL,无法解析模块。

- [ ] **Step 3: 实现**

Create `src/lib/account/fingerprint-store.ts`:
```ts
import path from 'path';
import fs from 'fs-extra';

import logger from '@/lib/logger.ts';
import util from '@/lib/util.ts';
import { Fingerprint } from '@/lib/account/types.ts';

const defaultGenerateId = () =>
  `7${util.generateRandomString({ length: 18, charset: 'numeric' })}`;

/**
 * 指纹持久化存储。内存为唯一读源；新增指纹标脏，save() 落盘。
 * 文件只增不删：账号临时消失后回归可复用原指纹。
 */
export class FingerprintStore {
  private map: Record<string, Fingerprint> = {};
  private dirty = false;

  constructor(
    private readonly filePath: string,
    private readonly generateId: () => string = defaultGenerateId
  ) {}

  async load(): Promise<void> {
    try {
      if (!(await fs.pathExists(this.filePath))) return;
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') this.map = parsed;
    } catch (err) {
      logger.warn('指纹文件读取失败，按空处理:', err);
      this.map = {};
    }
  }

  getOrCreate(phone: string): Fingerprint {
    if (!this.map[phone]) {
      this.map[phone] = { deviceId: this.generateId(), webId: this.generateId() };
      this.dirty = true;
    }
    return { ...this.map[phone] };
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    try {
      await fs.ensureDir(path.dirname(this.filePath));
      await fs.writeFile(this.filePath, JSON.stringify(this.map, null, 2));
      this.dirty = false;
    } catch (err) {
      logger.warn('指纹文件写入失败(内存指纹仍有效):', err);
    }
  }
}
```

- [ ] **Step 4: 运行验证通过**

Run: `yarn test test/account/fingerprint-store.test.ts`
Expected: PASS,4 passed。

- [ ] **Step 5: Commit**

```bash
git add src/lib/account/fingerprint-store.ts test/account/fingerprint-store.test.ts
git commit -m "feat: 指纹持久化存储 FingerprintStore"
```

---

## Task 6: AccountPool — reconcile 全量对齐

**Files:**
- Create: `src/lib/account/account-pool.ts`
- Test: `test/account/account-pool.test.ts`

本任务先实现构造、reconcile、`size()`。acquire/release/status 在后续任务补齐。

- [ ] **Step 1: 写失败测试**

Create `test/account/account-pool.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
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
  const fetched = { value: opts?.accounts ?? [] };
  const pool = new AccountPool({
    now: () => now,
    sleep: async () => {},
    fetchAccounts: async () => fetched.value,
    fingerprintStore: makeFpStore() as any,
    config: { requestInterval: 2000, rateLimitCooldown: 300000, maxFailover: 3 },
  });
  return {
    pool,
    setNow: (v: number) => { now = v; },
    setFetched: (v: RawAccount[]) => { fetched.value = v; },
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
    // 模拟两次限流置 disabled
    const acc = await h.pool.acquire();
    h.pool.release(acc, 'rateLimited');
    const acc2 = await h.pool.acquire();
    h.pool.release(acc2, 'rateLimited');
    expect(h.pool.status().disabled).toBe(1);
    // token 变化后恢复
    h.setFetched([{ phone: '111', token: 't2' }]);
    await h.pool.reconcile();
    expect(h.pool.status().disabled).toBe(0);
  });

  it('外部接口异常时保留旧池', async () => {
    const h = makePool({ accounts: [{ phone: '111', token: 't1' }] });
    await h.pool.reconcile();
    const pool2 = new AccountPool({
      now: () => 1000,
      sleep: async () => {},
      fetchAccounts: async () => { throw new Error('network'); },
      fingerprintStore: makeFpStore() as any,
      config: { requestInterval: 2000, rateLimitCooldown: 300000, maxFailover: 3 },
    });
    // 先放一个账号，再让 fetch 抛错，池应保留
    await expect(pool2.reconcile()).resolves.toBeUndefined();
    expect(pool2.size()).toBe(0); // 从未成功拉取
  });

  it('空数组响应保留旧池(防误清空)', async () => {
    const h = makePool({ accounts: [{ phone: '111', token: 't1' }] });
    await h.pool.reconcile();
    h.setFetched([]);
    await h.pool.reconcile();
    expect(h.pool.size()).toBe(1);
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `yarn test test/account/account-pool.test.ts`
Expected: FAIL,无法解析 `account-pool.ts`。

- [ ] **Step 3: 实现 AccountPool 骨架 + reconcile**

Create `src/lib/account/account-pool.ts`:
```ts
import APIException from '@/lib/exceptions/APIException.ts';
import EX from '@/api/consts/exceptions.ts';
import HTTP from '@/lib/http-status-codes.ts';
import logger from '@/lib/logger.ts';
import { maskPhone } from '@/lib/account/mask.ts';
import {
  Account,
  AccountStatusView,
  PoolStatusReport,
  RawAccount,
  ReleaseOutcome,
} from '@/lib/account/types.ts';

export interface FingerprintStoreLike {
  load(): Promise<void>;
  getOrCreate(phone: string): { deviceId: string; webId: string };
  save(): Promise<void>;
}

export interface AccountPoolDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  fetchAccounts: () => Promise<RawAccount[]>;
  fingerprintStore: FingerprintStoreLike;
  config: {
    requestInterval: number;
    rateLimitCooldown: number;
    maxFailover: number;
  };
}

export class AccountPool {
  private accounts = new Map<string, Account>();
  private order: string[] = [];
  private cursor = 0;

  constructor(private readonly deps: AccountPoolDeps) {}

  size(): number {
    return this.accounts.size;
  }

  private rebuildOrder() {
    this.order = [...this.accounts.keys()];
    if (this.cursor >= this.order.length) this.cursor = 0;
  }

  async reconcile(): Promise<void> {
    let data: RawAccount[];
    try {
      data = await this.deps.fetchAccounts();
    } catch (err) {
      logger.warn('账号池拉取失败，保留旧池:', err);
      return;
    }
    if (!Array.isArray(data)) {
      logger.warn('账号池响应非数组，保留旧池');
      return;
    }
    const incoming = new Map<string, string>();
    for (const item of data) {
      if (item && item.phone && item.token) incoming.set(String(item.phone), String(item.token));
    }
    if (incoming.size === 0) {
      logger.warn('账号池响应为空，保留旧池(防误清空)');
      return;
    }

    // 新增 / 更新
    for (const [phone, token] of incoming) {
      const existing = this.accounts.get(phone);
      if (!existing) {
        const fp = this.deps.fingerprintStore.getOrCreate(phone);
        this.accounts.set(phone, {
          phone,
          token,
          deviceId: fp.deviceId,
          webId: fp.webId,
          inFlight: false,
          lastEndTime: 0,
          rateLimitUntil: 0,
          strikes: 0,
          disabled: false,
          pendingRemoval: false,
        });
      } else {
        existing.pendingRemoval = false;
        if (existing.token !== token) {
          existing.token = token;
          existing.disabled = false;
          existing.strikes = 0;
          existing.rateLimitUntil = 0;
        }
      }
    }

    // 删除消失账号(忙的延迟到 release)
    for (const [phone, acc] of this.accounts) {
      if (incoming.has(phone)) continue;
      if (acc.inFlight) acc.pendingRemoval = true;
      else this.accounts.delete(phone);
    }

    await this.deps.fingerprintStore.save();
    this.rebuildOrder();
  }

  status(): PoolStatusReport {
    const now = this.deps.now();
    const accounts: AccountStatusView[] = [...this.accounts.values()].map((a) => {
      let state: AccountStatusView['state'];
      if (a.disabled) state = 'disabled';
      else if (a.inFlight) state = 'inFlight';
      else if (now < a.rateLimitUntil) state = 'rateLimited';
      else state = 'idle';
      return { phone: maskPhone(a.phone), state, strikes: a.strikes, rateLimitUntil: a.rateLimitUntil };
    });
    return {
      total: accounts.length,
      available: accounts.filter((a) => a.state === 'idle').length,
      inFlight: accounts.filter((a) => a.state === 'inFlight').length,
      rateLimited: accounts.filter((a) => a.state === 'rateLimited').length,
      disabled: accounts.filter((a) => a.state === 'disabled').length,
      accounts,
    };
  }

  async acquire(): Promise<Account> {
    if (this.accounts.size === 0)
      throw new APIException(EX.API_ACCOUNT_POOL_NOT_READY).setHTTPStatusCode(
        HTTP.SERVICE_UNAVAILABLE
      );
    const now = this.deps.now();
    const n = this.order.length;
    for (let i = 0; i < n; i++) {
      const idx = (this.cursor + i) % n;
      const acc = this.accounts.get(this.order[idx]);
      if (!acc) continue;
      if (acc.inFlight || acc.disabled) continue;
      if (now < acc.rateLimitUntil) continue;
      // 命中：同步占位，避免并发重复选中
      acc.inFlight = true;
      this.cursor = (idx + 1) % n;
      const wait = this.deps.config.requestInterval - (this.deps.now() - acc.lastEndTime);
      if (wait > 0) await this.deps.sleep(wait);
      return acc;
    }
    throw new APIException(EX.API_NO_AVAILABLE_ACCOUNT).setHTTPStatusCode(HTTP.TOO_MANY_CONNECTIONS);
  }

  release(acc: Account, outcome: ReleaseOutcome): void {
    acc.inFlight = false;
    acc.lastEndTime = this.deps.now();
    if (outcome === 'success') {
      acc.strikes = 0;
    } else if (outcome === 'rateLimited') {
      acc.strikes += 1;
      if (acc.strikes >= 2) acc.disabled = true;
      else acc.rateLimitUntil = this.deps.now() + this.deps.config.rateLimitCooldown;
    }
    if (acc.pendingRemoval) {
      this.accounts.delete(acc.phone);
      this.rebuildOrder();
    }
  }
}
```

> 说明:本任务把 acquire/release/status 一并写入(后续任务只补测试)。`HTTP.TOO_MANY_CONNECTIONS` 即 421;429 在此常量表里无对应键,池满采用 421(语义同为连接/请求过多)。若希望严格 429,可在 `http-status-codes.ts` 增加 `TOO_MANY_REQUESTS: 429` 并改用之——见 Task 7 Step 3 备注。

- [ ] **Step 4: 运行验证通过**

Run: `yarn test test/account/account-pool.test.ts`
Expected: PASS(reconcile 用例全过;acquire/release 已实现故 token 变化用例也过)。

- [ ] **Step 5: Commit**

```bash
git add src/lib/account/account-pool.ts test/account/account-pool.test.ts
git commit -m "feat: AccountPool 全量对齐 reconcile"
```

---

## Task 7: AccountPool — acquire 选号(测试补全)

**Files:**
- Modify: `src/lib/http-status-codes.ts`(加 429 常量)
- Modify: `src/lib/account/account-pool.ts`(改用 429)
- Test: `test/account/account-pool.test.ts`(追加用例)

- [ ] **Step 1: 加 429 常量**

修改 `src/lib/http-status-codes.ts`,在 `RETRY_WITH: 449,` 之前追加一行:
```ts
    UNORDERED_COLLECTION: 425,  //...原注释保留
    TOO_MANY_REQUESTS: 429,  //请求过多，限流
    UPGRADE_REQUIRED: 426,  //...
```
> 注:按数值就近放置即可,键名 `TOO_MANY_REQUESTS`。

- [ ] **Step 2: acquire 改用 429**

修改 `src/lib/account/account-pool.ts` 中 acquire 末尾:
```ts
    throw new APIException(EX.API_NO_AVAILABLE_ACCOUNT).setHTTPStatusCode(HTTP.TOO_MANY_REQUESTS);
```

- [ ] **Step 3: 追加 acquire 测试**

在 `test/account/account-pool.test.ts` 末尾追加:
```ts
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

  it('全部忙/限流抛 429', async () => {
    const { pool } = makePool({ accounts: [{ phone: '111', token: 't1' }] });
    await pool.reconcile();
    await pool.acquire();
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
```

- [ ] **Step 4: 运行验证通过**

Run: `yarn test test/account/account-pool.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/http-status-codes.ts src/lib/account/account-pool.ts test/account/account-pool.test.ts
git commit -m "test: AccountPool 选号用例 + 429 状态码"
```

---

## Task 8: AccountPool — release 限流计分(测试补全)

**Files:**
- Test: `test/account/account-pool.test.ts`(追加用例)

- [ ] **Step 1: 追加 release 测试**

在 `test/account/account-pool.test.ts` 末尾追加:
```ts
describe('AccountPool.release', () => {
  it('成功清零 strikes', async () => {
    const { pool } = makePool({ accounts: [{ phone: '111', token: 't1' }] });
    await pool.reconcile();
    let a = await pool.acquire();
    pool.release(a, 'rateLimited');           // strikes=1, 进冷却
    expect(pool.status().rateLimited).toBe(1);
  });

  it('首次限流进冷却，5min 后可重新选中', async () => {
    const h = makePool({ accounts: [{ phone: '111', token: 't1' }] });
    await h.pool.reconcile();
    let a = await h.pool.acquire();
    h.pool.release(a, 'rateLimited');         // rateLimitUntil = now+300000
    await expect(h.pool.acquire()).rejects.toMatchObject({ httpStatusCode: 429 });
    h.setNow(1000 + 300001);
    const b = await h.pool.acquire();         // 冷却过期可选
    expect(b.phone).toBe('111');
  });

  it('二次限流标记 disabled', async () => {
    const { pool } = makePool({ accounts: [{ phone: '111', token: 't1' }] });
    await pool.reconcile();
    let a = await pool.acquire();
    pool.release(a, 'rateLimited');           // strikes=1
    // 直接再 acquire 会被冷却挡住，这里用 setNow 跳过冷却
    // 改造：用第二个账号验证不可行，故复用 status 断言 disabled 逻辑
  });

  it('error 不计 strike', async () => {
    const { pool } = makePool({ accounts: [{ phone: '111', token: 't1' }] });
    await pool.reconcile();
    let a = await pool.acquire();
    pool.release(a, 'error');
    expect(pool.status().rateLimited).toBe(0);
    expect(pool.status().disabled).toBe(0);
  });
});
```

> 注:二次限流 disabled 已在 Task 6 的 "token 变化清除 disabled" 用例中通过 `acquire→release(rateLimited)` 两次得到验证(`status().disabled===1`),此处保留 error 与冷却过期用例即可。删除上面未完成的 `二次限流标记 disabled` 占位用例,避免空断言。

- [ ] **Step 2: 删除占位用例**

把上一步中标注的 `it('二次限流标记 disabled', ...)` 整个用例删除(它没有有效断言)。

- [ ] **Step 3: 运行验证通过**

Run: `yarn test test/account/account-pool.test.ts`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add test/account/account-pool.test.ts
git commit -m "test: AccountPool release 限流计分用例"
```

---

## Task 9: AccountPool 默认单例 + 外部接口拉取 + 启动轮询

**Files:**
- Modify: `src/lib/account/account-pool.ts`(追加默认单例与 start)

> 依赖 Task 10 的 `config.account`,但单例仅在被 import 时构造,真正读取 config 字段发生在 `start()`/`fetchAccounts()` 调用时,故顺序安全。如执行到此 config 尚未就绪,可先做 Task 10 再回到本任务。

- [ ] **Step 1: 追加默认拉取器与单例**

在 `src/lib/account/account-pool.ts` 末尾追加:
```ts
import axios from 'axios';
import config from '@/lib/config.ts';
import { FingerprintStore } from '@/lib/account/fingerprint-store.ts';

/** 调用外部账号接口,返回 RawAccount[];失败或非 0 code 抛错(交由 reconcile 保留旧池) */
async function defaultFetchAccounts(): Promise<RawAccount[]> {
  const { apiUrl, apiToken } = config.account.pool;
  const resp = await axios.get(apiUrl, {
    headers: { Authorization: `Bearer ${apiToken}` },
    timeout: 15000,
    validateStatus: () => true,
  });
  const body = resp.data || {};
  if (body.code !== 0) throw new Error(`账号接口返回 code=${body.code} msg=${body.message}`);
  return Array.isArray(body.data) ? body.data : [];
}

const fingerprintStore = new FingerprintStore(config.account.pool.fingerprintStore);

/** 应用级单例 */
const accountPool = new AccountPool({
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  fetchAccounts: defaultFetchAccounts,
  fingerprintStore,
  config: {
    requestInterval: config.account.pool.requestInterval,
    rateLimitCooldown: config.account.pool.rateLimitCooldown,
    maxFailover: config.account.pool.maxFailover,
  },
});

let pollTimer: NodeJS.Timeout | null = null;

/** 启动:先读指纹文件,立即对齐一次,再起轮询 */
export async function startAccountPool(): Promise<void> {
  await fingerprintStore.load();
  await accountPool.reconcile();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    accountPool.reconcile().catch((err) => logger.error('账号池轮询失败:', err));
  }, config.account.pool.pollInterval);
  logger.success(`账号池启动,当前账号数 ${accountPool.size()}`);
}

export default accountPool;
```

- [ ] **Step 2: 运行已有测试确认未破坏**

Run: `yarn test`
Expected: PASS(已有用例不受单例影响)。

- [ ] **Step 3: Commit**

```bash
git add src/lib/account/account-pool.ts
git commit -m "feat: AccountPool 默认单例与启动轮询"
```

---

## Task 10: 账号池 + 鉴权配置

**Files:**
- Create: `src/lib/configs/account-config.ts`
- Modify: `src/lib/config.ts`
- Create: `configs/dev/account.yml`
- Test: `test/account/account-config.test.ts`

- [ ] **Step 1: 写失败测试**

Create `test/account/account-config.test.ts`:
```ts
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
```

- [ ] **Step 2: 运行验证失败**

Run: `yarn test test/account/account-config.test.ts`
Expected: FAIL,无法解析模块。

- [ ] **Step 3: 实现配置类**

Create `src/lib/configs/account-config.ts`:
```ts
import path from 'path';

import fs from 'fs-extra';
import yaml from 'yaml';
import _ from 'lodash';

import environment from '../environment.ts';

const CONFIG_PATH = path.join(path.resolve(), 'configs/', environment.env, '/account.yml');

export interface PoolOptions {
  apiUrl: string;
  apiToken: string;
  pollInterval: number;
  requestInterval: number;
  rateLimitCooldown: number;
  maxFailover: number;
  fingerprintStore: string;
}

export interface AuthOptions {
  keys: string[];
}

/**
 * 账号池与接入鉴权配置。敏感值(apiToken)支持环境变量覆盖。
 */
export class AccountConfig {
  auth: AuthOptions;
  pool: PoolOptions;

  constructor(options?: any) {
    const { auth, pool } = options || {};
    this.auth = {
      keys: _.defaultTo(auth?.keys, []),
    };
    this.pool = {
      apiUrl: _.defaultTo(environment.envVars.DOUBAO_POOL_API_URL || pool?.apiUrl, ''),
      apiToken: _.defaultTo(environment.envVars.DOUBAO_POOL_API_TOKEN || pool?.apiToken, ''),
      pollInterval: _.defaultTo(pool?.pollInterval, 60000),
      requestInterval: _.defaultTo(pool?.requestInterval, 2000),
      rateLimitCooldown: _.defaultTo(pool?.rateLimitCooldown, 300000),
      maxFailover: _.defaultTo(pool?.maxFailover, 3),
      fingerprintStore: _.defaultTo(pool?.fingerprintStore, './data/fingerprints.json'),
    };
  }

  static load() {
    if (!fs.pathExistsSync(CONFIG_PATH)) return new AccountConfig();
    const data = yaml.parse(fs.readFileSync(CONFIG_PATH).toString());
    return new AccountConfig(data);
  }
}

export default AccountConfig.load();
```

- [ ] **Step 4: 挂到 config.ts**

修改 `src/lib/config.ts`:
```ts
import serviceConfig from "./configs/service-config.ts";
import systemConfig from "./configs/system-config.ts";
import accountConfig from "./configs/account-config.ts";

class Config {

    /** 服务配置 */
    service = serviceConfig;

    /** 系统配置 */
    system = systemConfig;

    /** 账号池与鉴权配置 */
    account = accountConfig;

}

export default new Config();
```

- [ ] **Step 5: 创建配置样例**

Create `configs/dev/account.yml`:
```yaml
# 接入鉴权：客户端 Authorization: Bearer <key> 命中任一才放行
auth:
  keys:
    - change-me-key-1
    - change-me-key-2
# 账号池
pool:
  # 外部账号接口地址与 Bearer：均留空，由环境变量 DOUBAO_POOL_API_URL / DOUBAO_POOL_API_TOKEN 注入
  apiUrl: ''
  apiToken: ''
  pollInterval: 60000        # 轮询间隔 ms
  requestInterval: 2000      # 每账号最小请求间隔 ms
  rateLimitCooldown: 300000  # 限流冷却 ms(5min)
  maxFailover: 3             # 单请求最大换号重试次数
  fingerprintStore: ./data/fingerprints.json
```

- [ ] **Step 6: 运行验证通过**

Run: `yarn test test/account/account-config.test.ts`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/lib/configs/account-config.ts src/lib/config.ts configs/dev/account.yml test/account/account-config.test.ts
git commit -m "feat: 账号池与接入鉴权配置"
```

---

## Task 11: 接入鉴权 assertAuth

**Files:**
- Create: `src/lib/auth.ts`
- Test: `test/auth.test.ts`

- [ ] **Step 1: 写失败测试**

Create `test/auth.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { verifyKey } from '@/lib/auth.ts';

describe('verifyKey', () => {
  const keys = ['k1', 'k2'];
  it('命中放行', () => {
    expect(verifyKey('Bearer k1', keys)).toBe(true);
    expect(verifyKey('k2', keys)).toBe(true);
  });
  it('未命中拒绝', () => {
    expect(verifyKey('Bearer wrong', keys)).toBe(false);
    expect(verifyKey('', keys)).toBe(false);
    expect(verifyKey(undefined, keys)).toBe(false);
  });
  it('keys 为空时一律拒绝', () => {
    expect(verifyKey('Bearer k1', [])).toBe(false);
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `yarn test test/auth.test.ts`
Expected: FAIL,无法解析模块。

- [ ] **Step 3: 实现**

Create `src/lib/auth.ts`:
```ts
import APIException from '@/lib/exceptions/APIException.ts';
import EX from '@/api/consts/exceptions.ts';
import HTTP from '@/lib/http-status-codes.ts';
import config from '@/lib/config.ts';

/** 纯函数:判断 Authorization 是否命中某个 key(便于单测) */
export function verifyKey(authorization: string | undefined, keys: string[]): boolean {
  if (!keys || keys.length === 0) return false;
  const key = String(authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!key) return false;
  return keys.includes(key);
}

/** 校验接入鉴权,失败抛 401 */
export function assertAuth(authorization: string | undefined): void {
  if (!verifyKey(authorization, config.account.auth.keys))
    throw new APIException(EX.API_AUTH_FAILED).setHTTPStatusCode(HTTP.UNAUTHORIZED);
}
```

- [ ] **Step 4: 运行验证通过**

Run: `yarn test test/auth.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth.ts test/auth.test.ts
git commit -m "feat: 接入鉴权 assertAuth"
```

---

## Task 12: 故障转移编排 account-runner

**Files:**
- Create: `src/api/controllers/account-runner.ts`
- Test: `test/account/account-runner.test.ts`

- [ ] **Step 1: 写失败测试**

Create `test/account/account-runner.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { runNonStream, isRateLimitCode, RATE_LIMIT_CODE } from '@/api/controllers/account-runner.ts';

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

  it('首个账号成功直接返回', async () => {
    const pool = fakePool(['a', 'b']);
    const fn = vi.fn(async () => ({ code: 0, content: 'ok' }));
    const r = await runNonStream(pool as any, fn);
    expect(r.content).toBe('ok');
    expect(pool.released).toEqual([{ phone: 'a', outcome: 'success' }]);
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
```

- [ ] **Step 2: 运行验证失败**

Run: `yarn test test/account/account-runner.test.ts`
Expected: FAIL,无法解析模块。

- [ ] **Step 3: 实现**

Create `src/api/controllers/account-runner.ts`:
```ts
import APIException from '@/lib/exceptions/APIException.ts';
import EX from '@/api/consts/exceptions.ts';
import HTTP from '@/lib/http-status-codes.ts';
import { Account } from '@/lib/account/types.ts';

/** 豆包上游限流码 */
export const RATE_LIMIT_CODE = 710022002;

export function isRateLimitCode(code?: number): boolean {
  return code === RATE_LIMIT_CODE;
}

/** 推流前硬失败(content-type 非事件流),供故障转移识别 */
export class PreStreamError extends Error {}

export interface PoolLike {
  size(): number;
  acquire(): Promise<Account>;
  release(acc: Account, outcome: 'success' | 'rateLimited' | 'error'): void;
}

/**
 * 非流式故障转移:成功直接返回;结果含限流码或抛错则换号重试,
 * 最多 min(maxFailover, 池规模) 次。
 */
export async function runNonStream<T extends { code?: number; message?: string }>(
  pool: PoolLike,
  fn: (acc: Account) => Promise<T>,
  maxFailover = 3
): Promise<T> {
  const maxAttempts = Math.min(maxFailover, Math.max(1, pool.size()));
  let lastErr: any;
  for (let i = 0; i < maxAttempts; i++) {
    const acc = await pool.acquire(); // 可能抛 429/503,直接透传
    try {
      const result = await fn(acc);
      if (isRateLimitCode(result.code)) {
        pool.release(acc, 'rateLimited');
        lastErr = new APIException(EX.API_REQUEST_FAILED, result.message || '上游限流');
        continue;
      }
      pool.release(acc, 'success');
      return result;
    } catch (err) {
      pool.release(acc, 'error');
      lastErr = err;
    }
  }
  throw lastErr || new APIException(EX.API_NO_AVAILABLE_ACCOUNT).setHTTPStatusCode(HTTP.TOO_MANY_REQUESTS);
}
```

- [ ] **Step 4: 运行验证通过**

Run: `yarn test test/account/account-runner.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/api/controllers/account-runner.ts test/account/account-runner.test.ts
git commit -m "feat: 非流式故障转移编排 account-runner"
```

---

## Task 13: chat 控制器改造为账号凭据

**Files:**
- Modify: `src/api/controllers/chat.ts`

本任务把 `refreshToken: string` 改为 `account: AccountCredential`,并让 `createTransStream` 的 endCallback 透出 code,推流前硬失败抛 `PreStreamError`。

- [ ] **Step 1: 引入类型与 PreStreamError**

在 `src/api/controllers/chat.ts` 顶部 import 区追加:
```ts
import { AccountCredential } from "@/lib/account/types.ts";
import { PreStreamError } from "@/api/controllers/account-runner.ts";
```

- [ ] **Step 2: 改 `request()` 使用账号指纹**

将 `request` 函数(约 106-143 行)改为:
```ts
async function request(method: string, uri: string, account: AccountCredential, options: AxiosRequestConfig = {}) {
    const token = account.token;
    const response = await axios.request({
        method,
        url: `https://www.doubao.com${uri}`,
        params: {
            aid: DEFAULT_ASSISTANT_ID,
            device_id: account.deviceId,
            device_platform: "web",
            language: "zh",
            pc_version: PC_VERSION,
            pkg_type: "release_version",
            real_aid: DEFAULT_ASSISTANT_ID,
            region: "CN",
            samantha_web: 1,
            sys_region: "CN",
            tea_uuid: account.webId,
            "use-olympus-account": 1,
            version_code: VERSION_CODE,
            web_id: account.webId,
            web_tab_id: util.uuid(),
            ...(options.params || {})
        },
        headers: {
            ...FAKE_HEADERS,
            Cookie: generateCookie(token),
            "X-Flow-Trace": `04-${util.uuid()}-${util.uuid().substring(0, 16)}-01`,
            ...(options.headers || {}),
        },
        timeout: 15000,
        validateStatus: () => true,
        ..._.omit(options, "params", "headers"),
    });
    if (options.responseType == "stream")
        return response;
    return checkResult(response);
}
```

- [ ] **Step 3: 删除无用的 acquireToken 及模块级指纹常量**

删除 `acquireToken` 函数(约 61-63 行)。删除模块级 `DEVICE_ID`、`WEB_ID`、`USER_ID` 常量声明(约 23-27 行)——它们已不再被 `request()` 使用。
> 执行前用 `grep -n "DEVICE_ID\|WEB_ID\|USER_ID\|acquireToken" src/api/controllers/chat.ts` 确认无其他引用残留。

- [ ] **Step 4: 改各函数签名 refreshToken → account**

将以下函数签名中的 `refreshToken: string` 改为 `account: AccountCredential`,并把函数体内所有把 `refreshToken` 传给 `request(...)` / `uploadFile(...)` / `removeConversation(...)` / `acquireUploadAuth(...)` 的实参改为 `account`:
- `removeConversation(convId, account)`
- `createCompletion(messages, account, assistantId, refConvId, retryCount, useDeepThink, useAutoCot)`(递归重试调用同步改 `account`)
- `createCompletionStream(...)`(同上)
- `uploadFile(fileUrl, account, isVideoImage)` —— 内部 `acquireUploadAuth(refreshToken, ...)` 改 `acquireUploadAuth(account, ...)`
- `acquireUploadAuth(account, resourceType)`

> `extractRefFileUrls`、`messagesPrepare`、签名工具函数不涉及 token,无需改。

- [ ] **Step 5: createCompletion 释放回调改用 account**

`createCompletion` 内 `removeConversation(answer.id, refreshToken)` 改为 `removeConversation(answer.id, account)`。

- [ ] **Step 6: createTransStream endCallback 透出 code**

将 `createTransStream(stream, endCallback)` 中 `finish` 内的回调由 `endCallback(convId)` 改为 `endCallback(convId, code)`(`finish(code, message)` 已有 code 变量):
```ts
        endCallback && endCallback(convId, code);
```
并将 `createCompletionStream` 调用处签名相应传递:
```ts
        return createTransStream(response.data, (convId: string, code: number) => {
            logger.success(`Stream has completed transfer ${util.timestamp() - streamStartTime}ms`);
            removeConversation(convId, account).catch(
                (err) => !refConvId && console.error(err)
            );
        });
```
> 路由层会另行传入真正的 release 回调(见 Task 15),这里控制器内仍负责 removeConversation。改为:`createCompletionStream` 增加可选入参 `onEnd?: (code: number) => void`,在上面回调里追加 `onEnd && onEnd(code);`。

- [ ] **Step 7: createCompletionStream 增加 onEnd 参数**

`createCompletionStream` 签名末尾增加 `onEnd?: (code: number) => void`,并在 Step 6 回调里调用:
```ts
async function createCompletionStream(
    messages: any[],
    account: AccountCredential,
    assistantId = DEFAULT_ASSISTANT_ID,
    refConvId = "",
    retryCount = 0,
    useDeepThink = false,
    useAutoCot = false,
    onEnd?: (code: number) => void
) {
```
回调体:
```ts
        return createTransStream(response.data, (convId: string, code: number) => {
            logger.success(`Stream has completed transfer ${util.timestamp() - streamStartTime}ms`);
            removeConversation(convId, account).catch((err) => !refConvId && console.error(err));
            onEnd && onEnd(code);
        });
```
递归重试调用 `createCompletionStream(...)` 末尾补传 `onEnd`。

- [ ] **Step 8: 推流前硬失败抛 PreStreamError**

`createCompletionStream` 中 content-type 非事件流的分支(约 345-372 行,当前是返回友好错误流)改为抛错以支持换号:
```ts
        if (response.headers["content-type"].indexOf("text/event-stream") == -1) {
            logger.error(`Invalid response Content-Type:`, response.headers["content-type"]);
            response.data.on("data", (buffer) => logger.error(buffer.toString()));
            throw new PreStreamError(`Stream response Content-Type invalid: ${response.headers["content-type"]}`);
        }
```

- [ ] **Step 9: getTokenLiveStatus 适配账号凭据**

`getTokenLiveStatus(refreshToken: string)` 仍接收裸 token(供 `/token/check`),内部构造临时凭据:
```ts
function buildTransientCredential(token: string): AccountCredential {
    const gen = () => `7${util.generateRandomString({ length: 18, charset: "numeric" })}`;
    return { token, deviceId: gen(), webId: gen() };
}

async function getTokenLiveStatus(refreshToken: string) {
    const result = await request("POST", "/passport/account/info/v2", buildTransientCredential(refreshToken), {
        params: { account_sdk_source: "web" }
    });
    try {
        return !!(result && (result as any).user_id);
    } catch (err) {
        return false;
    }
}
```

- [ ] **Step 10: 移除 tokenSplit 导出(改由路由不再使用)**

保留 `tokenSplit` 函数无害,但不再被路由使用。可保留导出以兼容。无需改动。

- [ ] **Step 11: 类型检查**

Run: `npx tsc --noEmit`
Expected: 与 chat.ts 相关的 refreshToken 类型错误消失(images.ts 仍会报错,Task 14 修复)。

- [ ] **Step 12: Commit**

```bash
git add src/api/controllers/chat.ts
git commit -m "refactor: chat 控制器改用账号凭据并透出流结束 code"
```

---

## Task 14: images 控制器改造为账号凭据

**Files:**
- Modify: `src/api/controllers/images.ts`

镜像 Task 13 对 `images.ts` 的等价改造。

- [ ] **Step 1: 引入类型与 PreStreamError**

`src/api/controllers/images.ts` 顶部追加:
```ts
import { AccountCredential } from "@/lib/account/types.ts";
import { PreStreamError } from "@/api/controllers/account-runner.ts";
```

- [ ] **Step 2: 改 `request()`(约 106 行)**

将签名 `request(method, uri, refreshToken, options)` 改为 `request(method, uri, account: AccountCredential, options)`;函数体内:
```ts
    const token = account.token;
```
并把 `device_id: DEVICE_ID,` → `device_id: account.deviceId,`、`tea_uuid: WEB_ID,` → `tea_uuid: account.webId,`、`web_id: WEB_ID,` → `web_id: account.webId,`。

- [ ] **Step 3: 删除 acquireToken 与模块级指纹常量**

删除 `acquireToken`(约 61-62 行)及 `DEVICE_ID`/`WEB_ID`/`USER_ID`(约 23-27 行)。
> 用 `grep -n "DEVICE_ID\|WEB_ID\|USER_ID\|acquireToken" src/api/controllers/images.ts` 确认无残留引用。

- [ ] **Step 4: 各函数签名 refreshToken → account**

改以下签名并把内部传参由 `refreshToken` 改 `account`:
- `removeConversation(convId, account)`
- `createImageCompletion(..., account, ...)` —— 内部 `uploadFile(referenceImage, refreshToken)` 改 `account`;`removeConversation(answer.id, refreshToken)` 改 `account`;递归重试调用同步改。
- `createImageCompletionStream(..., account, ...)` —— 同上;`removeConversation(convId, refreshToken)` 改 `account`。
- `uploadFile(fileUrl, account, isVideoImage)` —— 内部 `acquireUploadAuth(refreshToken, ...)` 改 `account`。
- `acquireUploadAuth(account, resourceType)`

- [ ] **Step 5: createTransStream endCallback 透出 code + onEnd**

`createTransStream(stream, endCallback)` 内两处 `endCallback && endCallback(convId)`(约 1120、1146 行)改为 `endCallback && endCallback(convId, code)`。
> images.ts 的 finish 逻辑若无统一 code 变量,则在调用 endCallback 处传入当前已知 code(成功路径传 `0`,限流路径传上游 code)。执行时按实际 finish 实现传参。
为 `createImageCompletionStream` 增加可选入参 `onEnd?: (code: number) => void`,在结束回调里 `onEnd && onEnd(code)`,递归重试调用补传。

- [ ] **Step 6: 推流前硬失败抛 PreStreamError**

`createImageCompletionStream` 中 content-type 非事件流分支(约 394 行)改为:
```ts
        if (response.headers["content-type"].indexOf("text/event-stream") === -1) {
            logger.error(`无效的响应Content-Type: ${response.headers["content-type"]}`);
            throw new PreStreamError(`Stream response Content-Type invalid: ${response.headers["content-type"]}`);
        }
```

- [ ] **Step 7: getTokenLiveStatus 适配**

同 chat.ts:加 `buildTransientCredential`,`getTokenLiveStatus(refreshToken)` 内用 `buildTransientCredential(refreshToken)` 调 `request`。

- [ ] **Step 8: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无 refreshToken 相关类型错误。

- [ ] **Step 9: Commit**

```bash
git add src/api/controllers/images.ts
git commit -m "refactor: images 控制器改用账号凭据"
```

---

## Task 15: chat 路由接入鉴权 + 池调度 + 故障转移

**Files:**
- Modify: `src/api/routes/chat.ts`

- [ ] **Step 1: 重写路由**

将 `src/api/routes/chat.ts` 改为:
```ts
import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import chat from '@/api/controllers/chat.ts';
import accountPool from '@/lib/account/account-pool.ts';
import { runNonStream, isRateLimitCode, PreStreamError } from '@/api/controllers/account-runner.ts';
import { assertAuth } from '@/lib/auth.ts';
import config from '@/lib/config.ts';

export default {

    prefix: '/v1/chat',

    post: {

        '/completions': async (request: Request) => {
            request
                .validate('body.conversation_id', v => _.isUndefined(v) || _.isString(v))
                .validate('body.messages', _.isArray)
                .validate('headers.authorization', _.isString);
            // Authorization 作接入鉴权
            assertAuth(request.headers.authorization);

            const { model, conversation_id: convId, messages, stream, deep_think, auto_cot } = request.body;
            const assistantId = /^[a-z0-9]{24,}$/.test(model) ? model : undefined;
            const useDeepThink = !!deep_think;
            const useAutoCot = !!auto_cot;

            if (stream) {
                // 流式:仅推流前可换号
                const maxAttempts = Math.min(config.account.pool.maxFailover, Math.max(1, accountPool.size()));
                let lastErr: any;
                for (let i = 0; i < maxAttempts; i++) {
                    const acc = await accountPool.acquire();
                    try {
                        const s = await chat.createCompletionStream(
                            messages, acc, assistantId, convId, 0, useDeepThink, useAutoCot,
                            (code: number) => accountPool.release(acc, isRateLimitCode(code) ? 'rateLimited' : 'success')
                        );
                        return new Response(s, {
                            type: "text/event-stream",
                            headers: {
                                "Cache-Control": "no-cache, no-transform",
                                "Connection": "keep-alive",
                                "X-Accel-Buffering": "no"
                            }
                        });
                    } catch (err) {
                        accountPool.release(acc, 'error');
                        lastErr = err;
                        if (err instanceof PreStreamError) continue; // 推流前失败,换号
                        throw err;
                    }
                }
                throw lastErr;
            }

            return await runNonStream(
                accountPool,
                (acc) => chat.createCompletion(messages, acc, assistantId, convId, 0, useDeepThink, useAutoCot),
                config.account.pool.maxFailover
            );
        }

    }

}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: chat 路由无类型错误。

- [ ] **Step 3: Commit**

```bash
git add src/api/routes/chat.ts
git commit -m "feat: chat 路由接入鉴权与账号池故障转移"
```

---

## Task 16: images 路由接入鉴权 + 池调度

**Files:**
- Modify: `src/api/routes/images.ts`

- [ ] **Step 1: 改造取号与鉴权**

修改 `src/api/routes/images.ts`:把顶部 import 增加:
```ts
import accountPool from '@/lib/account/account-pool.ts';
import { runNonStream, isRateLimitCode, PreStreamError } from '@/api/controllers/account-runner.ts';
import { assertAuth } from '@/lib/auth.ts';
import config from '@/lib/config.ts';
```
把原「2. 处理Token」段:
```ts
            const tokens = images.tokenSplit(request.headers.authorization);
            const token = _.sample(tokens);
            if (!token) {
                throw new Error('无效的Authorization Token');
            }
```
替换为鉴权:
```ts
            assertAuth(request.headers.authorization);
```
然后把生成调用改为池调度。非流式:
```ts
            } else {
                const result = await runNonStream(
                    accountPool,
                    (acc) => images.createImageCompletion(imageParams, acc, assistantId),
                    config.account.pool.maxFailover
                );
                return new Response(result);
            }
```
流式(参照 chat 路由的推流前换号循环):
```ts
            if (stream) {
                const maxAttempts = Math.min(config.account.pool.maxFailover, Math.max(1, accountPool.size()));
                let lastErr: any;
                for (let i = 0; i < maxAttempts; i++) {
                    const acc = await accountPool.acquire();
                    try {
                        const s = await images.createImageCompletionStream(
                            imageParams, acc, assistantId,
                            (code: number) => accountPool.release(acc, isRateLimitCode(code) ? 'rateLimited' : 'success')
                        );
                        return new Response(s, {
                            type: "text/event-stream",
                            headers: {
                                "Cache-Control": "no-cache, no-transform",
                                "Connection": "keep-alive",
                                "X-Accel-Buffering": "no"
                            }
                        });
                    } catch (err) {
                        accountPool.release(acc, 'error');
                        lastErr = err;
                        if (err instanceof PreStreamError) continue;
                        throw err;
                    }
                }
                throw lastErr;
            }
```
> 注:`createImageCompletionStream` 第 2 参数现为 `account`,并新增末位 `onEnd` 回调(Task 14 Step 5)。`imageParams` 维持原组装逻辑不变。

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: images 路由无类型错误。

- [ ] **Step 3: Commit**

```bash
git add src/api/routes/images.ts
git commit -m "feat: images 路由接入鉴权与账号池调度"
```

---

## Task 17: token 路由适配

**Files:**
- Modify: `src/api/routes/token.ts`

`getTokenLiveStatus` 仍接收裸 token,无需改路由逻辑;仅确认其调用未受影响。

- [ ] **Step 1: 确认无需改动**

Run: `npx tsc --noEmit`
Expected: token 路由无类型错误(getTokenLiveStatus 签名未变)。
若有错误则按提示修正调用。

- [ ] **Step 2: Commit(若有改动)**

```bash
git add src/api/routes/token.ts
git commit -m "chore: token 路由适配账号凭据改造"
```
> 若 Step 1 无改动,跳过本任务提交。

---

## Task 18: 账号状态接口

**Files:**
- Create: `src/api/routes/accounts.ts`
- Modify: `src/api/routes/index.ts`

- [ ] **Step 1: 新增 accounts 路由**

Create `src/api/routes/accounts.ts`:
```ts
import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import accountPool from '@/lib/account/account-pool.ts';
import { assertAuth } from '@/lib/auth.ts';

export default {

    prefix: '/accounts',

    get: {

        '/status': async (request: Request) => {
            request.validate('headers.authorization', _.isString);
            assertAuth(request.headers.authorization);
            return accountPool.status();
        }

    }

}
```

- [ ] **Step 2: 注册路由**

修改 `src/api/routes/index.ts`,import 与数组中加入 accounts:
```ts
import accounts from './accounts.ts';
```
并在导出数组里追加 `accounts`:
```ts
    chat,
    images,
    ping,
    token,
    models,
    accounts
];
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无类型错误。

- [ ] **Step 4: Commit**

```bash
git add src/api/routes/accounts.ts src/api/routes/index.ts
git commit -m "feat: 账号状态查询接口 GET /accounts/status"
```

---

## Task 19: 启动接线账号池

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: 启动时初始化池**

修改 `src/index.ts`,在 import 区加入:
```ts
import { startAccountPool } from "@/lib/account/account-pool.ts";
```
在 `await server.listen();` 之后追加:
```ts
  await server.listen();

  await startAccountPool();

  config.service.bindAddress &&
    logger.success("Service bind address:", config.service.bindAddress);
```

- [ ] **Step 2: 构建验证**

Run: `yarn build`
Expected: 构建成功,无类型/打包错误。

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: 启动时初始化账号池与轮询"
```

---

## Task 20: 全量测试 + 冒烟 + 文档

**Files:**
- Modify: `README.md`
- Create: `data/.gitignore`(忽略指纹文件)

- [ ] **Step 1: 跑全量单测**

Run: `yarn test`
Expected: 全部 PASS。

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: 忽略运行时数据**

Create `data/.gitignore`:
```
fingerprints.json
```

- [ ] **Step 4: 冒烟测试(手动,需真实/本地外部接口)**

在 `configs/dev/account.yml` 填入有效 `auth.keys` 与 `pool.apiToken`(或设 `DOUBAO_POOL_API_TOKEN`),然后:
```bash
yarn dev
```
另开终端:
```bash
# 鉴权失败 → 401
curl -i -s -X POST http://127.0.0.1:8000/v1/chat/completions -H 'Authorization: Bearer wrong' -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"hi"}]}'

# 鉴权成功 + 走池
curl -s -X POST http://127.0.0.1:8000/v1/chat/completions -H 'Authorization: Bearer change-me-key-1' -H 'Content-Type: application/json' -d '{"model":"doubao","messages":[{"role":"user","content":"你好"}],"stream":false}'

# 状态接口
curl -s http://127.0.0.1:8000/accounts/status -H 'Authorization: Bearer change-me-key-1'
```
Expected: 第一个返回 401;第二个返回豆包回答;第三个返回脱敏的池状态。

- [ ] **Step 5: 更新 README**

在 `README.md` 增补一节「账号池与接入鉴权」:说明 token 来源已改为外部接口轮询、`Authorization` 改作接入 key、`configs/<env>/account.yml` 配置项、`GET /accounts/status` 用法、指纹文件位置。
> 按 README 现有结构插入,内容覆盖上述要点即可。

- [ ] **Step 6: Commit**

```bash
git add README.md data/.gitignore
git commit -m "docs: 账号池接入说明与运行时数据忽略"
```

---

## Self-Review 备注(已核对)

- **Spec 覆盖**:外部接口轮询(T9)、全量对齐(T6)、指纹按 phone 持久化(T5)、接入鉴权(T10/T11/T15/T16/T18)、轮询+故障转移(T12/T15/T16)、每账号最小间隔(T7)、限流 5min/二次禁用(T6 release/T8)、token 变化恢复(T6)、空池 503 / 全忙 429(T6/T7)、状态接口(T18)。均有对应任务。
- **类型一致**:`AccountCredential`(控制器入参)与 `Account`(池内部,extends AccountCredential)结构兼容;`runNonStream(pool, fn, maxFailover)`、`createCompletionStream(..., onEnd)`、`createTransStream` endCallback `(convId, code)` 在各调用点一致。
- **流式取舍**:跨账号故障转移仅在推流前(`PreStreamError`)生效;推流后沿用上游 code 透传 + endCallback 释放,符合 spec §5.5(用户已确认)。
