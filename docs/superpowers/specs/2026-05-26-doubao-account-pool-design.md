# 豆包账号池 / 并发调度 设计文档

日期: 2026-05-26
状态: 待评审

## 1. 背景与目标

当前 `doubao-free-api` 通过请求头 `Authorization` 携带逗号分隔的 refresh_token 列表,每次请求用 `_.sample` 随机挑一个。设备指纹 `DEVICE_ID` / `WEB_ID` 在模块加载时只生成一次,被**所有账号、所有请求共用**,导致:

- 上百个账号在豆包侧看起来像「同一台设备」,提高限流/封号风险。
- 进程重启后整组指纹随机变化,等于「同一批账号突然换设备」,本身是异常信号。
- 随机选号不保证均匀,且不感知限流,被限流的号仍会被选中。
- 账号池来自人工维护的 Header,无法动态增删。

### 目标

1. 账号 token 不再走 `Authorization`,改为定时从外部接口拉取(线上维护上百个账号)。
2. 每分钟轮询外部接口并**全量对齐**账号池(增 / 删 / 改)。
3. `DEVICE_ID` / `WEB_ID` **每个账号固定一个**,持久化到磁盘,重启与 token 轮换后保持不变;新增账号实时生成。
4. `Authorization` 改为接入鉴权:配置文件维护若干 access key,命中才放行。
5. 选号采用轮询 + 限流故障转移 + 每账号最小请求间隔。
6. 提供账号可用状态查询接口。

### 非目标(YAGNI)

- 不做账号权重 / 优先级。
- 不做分布式多实例共享池(单进程内存池即可)。
- 不改动豆包上游协议本身。

## 2. 外部账号接口

```
GET {apiUrl}
Header: Authorization: Bearer {apiToken}

响应:
{
  "code": 0,
  "message": "success",
  "data": [
    { "phone": "15009760064", "token": "7b21374b4bde4d67a11f034d14e1bf60" },
    ...
  ]
}
```

- `phone` 是稳定的账号身份(指纹绑定键)。
- `token` 即豆包 sessionid,账号重新登录后**可能变化**。
- 仅当 `code === 0` 且 `data` 为数组时才据此对齐池;否则记录告警并保留上一轮池(避免接口抖动清空池)。

## 3. 架构

方案 A:独立账号池管理模块 + 路由层薄编排。

```
                    ┌─────────────────────────────────────┐
                    │            AccountPool               │
   每分钟轮询  ───▶  │  Map<phone, Account> (内存唯一数据源)  │
   外部接口         │  - reconcile() 全量对齐               │
                    │  - acquire() 选号(同步标记+冷却sleep) │
                    │  - release() 回收 + 限流计分          │
                    │  - status() / reset()                │
                    │  - 指纹持久化 (启动读 / 增量写)        │
                    └───────────────┬─────────────────────┘
                                    │ account {token, deviceId, webId}
   POST /v1/chat/completions        │
   POST /v1/images/generations  ──▶ 路由层编排(鉴权 + 故障转移)
                                    │  acquire → controller → release
                                    ▼
                          chat.ts / images.ts 控制器
                          (request() 用 account.deviceId/webId)
```

各单元职责:

| 单元 | 职责 | 依赖 |
|------|------|------|
| `AccountPool` | 池状态、选号调度、限流计分、指纹、轮询同步 | config, 外部接口, 指纹文件 |
| `FingerprintStore` | 指纹读写持久化 | 文件系统 |
| `AccountConfig` | 加载 `account.yml`(鉴权 key + 池参数) | yaml 文件 |
| 鉴权工具 | 校验 `Authorization: Bearer <key>` | AccountConfig |
| 路由层 | 鉴权 → acquire → 调控制器 → release/故障转移 | AccountPool, 控制器 |
| 控制器 | 调豆包上游,使用账号指纹 | account 对象 |

## 4. 数据模型

```ts
interface Account {
  phone: string;          // 账号身份 / 指纹键
  token: string;          // 豆包 sessionid,随轮询更新
  deviceId: string;       // 19位数字字符串,按 phone 随机生成一次
  webId: string;          // 19位数字字符串,按 phone 随机生成一次
  inFlight: boolean;      // 是否有请求正在使用(并发互斥)
  lastEndTime: number;    // 上次请求结束时间戳 ms(用于最小间隔)
  rateLimitUntil: number; // 限流冷却到期时间戳 ms,0 表示未限流
  strikes: number;        // 连续限流计数
  disabled: boolean;      // 二次限流后标记不可用
}
```

指纹文件 `./data/fingerprints.json`(只增不删):

