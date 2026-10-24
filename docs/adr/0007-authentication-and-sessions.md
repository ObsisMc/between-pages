# ADR-0007：登录、身份与会话

日期：2026-10-24。状态：已采纳；正式登录尚未实现，真实 Google 端点待阶段 1 联调验证。来源：[ADR-0006](./0006-formal-stack.md) 第 25 条，[Better Auth spike](../../prototypes/auth/README.md)。

## 背景

[规格 §3](../diary-spec.md) 要求：

- 用 Google 登录；应用有自己稳定的 userId；Google 身份按 issuer + subject 绑定，不以邮箱作为永久身份；
- 登录与"连接 Google 备份"是两个独立流程，拒绝 Drive 权限也能写日记；
- HTTP、WebSocket 握手、订阅和每次写入都要校验身份与空间成员资格；
- 会话过期或被撤销后不再接受新写入，但本地待同步内容要保留；
- 不能自己手写 OAuth 协议。

ADR-0006 把 Better Auth 列为第一候选。本 ADR 根据 spike 和维护情况调研做出决定。

## 决策

### 认证库

1. 使用 **Better Auth 1.7.x**，锁定精确版本，且不低于 1.7.7（修复了 OAuth state 被冒用登录他人账号的严重漏洞）。它运行在 `apps/api` 进程内，按官方 Fastify 方式挂在 `/api/auth/*`，与 Web 同源。
2. 生产环境**不启用任何 Better Auth 插件**。该项目历史上的安全公告大多出在插件（sso、oauth-provider、api-key 等）上，少用插件就是少受影响。测试中用 `genericOAuth` 插件把登录指向本地模拟的 OIDC 服务。

### 身份

3. 登录只用 `socialProviders.google`，只申请 `openid email profile`，不申请任何 Drive 权限。
4. 应用 userId 是 UUID（`advanced.database.generateId: 'uuid'`），与 Google subject 无关。
5. Google 身份是 `account` 表中的 `(providerId = 'google', accountId = sub)`，并由我们自己的唯一索引保证一一对应。Better Auth 默认只建了普通索引，spike 中防止重复用户的其实是 `user.email` 的唯一约束，属于碰巧，不能依赖。
   - providerId 固定为 `google`，等价于 issuer 固定为 Google，因此不需要单独存 issuer。
6. **关闭账号自动合并**（`account.accountLinking.enabled: false`）。Better Auth 默认会把邮箱相同的新 Google 账号合并进已有用户，这违反"不以邮箱作为身份"。关闭后：
   - 同一 subject 换了邮箱，仍是同一个用户；
   - 不同 subject 使用已存在的邮箱时，登录被拒绝（`account_not_linked`），不建会话、不建用户。界面要把这个错误明确告诉用户，处理方式是人工协助，不自动合并。

### 不保存 Google 令牌

7. 登录账号**不保存任何 Google 令牌**：用 `databaseHooks.account.create/update.before` 在写库前清空 access、refresh 和 ID 令牌，同时打开 `encryptOAuthTokens` 作为第二道防线。spike 发现 `encryptOAuthTokens` 只加密 access 和 refresh 令牌，ID 令牌（含邮箱和名字）仍以明文 JWT 存储。
8. Drive 授权**不经过 Better Auth**。Better Auth 每次登录都会覆盖账号上的令牌，而登录账号本身也不存令牌。Drive 用独立的 OAuth 流程（`drive.file` + offline），refresh token 加密保存在自己的表里，见 [ADR-0004](./0004-google-export-and-recovery.md)。具体库在实现备份时选定。

### 会话

9. 会话存在数据库里；Cookie 为 `HttpOnly`、`SameSite=Lax`。生产环境强制 `useSecureCookies`，即 `Secure` 属性加 `__Secure-` 前缀。
10. **实施默认**：会话有效期 30 天，每天自动续期（`expiresIn` 30 天、`updateAge` 1 天），可以调整。**关闭 cookie 缓存**，否则撤销会话后，旧 cookie 在缓存时间内仍然有效。
11. 退出登录会删除会话行，旧 cookie 立刻在 HTTP 和 WebSocket 上失效（spike 已验证）。

