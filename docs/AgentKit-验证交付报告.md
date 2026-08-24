# 示例 Claude Agent SDK 接入 AgentKit — 能力验证交付报告

- 项目：示例 Agent Platform
- 验证对象：AgentKit Runtime 对 Claude Agent SDK 容器的纳管能力与网关鉴权/身份透传能力
- 结论：核心需求 R1、R2 全部验证通过；附加项 L4（真实模型链路）端到端打通

---

## 1. 背景与验证目标

客户团队基于 Claude Agent SDK 开发 Agent，需确认能否直接由火山 AgentKit 平台纳管并复用平台鉴权，
避免为适配平台而重写 Agent。据此定义两项必选需求：

- R1（容器纳管）：AgentKit Runtime 能部署并运行符合通用容器契约的 Claude Agent SDK Docker 镜像，
  含完整生命周期管理（构建、发布、就绪、热更新）。
- R2（网关鉴权与身份透传）：AgentKit 网关对 SDK 容器执行 JWT 边缘验签，并将已验证的用户身份
  经 HTTP Header 透传至容器内服务。

附加项 L4（真实模型链路）：容器从 cn-beijing 出海，经 LiteLLM Proxy 调用 Claude 并返回。
该项非必选（设计上支持优雅降级），本次一并验证通过。

---

## 2. 验证环境

| 项 | 值 |
| --- | --- |
| Runtime（JWT 鉴权） | `r-xxxxxxxxxxxxxxxxxxxx`（key_auth，对照）/ `r-xxxxxxxxxxxxxxxxxxxx`（custom_jwt） |
| JWT Runtime Endpoint | `https://xxxxxxxxxxxxxxxxxxxxx.apigateway-cn-beijing.volceapi.com` |
| 容器镜像 | `.../demo-agent/demo-agent-ts:20260824154253`（TypeScript / Claude Agent SDK） |
| OIDC IdP | 火山 Agent Identity 用户池 `userpool-xxxxxxxx-...`（OIDC / JWKS，RS256） |
| M2M 客户端 | `<m2m-client-id>`（client_credentials） |
| 模型网关 | LiteLLM Proxy `https://<litellm-proxy-host>`（别名 claude-sonnet-5 / claude-sonnet-4-6） |
| 容器契约 | 监听 8000；`GET /ping`；`POST /invocations`；诊断端点 `GET /net-probe`、`POST /invoke-debug` |

---

## 3. 验证结果矩阵

| 编号 | 验证项 | 状态 | 决定性证据 |
| --- | --- | --- | --- |
| R1 | 通用容器契约纳管 | 通过 | 非 Python（TS）镜像被 Runtime 纳管、发布至 `Status: Ready`；`/ping` 返回 `Healthy` |
| R2-a | JWT 边缘验签 | 通过 | 有效 token 200；无 token 401；伪造 token 401（三态清晰） |
| R2-b | 身份透传（JWT 模式） | 通过 | echo 与 agent 两路径均回显 `user_id=demo-user-001` |
| L4-net | 出海可达性 | 通过 | `/net-probe` `reachable:true`，`/v1/models` HTTP 200，往返约 700ms |
| L4-key | LiteLLM key 有效 | 通过 | `/v1/models` 返回模型列表，含 `claude-sonnet-5` |
| L4-agent | 真实模型调用 | 通过 | `mode:"agent"`，Claude 生成自然语言回答并复述出 `user_id` |

---

## 4. 关键证据

### 4.1 R2 JWT 验签三态

- 用例 A（有效 token）：`HTTP 200`，返回容器契约响应。
- 用例 B（无 token）：`JWT authentication failed.` / `HTTP 401`（网关层文案，请求未到达容器）。
- 用例 C（伪造 token）：`JWT authentication failed.` / `HTTP 401`。

三态构成完整差分证据：放行、无凭证拦截、验签失败拒签分别对应网关边缘的鉴权决策。
B、C 的报错来自网关层而非容器业务响应，反证非法请求在边缘即被拦截，未触达容器。

Token 关键声明（RS256）经解码核对与 Runtime 配置自洽：
`iss` = 用户池 issuer（与 DiscoveryUrl 同源）；`client_id`/`aud` 命中 `AllowedClients` 白名单。

### 4.2 R2 身份透传

有效 token + `user_id: demo-user-001` 请求，容器返回：

```json
{"mode":"echo","echo":{"prompt":"echo-check","user_id":"demo-user-001","session_id":null},
 "identity":{"user_id":"demo-user-001","session_id":null}}
```