```json
{ "15009760064": { "deviceId": "7xxxxxxxxxxxxxxxxxx", "webId": "7xxxxxxxxxxxxxxxxxx" } }
```

## 5. 关键流程

### 5.1 启动初始化

1. 读取 `AccountConfig`。
2. `FingerprintStore.load()` 读入指纹文件(不存在则空)。
3. 立即执行一次 `reconcile()` 拉取账号池(失败则池为空,记录告警,等待下一轮)。
4. `setInterval(reconcile, pollInterval)` 启动轮询。

初始化挂在 `src/index.ts` 启动序列里(`server.listen()` 之前或之后均可,选之后以免阻塞监听)。

### 5.2 reconcile() 全量对齐

```
resp = GET apiUrl (Bearer apiToken)
若 resp.code != 0 或 data 非数组 → 告警并 return(保留旧池)
incoming = Map<phone, token> from data

# 新增 / 更新
for (phone, token) in incoming:
    if phone not in pool:
        fp = FingerprintStore.getOrCreate(phone)   # 复用或新建并落盘
        pool[phone] = new Account(phone, token, fp.deviceId, fp.webId, idle...)
    else:
        acc = pool[phone]
        if acc.token != token:        # 重新登录,token 轮换
            acc.token = token
            acc.disabled = false      # 恢复可用
            acc.strikes = 0
            acc.rateLimitUntil = 0

# 删除消失账号(活跃池移除;指纹文件保留不删)
for phone in pool not in incoming:
    若 pool[phone].inFlight → 标记待删,本轮不删(等请求结束)
    否则 delete pool[phone]
```

并发安全:reconcile 与请求都在单线程事件循环上,reconcile 同步段不 await,不会与 acquire 交错出竞态;网络 await 阶段不修改池。

### 5.3 acquire(): 选号

```
candidates = 活跃池账号按轮询指针排序
eligible(acc) = !acc.inFlight && !acc.disabled && now >= acc.rateLimitUntil

从指针位置开始扫描一圈:
    找到第一个 eligible 的账号 acc:
        acc.inFlight = true            # 同步标记,占位(防并发重复选中)
        指针后移
        wait = requestInterval - (now - acc.lastEndTime)
        if wait > 0: await sleep(wait)  # 冷却中:补满最小间隔
        return acc
扫描一圈无 eligible → throw APIException(429, "账号池暂时无可用账号")
```

- 「忙 / 限流中 / 已禁用」跳过;「冷却中」可选,sleep 补满 2s。
- 标记 `inFlight=true` 在 await 之前完成,保证并发请求不会选中同一账号。

### 5.4 release(account, outcome)

```
account.inFlight = false
account.lastEndTime = now
switch outcome:
  success:        account.strikes = 0
  rateLimited:    account.strikes += 1
                  if account.strikes >= 2: account.disabled = true
                  else: account.rateLimitUntil = now + rateLimitCooldown
  error:          # 不计 strike
若该账号被标记待删(reconcile 期间消失)→ 此时从池移除
```

### 5.5 故障转移(路由层编排)

```
assertAuth(request)                 # 鉴权 key 校验,失败 401
maxAttempts = min(配置上限, 池规模)
for attempt in 1..maxAttempts:
    account = pool.acquire()        # 可能 throw 429
    try:
        result = controller.create...(messages, account, ...)
        # 非流式:result.code 为 710022002 视为限流
        if !stream && isRateLimitCode(result.code):
            pool.release(account, rateLimited); continue
        # 流式:仅当 controller 在首字节前抛出 PreStreamError 才可转移
        pool.release(account, success)
        return result
    catch err:
        outcome = isRateLimitError(err) ? rateLimited : error
        pool.release(account, outcome)
        if 流式已开始推流: throw err          # 不可转移
        if attempt < maxAttempts: continue
        throw err
```

流式限制:一旦开始向客户端推流(已写出首个 chunk),无法故障转移;此时沿用现有「把上游 code 透传到流尾」的行为。controller 的 content-type 校验阶段(推流前)发现硬失败时抛 `PreStreamError`,路由层据此换号重试。

### 5.6 鉴权

```
assertAuth(request):
    raw = request.headers.authorization || ""
    key = raw.replace(/^Bearer\s+/i, "").trim()
    if !config.auth.keys.includes(key): throw APIException(401, "无效的接入密钥")
```

应用于:`/v1/chat/completions`、`/v1/images/generations`、`/accounts/status`。

## 6. 接口变更

### 6.1 改造现有

- `POST /v1/chat/completions`:`Authorization` 由 token 列表改为接入 key;token 来自池。请求体保持兼容(model/messages/stream/deep_think/auto_cot/conversation_id 不变)。
- `POST /v1/images/generations`:同上改造鉴权与取号。

