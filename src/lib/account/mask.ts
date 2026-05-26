/**
 * 手机号脱敏：保留前 3 位与后 4 位，中间打码。
 * 不足 7 位的原样返回。
 */
export function maskPhone(phone: string): string {
  if (!phone || phone.length < 7) return phone || '';
  return phone.slice(0, 3) + '****' + phone.slice(-4);
}
