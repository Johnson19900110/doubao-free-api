import { AccountCredential } from "@/lib/account/types.ts";
import { generateFingerprintId } from "@/lib/account/fingerprint-id.ts";

/**
 * 由裸 token 构造临时账号凭据
 *
 * 用于不经账号池、仅需一次性请求的场景(如 token 存活检测)。
 * 设备指纹为随机生成，不参与持久化。
 *
 * @param token 豆包 sessionid
 */
export function buildTransientCredential(token: string): AccountCredential {
    return { token, deviceId: generateFingerprintId(), webId: generateFingerprintId() };
}