### 6.2 新增账号状态接口

`GET /accounts/status`(需 auth key):

```json
{
  "total": 100,
  "available": 95,
  "inFlight": 3,
  "rateLimited": 1,
  "disabled": 1,
  "accounts": [
    { "phone": "150****0064", "state": "idle|inFlight|rateLimited|disabled",
      "strikes": 0, "rateLimitUntil": 0 }
  ]
}
```

手机号脱敏(中间 4 位打码)。`state` 由字段推导。

说明:不提供手动恢复接口。被标记 `disabled` 的账号仅在轮询发现其 token 变化(重新登录)时自动恢复(见 §5.2)。

## 7. 配置

新增 `configs/<env>/account.yml`,新增 `AccountConfig` 类(沿用 `ServiceConfig`/`SystemConfig` 的 `load()` 模式),挂到 `config.ts` 的 `account` 字段。

```yaml
# 接入鉴权
auth:
  keys:
    - your-key-1
    - your-key-2
# 账号池
pool:
  apiUrl: <DOUBAO_POOL_API_URL>          # 建议用环境变量 DOUBAO_POOL_API_URL 覆盖
  apiToken: <DOUBAO_POOL_API_TOKEN>      # 真实凭据勿入库,用环境变量 DOUBAO_POOL_API_TOKEN 覆盖
  pollInterval: 60000        # 轮询间隔 ms
  requestInterval: 2000      # 每账号最小请求间隔 ms(从上次结束算)
  rateLimitCooldown: 300000  # 限流冷却 ms(5min)
  maxFailover: 3             # 单请求最大换号重试次数
  fingerprintStore: ./data/fingerprints.json
```

字段默认值在 `AccountConfig` 构造里用 `_.defaultTo` 兜底。`apiToken` 等敏感值支持从环境变量覆盖(沿用 `environment` 注入风格)。

## 8. 控制器改造点

- `chat.ts` 与 `images.ts` 删除模块级 `DEVICE_ID`/`WEB_ID` 常量的全局使用。
- `request()`、`createCompletion`、`createCompletionStream`(及 images 同名函数、`uploadFile` 等)签名从 `refreshToken: string` 改为接收 `account`(或显式传 `token, deviceId, webId`),内部 query 参数 `device_id`/`tea_uuid`/`web_id` 改用账号指纹。
- 路由层不再 `tokenSplit` + `_.sample`。
- `getTokenLiveStatus` 保留(供 `/token/check` 及可选的池健康校验)。

## 9. 错误处理

- 外部接口失败 / 非 0 code:告警,保留旧池,不清空。
- 池为空(启动后首轮还没拉到):请求返回 503「账号池尚未就绪」。
- 全部账号忙 / 限流:`acquire()` 抛 429。
- 鉴权失败:401。
- 指纹文件写失败:告警但不阻断(内存指纹仍有效);读失败按空文件处理。
- 控制器上游限流码 710022002:经 `release(rateLimited)` 计分并尝试故障转移。

## 10. 测试计划

单元测试(`AccountPool` 为主,可纯内存、mock 外部接口与时间):

- reconcile:新增 / 删除 / token 变化恢复 disabled / 接口异常保留旧池。
- 指纹:新 phone 生成并落盘;已存在 phone 复用;重启(重读文件)指纹不变。
- acquire:轮询顺序;跳过 busy/disabled/限流;冷却 sleep 补满间隔;全忙抛 429;并发不重复选中同一账号。
- release:success 清零 strikes;首次限流设冷却;二次限流置 disabled;error 不计分。
- 故障转移:非流式限流码换号重试;耗尽重试抛错;流式推流后不转移。
- 鉴权:命中放行、未命中 401。
- 状态接口:脱敏、状态推导。

集成测试:mock 豆包上游,验证 chat / images 端到端使用池中账号指纹。

覆盖率目标 80%+。

## 11. 实施阶段(供实现计划拆分)

1. 配置:`AccountConfig` + `account.yml` + 接入 `config.ts`。
2. `FingerprintStore`(读写 + getOrCreate)。
3. `AccountPool`(数据结构 + reconcile + acquire/release + status/reset),含单测。
4. 鉴权工具函数。
5. 启动接线(`index.ts` 初始化池 + 轮询)。
6. 控制器签名改造(chat / images 用账号指纹)。
7. 路由改造(鉴权 + acquire/release + 故障转移)。
8. 新增 `accounts` 路由(status)。
9. 集成测试 + 文档(README 更新接入方式)。
