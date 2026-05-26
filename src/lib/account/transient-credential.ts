import util from "@/lib/util.ts";
import { AccountCredential } from "@/lib/account/types.ts";

/**
 * 由裸 token 构造临时账号凭据
 *
 * 用于不经账号池、仅需一次性请求的场景(如 token 存活检测)。
 * 设备指纹为随机生成，不参与持久化。
 *
 * @param token 豆包 sessionid
 */
export function buildTransientCredential(token: string): AccountCredential {
    const gen = () => `7${util.generateRandomString({ length: 18, charset: "numeric" })}`;
    return { token, deviceId: gen(), webId: gen() };
}
