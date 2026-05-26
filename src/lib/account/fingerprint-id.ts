import util from '@/lib/util.ts';
import { Fingerprint } from '@/lib/account/types.ts';

/** 生成豆包设备/Web 指纹:以 7 开头的 19 位数字串 */
export function generateFingerprintId(): string {
  return `7${util.generateRandomString({ length: 18, charset: 'numeric' })}`;
}

/** 校验指纹结构(用于信任边界:文件内容、外部数据) */
export function isValidFingerprint(value: unknown): value is Fingerprint {
  return (
    !!value &&
    typeof (value as Fingerprint).deviceId === 'string' &&
    typeof (value as Fingerprint).webId === 'string'
  );
}