### 每一次请求都校验

12. API 路由通过 `auth.api.getSession` 得到用户。WebSocket 握手在接受连接之前做同样的校验，并传 `disableRefresh`、`disableCookieCache`：握手响应无法回写续期 cookie，也必须实时读取撤销状态。
13. **CSRF**：Better Auth 只检查它自己端点的 `Origin`。所以 API 的所有非 GET 路由和 WebSocket 握手都由我们自己检查 `Origin` 是否属于可信来源，作为阶段 1 的一部分实现并测试。
14. WebSocket 连接建立后，每次写入都要重新确认会话仍然有效，并且用户仍是该空间成员；会话失效时拒绝写入，客户端把内容保留为待同步。具体写在协同协议里（阶段 2）。

### 不归 Better Auth 管的部分

15. 双人空间、成员和邀请用我们自己的表，不用 Better Auth 的 organization 插件。"最多两人、一次性邀请、并发接受不出现第三人"由 PG 约束和事务保证，见 [规格 §3](../diary-spec.md)。
16. 退出或切换账号时锁定本机缓存（AUTH-06），这属于客户端的职责。

### 表结构与升级

17. Better Auth 的表定义用 `npx auth generate` 生成 Drizzle schema，提交到 `apps/api`，用 drizzle-kit 迁移；第 5 条的唯一索引写在同一个 schema 里。旧的 `@better-auth/cli` 已弃用。
18. 用 Dependabot 和 GitHub 安全公告跟踪 Better Auth。安全补丁优先升级，升级后重跑认证测试。

### 测试

19. 自动化测试用本地模拟 OIDC 服务（`oauth2-mock-server`）走完整的登录往返。它通过 `genericOAuth` 插件接入，provider id 同为 `google`，与生产配置的唯一差别是 provider 的定义方式。
20. 真实 Google 登录在阶段 1 联调时人工验证一次，并记录在验收证据里。

## 替代方案

- **openid-client v6 + 自己实现会话**：OIDC 部分经过认证、维护良好，完全可控。但会话、CSRF、撤销、限流都要自己写，而规格明确要求不要自己手写这类协议。Better Auth 用配置就满足了规则，暂不采用。如果 Better Auth 的安全问题持续出现在核心代码，这是首选退路。
- **Auth.js（@auth/core）**：2025-09 起由 Better Auth 团队接手，只做安全维护，官方推荐新项目用 Better Auth。
- **Lucia**：npm 包已弃用，只作为学习资料。
- **Supabase Auth**：托管或自建的独立服务，默认按已验证邮箱自动合并身份，还要单独部署或依赖外部服务。
- **Clerk、WorkOS**：托管收费服务，身份数据在第三方。对两个人的应用来说太重，会话也不方便和自己的 WebSocket 共用。
- **Better Auth 的 organization 插件管理空间**：通用的多成员模型，"最多两人、一次性邀请"仍要自己约束，还会增加插件面，见第 2 条。
- **保留默认的账号自动合并**：Google 会返回 `email_verified`，默认就会按邮箱合并，违反规格。

## 后果

- 登录的协议细节、会话和登录端点的 CSRF 由成熟的库负责；项目只维护配置、令牌清理钩子、唯一索引、自己路由的 Origin 检查和空间表。
- Better Auth 发版频繁，从 2024-12 到 2026-09 有 37 条安全公告。需要持续跟进补丁，不能装好就不管。
- 邮箱冲突时要人工处理，理论上会遇到；两人规模下可以接受。
- spike 用的是 `genericOAuth` 加模拟服务，没有覆盖 `socialProviders.google` 对真实 Google ID 令牌的校验、同意页面和 HTTPS 下的 cookie 前缀；这些在第 20 条的联调中验证。

对应验收：AUTH-01、AUTH-04、AUTH-05 的服务端部分由本方案直接覆盖，AUTH-02、AUTH-03 依赖第 15 条，AUTH-06 依赖第 16 条。
