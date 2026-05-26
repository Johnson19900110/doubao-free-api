import axios from 'axios';

import APIException from '@/lib/exceptions/APIException.ts';
import EX from '@/api/consts/exceptions.ts';
import HTTP from '@/lib/http-status-codes.ts';
import logger from '@/lib/logger.ts';
import config from '@/lib/config.ts';
import { maskPhone } from '@/lib/account/mask.ts';
import { FingerprintStore } from '@/lib/account/fingerprint-store.ts';
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
    throw new APIException(EX.API_NO_AVAILABLE_ACCOUNT).setHTTPStatusCode(HTTP.TOO_MANY_REQUESTS);
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

/** 调用外部账号接口,返回 RawAccount[];失败或非 0 code 抛错(交由 reconcile 保留旧池) */
async function defaultFetchAccounts(): Promise<RawAccount[]> {
  // apiUrl/apiToken 的环境变量覆盖已在 AccountConfig 层统一处理,此处直接取配置
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
