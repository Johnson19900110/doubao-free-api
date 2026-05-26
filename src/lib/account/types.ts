/** 设备指纹 */
export interface Fingerprint {
  deviceId: string;
  webId: string;
}

/** 控制器消费的账号凭据(AccountPool.Account 与之结构兼容) */
export interface AccountCredential {
  token: string;
  deviceId: string;
  webId: string;
}

/** 账号池内部账号状态 */
export interface Account extends AccountCredential {
  phone: string;
  inFlight: boolean;
  lastEndTime: number;
  rateLimitUntil: number;
  strikes: number;
  /** 连续(非成功/非限流)错误计数,满阈值即禁用 */
  errorCount: number;
  disabled: boolean;
  pendingRemoval: boolean;
}

/** 释放账号时的结果类型 */
export type ReleaseOutcome = 'success' | 'rateLimited' | 'error';

/** 单账号状态视图(供状态接口) */
export interface AccountStatusView {
  phone: string;
  state: 'idle' | 'inFlight' | 'rateLimited' | 'disabled';
  strikes: number;
  rateLimitUntil: number;
}

/** 池状态报告 */
export interface PoolStatusReport {
  total: number;
  available: number;
  inFlight: number;
  rateLimited: number;
  disabled: number;
  accounts: AccountStatusView[];
}

/** 外部接口返回的单条账号 */
export interface RawAccount {
  phone: string;
  token: string;
}
