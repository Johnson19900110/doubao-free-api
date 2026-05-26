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
