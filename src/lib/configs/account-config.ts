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

/** 解析逗号分隔的环境变量为去空格、滤空的字符串数组 */
function parseEnvList(value: string | undefined): string[] {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 账号池与接入鉴权配置。敏感值(apiToken、auth.keys)支持环境变量覆盖且优先级更高。
 */
export class AccountConfig {
  auth: AuthOptions;
  pool: PoolOptions;

  constructor(options?: any) {
    const { auth, pool } = options || {};
    const envKeys = parseEnvList(process.env.DOUBAO_AUTH_KEYS);
    this.auth = {
      keys: envKeys.length > 0 ? envKeys : _.defaultTo(auth?.keys, []),
    };
    this.pool = {
      apiUrl: _.defaultTo(process.env.DOUBAO_POOL_API_URL || pool?.apiUrl, ''),
      apiToken: _.defaultTo(process.env.DOUBAO_POOL_API_TOKEN || pool?.apiToken, ''),
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
