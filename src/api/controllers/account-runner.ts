import APIException from '@/lib/exceptions/APIException.ts';
import EX from '@/api/consts/exceptions.ts';
import HTTP from '@/lib/http-status-codes.ts';
import { Account, ReleaseOutcome } from '@/lib/account/types.ts';

/** 豆包上游限流码 */
export const RATE_LIMIT_CODE = 710022002;

/** 豆包上游风控码(滑块验证等),命中即禁用该账号 */
export const DISABLE_CODE = 710022004;

export function isRateLimitCode(code?: number): boolean {
  return code === RATE_LIMIT_CODE;
}

export function isDisableCode(code?: number): boolean {
  return code === DISABLE_CODE;
}

/** 把上游响应码归类为释放结果:风控码禁用、限流码冷却、其余按成功透传 */
export function classifyRelease(code?: number): ReleaseOutcome {
  if (isDisableCode(code)) return 'disabled';
  if (isRateLimitCode(code)) return 'rateLimited';
  return 'success';
}

/** 推流前硬失败(content-type 非事件流),供故障转移识别 */
export class PreStreamError extends Error {}

export interface PoolLike {
  size(): number;
  acquire(): Promise<Account>;
  release(acc: Account, outcome: ReleaseOutcome): void;
}

/**
 * 非流式故障转移:成功直接返回;结果含限流码/风控码或抛错则换号重试,
 * 最多 min(maxFailover, 池规模) 次。风控码额外禁用该账号。
 */
export async function runNonStream<T extends { code?: number; message?: string }>(
  pool: PoolLike,
  fn: (acc: Account) => Promise<T>,
  maxFailover = 3
): Promise<T & { account: string }> {
  const maxAttempts = Math.min(maxFailover, Math.max(1, pool.size()));
  let lastErr: any;
  for (let i = 0; i < maxAttempts; i++) {
    const acc = await pool.acquire(); // 可能抛 429/503，直接透传
    try {
      const result = await fn(acc);
      const outcome = classifyRelease(result.code);
      if (outcome === 'success') {
        pool.release(acc, 'success');
        // 在最外层标注本次请求实际使用的账号手机号
        return { ...result, account: acc.phone };
      }
      // 限流(冷却)或风控(禁用):释放后换号重试
      pool.release(acc, outcome);
      lastErr = new APIException(EX.API_REQUEST_FAILED, result.message || '上游限流/风控');
    } catch (err) {
      pool.release(acc, 'error');
      lastErr = err;
    }
  }
  throw lastErr || new APIException(EX.API_NO_AVAILABLE_ACCOUNT).setHTTPStatusCode(HTTP.TOO_MANY_REQUESTS);
}