两次不同 prompt 稳定回显同一 `user_id`，证明透传由网关按 Header 稳定注入，非偶发。

### 4.3 L4 真实模型调用

有效 token + `user_id: demo-user-001`，prompt 要求模型复述服务对象：

```json
{"mode":"agent","output":"我在为 user_id=\"demo-user-001\" 服务。",
 "identity":{"user_id":"demo-user-001","session_id":null},
 "model_gateway":"https://<litellm-proxy-host>"}
```

`mode:"agent"` 表明走真实 `query()` 路径；`output` 由 Claude 生成且正确复述 `user_id`，
证明透传身份经 systemPrompt 注入后贯穿至模型上下文。此单次调用同时闭合
JWT 验签 → 身份透传 → 真实模型调用三层链路。

---

## 5. 结论定性

- R1（容器纳管）成立：AgentKit Runtime 可纳管符合通用容器契约的任意语言镜像，
  完整走通构建 → 发布 → 就绪 → 热更新生命周期。
- R2（网关鉴权与身份透传）成立：平台 JWT（OIDC / RS256）边缘验签对 SDK 容器生效，
  正确区分放行 / 无凭证 / 验签失败，并将用户身份透传至容器乃至模型上下文。
- L4（真实模型链路）成立：容器可从 cn-beijing 出海经 LiteLLM 调用 Claude 并返回。

综上，客户团队无需重写 Agent、无需自建鉴权层，现有 Claude Agent SDK 容器可直接由 AgentKit
纳管并复用平台鉴权与身份透传。

---

## 6. 关键运维要点（复制部署时必读）

### 6.1 `IS_SANDBOX=1` 是 L4 的硬前提

veFaaS 以 root 启动容器（忽略 Dockerfile 的 `USER` 指令）。Claude Code CLI 在 root 身份下
拒绝 `bypassPermissions`（源码检查 `getuid()===0` 时 `process.exit(1)`，报
`--dangerously-skip-permissions cannot be used with root/sudo privileges`）。
需注入环境变量 `IS_SANDBOX=1` 绕过该检查。

- 判定线索：`/invoke-debug` 返回 `exit_code:1` 且 stderr 含上述 root 报错 → 未绕过；
  `exit_code:0` 且 stdout 出现模型回复 → 已绕过。
- 更稳做法：将 `ENV IS_SANDBOX=1` 写入 Dockerfile，使每个实例出生即带该变量，
  不受平台 env 下发时机与实例新旧影响。

### 6.2 配置变更后需等旧热实例回收

Runtime `MinInstance:0` 时，`runtime update` + `release` 的配置不会立即作用于正在保温的旧实例。
若变更后立即请求，可能命中旧实例，误判为“配置未生效”。

- 处理：变更后静默等待数分钟触发冷启动，或确认命中新实例后再判定。
- 注意：等待期间勿反复请求，每次请求都会重置空闲计时、续命旧实例。

### 6.3 环境变量注入约束

- `ANTHROPIC_AUTH_TOKEN` 必须为有效 LiteLLM Virtual Key（以 `sk-` 开头）且为纯 ASCII，
  否则 LiteLLM 返回 401 或容器内 fetch 抛 ByteString 错误。
- `runtime update --envs-json` 为整体替换而非增量合并，变更时须携带全套用户环境变量。
- 修改环境变量后必须执行 `runtime release` 才会下发到运行实例。

---

## 7. 未覆盖范围（据实说明）

- 身份透传的“可信性”未验证：本次 `user_id` 由调用方通过 HTTP Header 自带，而非从 token 派生。
  在“受信后端代调用”信任模型下，此为生产可用设计；仅当威胁模型要求“防冒充”
  （身份必须由 token 派生、网关不信任调用方自填 Header）时，需在客户应用层补充
  S2S token 兑换（`client_credentials + target_user_id`）机制。该机制属客户自建应用层，
  非 AgentKit 平台能力。
- 用户管理 OpenAPI（建号 / 授权）属客户自建业务，与鉴权透传机制正交，未在本次范围内。
- 边界健壮性（过期 token、白名单外 client、非 JSON body 契约、冷启动延迟收敛）为可选加固项，
  未在本次执行。

---

## 8. 安全与清理提醒

- 验证过程中明文出现的凭证建议轮换或作废：LiteLLM key、M2M client_secret。
- 测试用 JWT Runtime `r-xxxxxxxxxxxxxxxxxxxx` 若不再需要可删除。
