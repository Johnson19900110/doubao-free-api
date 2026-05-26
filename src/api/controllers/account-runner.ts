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
    const acc = await pool.acquire(); // 可能抛 429/503，直接透传
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
