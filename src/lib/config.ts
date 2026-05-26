import serviceConfig from "./configs/service-config.ts";
import systemConfig from "./configs/system-config.ts";
import accountConfig from "./configs/account-config.ts";

class Config {

    /** 服务配置 */
    service = serviceConfig;

    /** 系统配置 */
    system = systemConfig;

    /** 账号池与接入鉴权配置 */
    account = accountConfig;

}

export default new Config();