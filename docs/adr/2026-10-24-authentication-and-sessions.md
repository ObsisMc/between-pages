# 用 Better Auth 只做登录和会话，领域用户与认证层分离

- 状态：已采纳
- 日期：2026-10-24
- 决策者：Ray
- 范围：认证
- 关联：依赖 ADR-0003；依赖 ADR-0004；依赖 ADR-0006；不变量 7 与 D7 的来源检查中退订接口的部分被 email-reminders 取代；D2 中 `display_name` 只由当前用户入口写入的部分被 display-name 取代

登录用 Better Auth，它运行在 API 进程内，只负责"这个请求是谁"：Google 登录、会话的创建、校验和撤销。用户数据分成两层：领域层的 `users` 表由我们自己维护，所有业务数据只引用它；认证层是 Better Auth 的表，存邮箱、登录身份和会话。登录身份按"登录方式 + subject"绑定，从不按邮箱合并；登录不保存任何 Google 令牌；会话存在数据库里，退出即失效。

本 ADR 同时是认证功能的实现规格：D9～D12 写清了接口契约、前端、配置和代码位置，"落地顺序"写明了 AI 可以自主完成的范围。按本文实现阶段 1～3 时**不需要再问任何问题**，除非出现"自主实现约定"里列出的停止条件；全部代码在一个 PR 里，由 Ray 评审并合并。

不在本 ADR 范围：双人空间与邀请（后续空间 ADR）、Drive 授权（ADR-0004）、退出时锁定本机缓存（客户端，随编辑器实现）、协同 WebSocket（阶段 2 协同 ADR；本文只规定它的握手怎么认证）、部署平台（后续部署 ADR）。

## 背景与问题

正式实现的第一步是登录。[规格 §3](../diary-spec.md) 对登录的要求是：

- 用 Google 登录；应用有自己稳定的 userId；Google 身份按签发方 + subject 绑定，不以邮箱作为永久身份。
- 登录与"连接 Google 备份"是两个独立流程，拒绝 Drive 权限也能写日记。
- HTTP、WebSocket 握手、订阅和每次写入都校验身份与空间成员资格；会话过期或被撤销后不再接受新写入，但本地待同步内容要保留。
- 退出或账号停用不能连带清除任何人已写的文字。
- 不自己手写 OAuth 和会话协议。

[ADR-0006](./0006-formal-stack.md) 把 Better Auth 列为第一候选。[spike](../../prototypes/auth/README.md) 用 Fastify + PostgreSQL 18 + 模拟 OIDC 服务验证了 14 项行为，同时发现它有三处默认行为与上面的要求冲突：默认按邮箱合并账号、ID 令牌明文入库、登录身份没有唯一索引。本 ADR 决定用不用它、怎么配置、哪些部分不交给它，以及整个认证功能前后端怎么实现。

## 决策依据

1. 应用有自己稳定的 userId；登录身份按签发方 + subject 绑定，不以邮箱作为身份。
2. 登录与 Drive 授权是两个独立流程。
3. HTTP、WebSocket 握手和每次写入都校验身份；会话失效后拒绝新写入，但不丢本地待同步内容。
4. 不自己手写 OAuth 和会话协议。
5. 领域数据不被认证库绑死：换库、增减登录方式不改领域数据；删除登录身份不牵连这个人写过的字。
6. 依赖必须持续维护，安全补丁及时。
7. 两人规模，运维和成本尽量低。
8. 安全相关的行为要能用自动化测试验证，不能只靠配置"看起来对"。
9. 本机开发和自动化测试不依赖真实 Google 账号或任何密钥。

## 决策

### D1：Better Auth 运行在 API 进程内，只负责身份和会话

Better Auth 按官方 Fastify 方式挂在 `/api/auth/*`：把 Fastify 请求转成 Web `Request` 交给 `auth.handler`，再把它返回的状态、头和全部 `Set-Cookie` 原样写回。Web 与 API 同源（开发时由 Vite 代理 `/api`），浏览器只需要一个第一方 cookie。

- 锁定精确版本，且不低于修复 GHSA-965c-763c-88jm 的版本（OAuth state 可被用来登录他人账号，严重级，1.7.7 修复）。
- **生产环境不启用任何 Better Auth 插件。** 2024-12 到 2026-09 的 37 条安全公告大多出在插件里。本机开发和测试使用的 `genericOAuth` 插件由 D11 的启动检查保证只在本机地址生效。

为什么：依据 4 要求不手写协议，Better Auth 用配置就能满足依据 1～3（见 D3～D7）；同进程运行省掉一个服务（依据 7）。代价是依据 6 上要持续跟进它频繁的补丁。

### D2：用户分两层，领域数据只引用 `users`

| 层 | 表 | 主要字段 | 约束 | 谁写 |
| --- | --- | --- | --- | --- |
| 领域层 | `users` | `id` uuid、`display_name`、`created_at`、`last_seen_at` | 主键；**没有外键**；不存邮箱和登录方式 | 只有"当前用户"入口（D7） |
| 认证层 | `auth_user` | `id`（与 `users.id` 相同）、`email`、`emailVerified`、`name`、`image`、时间戳 | `email` 唯一（Better Auth 自带） | Better Auth |
| 认证层 | `auth_account` | `userId`、`providerId`、`accountId`（即 subject）、令牌列（始终为空，见 D5）、`scope` | `(providerId, accountId)` 唯一，**由我们加的索引保证** | Better Auth |
| 认证层 | `auth_session` | `token`、`userId`、`expiresAt`、`ipAddress`、`userAgent` | `token` 唯一 | Better Auth |
| 认证层 | `auth_verification` | `identifier`、`value`、`expiresAt` | 存 OAuth state 和 PKCE 校验码 | Better Auth |

- 空间、成员、邀请、日记、字符作者、已读进度等所有领域表，只引用 `users.id`。
- 两层用同一个 UUID 对应（`advanced.database.generateId: 'uuid'`）。Better Auth 的表统一加 `auth_` 前缀（`modelName`）。
- `users` 行由"当前用户"入口在第一次带登录状态的请求中幂等创建（`insert … on conflict do nothing`），`display_name` 取 `auth_user.name`，为空时取邮箱 `@` 之前的部分。之后 `display_name` 归领域层所有，Google 资料变化不覆盖它。
- 认证表用 `npx auth@<与 better-auth 相同版本> generate` 生成 Drizzle 定义，和 `users`、唯一索引放在同一套迁移里（`@better-auth/cli` 已弃用）。

为什么：依据 5。领域表一旦直接引用 `auth_user`，换认证库、调整认证表结构都会牵动日记数据。不设外键是有意的：删除 `auth_user` 后，`users` 行和这个人写过的字都保留。

反例：如果日记字符的作者外键指向 `auth_user.id`，删除身份就会级联删除或阻止删除，两种结果都违反规格 §3。

### D3：身份按 (登录方式, subject) 唯一绑定；不按邮箱自动合并，允许登录后主动绑定

配置为 `accountLinking: { enabled: true, disableImplicitLinking: true, allowDifferentEmails: true }`，并在 `auth_account ("providerId", "accountId")` 上加唯一索引。

| 场景 | 结果 |
| --- | --- |
| 同一 subject 再次登录，Google 邮箱变了 | 同一个用户，仍是一行 `auth_account` |
| 不同 subject，用一个已存在的邮箱登录 | 拒绝（`account_not_linked`）：不建会话、不建用户、不关联到已有用户 |
| 已登录用户绑定另一种登录方式（邮箱可以不同） | 新增一行 `auth_account` 指向同一用户 |
| 未登录时请求绑定 | 401 |
| 绑定一个已属于他人的身份 | 拒绝，身份仍归原主 |
| 同一个新 subject 并发首次登录两次 | 只产生一个用户 |

- providerId 对应固定的签发方（`google` 即 Google），所以不另存 issuer。
- 首版只配置 Google，只申请 `openid email profile`。绑定第二种登录方式的**界面**不在本 ADR 范围，但服务端行为按上表实现并测试，以后增加登录方式只需加 provider 配置和界面。

为什么：Better Auth 默认会把邮箱相同的新登录合并进已有用户，Google 又总会返回 `email_verified`，所以默认就会按邮箱合并，违反依据 1。不用 `enabled: false`：它同时会关掉登录后的主动绑定（`linkSocial` 检查同一个开关），违反依据 5。唯一索引是我们加的：spike 中防止重复用户的其实是 `auth_user.email` 的唯一约束，属于碰巧。`allowDifferentEmails: true` 只作用于已登录状态下的主动绑定，用户本人刚完成新登录方式的授权，邮箱不同不构成冒用。

### D4：登录流程，失败时回到登录页显示原因

1. 前端 `POST /api/auth/sign-in/social`，body 为 `{ provider, callbackURL: '<站点>/', errorCallbackURL: '<站点>/login', disableRedirect: true }`。Better Auth 检查 `Origin` 和两个回调地址，不可信则拒绝。
2. Better Auth 生成 state、PKCE 校验码和 nonce，写入 `auth_verification`，返回 `{ url }`；前端用 `window.location.assign(url)` 跳转。
3. 用户在 Google 同意后，浏览器回到 `/api/auth/callback/<provider>?code&state`。
4. Better Auth 校验 state，用 code + PKCE 换取令牌，校验 ID 令牌（签名、签发方、受众、有效期、nonce）。
5. 按 D3 的规则找到或创建用户；写入前由 D5 的钩子清空令牌。
6. 写入 `auth_session`，设置 cookie，跳回 `callbackURL`。
7. 前端在首页调用 `/api/me`，"当前用户"入口创建 `users` 行（D7）。

失败时 Better Auth 跳转到 `errorCallbackURL`，并带上 `?error=<代码>`；`onAPIError.errorURL` 也设为 `<站点>/login` 作为兜底。登录页按 D10 的表格显示提示。用户始终停留在我们自己的页面。

### D5：登录不保存任何 Google 令牌，也不申请 Drive 权限

用 `databaseHooks.account.create.before` 和 `update.before`，在写库前把 `accessToken`、`refreshToken`、`idToken` 及其过期时间全部置空；同时打开 `encryptOAuthTokens`，作为钩子失效时的第二道防线。

为什么：登录只需要知道"这是谁"。spike 发现 `encryptOAuthTokens` 只加密 access 和 refresh 令牌，ID 令牌（含邮箱和名字）仍以明文 JWT 入库。Drive 授权不经过 Better Auth：它每次登录都会用新令牌覆盖账号行；Drive 走独立的 OAuth 流程，refresh token 加密存在自己的表里（ADR-0004，依据 2）。

### D6：会话存在数据库里，可立即撤销

- Cookie：`HttpOnly`、`SameSite=Lax`、`Path=/`。`PUBLIC_ORIGIN` 是 https 时开启 `useSecureCookies`（加 `Secure` 和 `__Secure-` 前缀）；本机 http 不加。
- 有效期是**实施默认**：30 天有效，每天使用时续期一次（`expiresIn` 30 天、`updateAge` 1 天）。
- **不开 cookie 缓存**（`session.cookieCache`），否则撤销要等缓存过期才生效。
- 退出：同源 `POST /api/auth/sign-out`（body `{}`）删除会话行并清除 cookie；复制的旧 cookie 立即失效。
- 同一个用户可以同时有多个会话（手机和电脑），退出只影响当前会话。
- 限流用 Better Auth 内置默认（只在生产启用，存在内存里），单进程部署下够用。

令牌存储方式：数据库存原始会话令牌，cookie 的值是"令牌 + 用 `BETTER_AUTH_SECRET` 算出的签名"，校验时先验签名。只泄露数据库伪造不出合法 cookie；数据库和密钥同时泄露才能冒充他人。这是本决定接受的风险。

为什么：依据 3 要求撤销立即生效，纯签名 cookie 或加了缓存的会话都做不到；会话存 PG 也不必新增 Redis（依据 7）。

### D7：一个"当前用户"入口；我们自己的路由自己检查来源

- **唯一入口** `currentUser(request)`：调用 `auth.api.getSession`；没有会话返回 `null`；有会话就确保 `users` 行存在、按节流更新 `last_seen_at`，返回 `{ id, displayName }`。业务代码不直接读写 `auth_*` 表。
- **登录要求**：契约路由带 `access: 'public' | 'user'`（D9）。`user` 路由由一个 `preHandler` 调用 `currentUser`，拿不到就返回 401（`UNAUTHENTICATED`），拿到就挂到 `request.user`。路由默认是 `user`，公开必须显式声明；目前只有健康检查是公开的。
- **来源检查**：一个 `onRequest` 钩子对所有非 GET/HEAD/OPTIONS 的 `/api/*` 请求（`/api/auth/*` 除外，Better Auth 自己检查）要求 `Origin` 等于 `PUBLIC_ORIGIN`，否则返回 403（`FORBIDDEN_ORIGIN`）。缺少 `Origin` 也拒绝。
- **WebSocket 握手**（随协同 WebSocket 实现）：先做同样的来源检查，再用 `getSession` 校验会话，并传 `disableRefresh` 和 `disableCookieCache`；之后每次写入都重新确认会话有效、用户仍是空间成员。本 ADR 只规定规则，代码和测试随协同 ADR 落地。
- **最近活跃时间** `last_seen_at`：有登录状态的 HTTP 请求、WebSocket 握手和心跳都算活跃；同一用户最多每 5 分钟写一次（`update … where last_seen_at < now() - interval '5 minutes'`，条件不满足就不写）。只供运维和以后的功能使用，**不出现在任何返回给另一位成员的接口里**：那相当于在线状态回执，与规格"不默认公开对方已读状态"冲突。

### D8：不交给认证层的部分

| 内容 | 归谁 |
| --- | --- |
| 双人空间、成员、邀请 | 自己的表，由 PG 约束和事务保证；后续空间 ADR |
| Drive 授权与备份令牌 | ADR-0004，独立 OAuth 流程 |
| 退出或切换账号时锁定本机缓存（AUTH-06） | 客户端，随编辑器实现 |
| 账号注销、解绑登录方式、绑定第二种登录方式的界面 | 不在 MVP 范围 |

为什么：Better Auth 的 organization 插件是通用的多成员模型，"最多两人、一次性邀请"仍要自己约束，还会扩大插件面（依据 6）。

### D9：接口契约

**统一错误格式**（同时解决 `architecture.md` 中"错误格式"的 TODO）。所有我们自己的 `/api/*` 路由（不含 `/api/auth/*`）出错时返回：

```json
{ "error": { "code": "UNAUTHENTICATED", "message": "Sign in required" } }
```

| code | HTTP | 何时 |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | `user` 路由没有有效会话 |
| `FORBIDDEN_ORIGIN` | 403 | D7 的来源检查不通过 |
| `VALIDATION_FAILED` | 400 | 请求不符合契约 schema |
| `NOT_FOUND` | 404 | 没有这个路由 |
| `INTERNAL` | 500 | 其他错误；`message` 不含内部细节，详情只进服务端日志 |

- `ApiErrorBody` 和 `code` 的枚举定义在 `packages/contracts`，进 OpenAPI；`message` 是英文的开发者说明，界面文字由前端按 `code` 决定。
- API 用 Fastify 的 `setErrorHandler` 和 `setNotFoundHandler` 统一产出这个格式。
- 前端 `ApiError` 增加 `code` 字段（从响应体解析；解析不了时为 `INTERNAL`）。

**路由定义**：`RouteDefinition` 增加 `access: 'public' | 'user'`；`health` 为 `public`。新增：

| 名称 | 方法与路径 | 访问 | 响应 |
| --- | --- | --- | --- |
| `me` | `GET /api/me` | `user` | `200 { "user": { "id": "<uuid>", "displayName": "…" } }`；`401` 错误体 |

`/api/me` 不返回邮箱、登录方式和 `last_seen_at`。

**`/api/auth/*` 不进契约**：它们是 Better Auth 的接口，格式归它管。前端只在 `apps/web/src/api/auth.ts` 一个文件里用 `fetch` 调用 `sign-in/social` 和 `sign-out`，这是"前端只通过 `callApi` 调 API"规则的唯一例外，写进 `apps/web` README。

### D10：前端

**路由**

| 路径 | 访问 | 内容 |
| --- | --- | --- |
| `/login` | 公开 | 登录页；已登录时直接跳 `/` |
| `/` | 需登录 | 占位首页 |
| 其他 | — | 跳 `/` |

**登录状态**：用 TanStack Query 的 `['me']` 查询（`callApi('me')`）。需登录的页面包在 `RequireAuth` 里：

- 加载中：显示"正在打开…"；
- `401`：`navigate('/login', { replace: true })`；
- 其他错误：显示"服务暂不可用，请稍后再试"和"重试"按钮。

**登录页**（单列居中）

- 标题 "Between Pages"，副标题"各自生活，在同一页相遇。"
- 按钮"使用 Google 登录"：调用 `signIn('google')`（D4 第 1、2 步）；请求期间按钮禁用并显示"正在前往 Google…"；请求失败显示"无法连接登录服务，请稍后再试"。
- 开发模式（`import.meta.env.DEV`）额外显示"开发登录"：一个名字输入框和按钮，调用 `signIn('dev', 名字)`（D11）。生产构建不包含这段界面。
- 读取 `?error=`，在按钮上方显示提示：

| `error` | 提示 |
| --- | --- |
| `account_not_linked` | 这个 Google 账号的邮箱已被另一个账号使用。请换一个 Google 账号登录，或联系我们处理。 |
| `access_denied` | 你取消了 Google 授权，需要授权才能登录。 |
| `state_mismatch`、`invalid_callback_request`、`no_code` | 登录已过期，请重新登录。 |
| 其他任何值 | 登录没有成功，请重试。 |

**占位首页**

- 显示"已登录为 {displayName}"和一行"日记空间即将开放。"
- 右上角"退出"：调用 `signOut()`；成功后 `queryClient.clear()` 再跳 `/login`；失败显示"退出失败，请重试"。

**样式**：遵循 [项目主旨](../project-identity.md)"温暖、简约"。不引入组件库或 CSS 框架；`src/styles.css` 用 CSS 变量定义纸张底色（暖白）、正文色（深灰褐）、一个强调色；标题用衬线字体栈，正文用系统字体栈；按钮圆角、足够大的点击区域；支持系统深色模式。具体色值由实现者在此范围内决定。

### D11：配置与环境

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 是 | 已有 |
| `PUBLIC_ORIGIN` | 是 | 浏览器访问的站点地址，例如本机 `http://localhost:5173`；作为 Better Auth 的 `baseURL`、可信来源和回调地址的基础 |
| `BETTER_AUTH_SECRET` | 是 | 至少 32 个字符；本机用 `.env.example` 里标明"仅限本机"的值，生产用 `openssl rand -base64 32` 生成 |
| `AUTH_PROVIDER` | 是 | `google` 或 `dev` |
| `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` | `google` 时必填 | Google Cloud 控制台创建 |
| `DEV_OIDC_ISSUER` | `dev` 时必填 | 本机模拟 OIDC 服务地址，默认 `http://127.0.0.1:4010` |

- **启动时校验**（用 Zod 解析环境变量，不通过就拒绝启动并说明哪一项）：缺必填项；密钥太短；`AUTH_PROVIDER=dev` 但 `PUBLIC_ORIGIN` 不是 `localhost` 或 `127.0.0.1`；`NODE_ENV=production` 且 `AUTH_PROVIDER=dev`。这样生产配置无法启用开发登录和插件（D1）。
- **开发登录**：`npm run dev:oidc` 启动本机模拟 OIDC 服务（`oauth2-mock-server`）。登录页的"开发登录"把名字作为 `loginHint` 传给 Better Auth；模拟服务把它映射成身份：`sub = dev-<名字>`，`email = <名字去掉 # 及之后部分>@dev.local`，`name = 名字`。用 `alice` 和 `alice#2` 登录，就得到"不同 subject、相同邮箱"，可在本机复现邮箱冲突。两个浏览器配置文件分别登录 `alice` 和 `bob`，就是两个用户。
- **测试**：`buildApp` 接受认证配置参数；集成测试和端到端测试都在进程内启动同一个模拟服务，走 `dev` 配置，与本机开发是同一条代码路径。
- `.env.example` 写入本机可直接使用的 `PUBLIC_ORIGIN`、`AUTH_PROVIDER=dev`、`DEV_OIDC_ISSUER` 和一个标明"仅限本机"的密钥。

### D12：代码位置

| 位置 | 内容 |
| --- | --- |
| `packages/contracts/src/errors.ts` | `ApiErrorBody`、错误 `code` 枚举 |
| `packages/contracts/src/routes.ts` | `access` 字段、`me` 路由 |
| `apps/api/src/config.ts` | 环境变量解析与 D11 的启动校验 |
| `apps/api/src/auth/auth.ts` | `createAuth(config, db)`：Better Auth 实例（D1、D3、D5、D6），按 `AUTH_PROVIDER` 选 provider |
| `apps/api/src/auth/handler.ts` | 挂载 `/api/auth/*` |
| `apps/api/src/auth/current-user.ts` | `currentUser`、`users` 自动创建、`last_seen_at` 节流 |
| `apps/api/src/auth/guards.ts` | 来源检查 `onRequest`、登录要求 `preHandler` |
| `apps/api/src/errors.ts` | 统一错误处理 |
| `apps/api/src/routes/me.ts` | `/api/me` |
| `apps/api/src/db/auth-schema.ts` | `auth generate` 生成的认证表（加唯一索引）；由 `schema.ts` 导出 |
| `apps/api/scripts/dev-oidc.ts` | 本机模拟 OIDC 服务 |
| `apps/api/test/oidc.ts` | 测试用模拟服务和"完整登录往返"辅助函数 |
| `apps/web/src/api/auth.ts` | `signIn`、`signOut`（D9 的唯一例外） |
| `apps/web/src/auth/RequireAuth.tsx`、`src/pages/LoginPage.tsx`、`src/pages/HomePage.tsx`、`src/styles.css` | D10 |
| `e2e/`、根目录 `playwright.config.ts` | 端到端测试 |
| `checks/verify-auth-boundary.ts` | 不变量 10 的检查 |

## 失败与恢复

| 情况 | 结果 | 恢复 |
| --- | --- | --- |
| Google 不可达、用户取消授权 | 回到 `/login?error=…`，不建会话 | 重新登录 |
| state 过期（授权页停留太久） | 同上 | 同上 |
| 邮箱冲突 | 回到 `/login?error=account_not_linked` | 人工协助；不自动合并 |
| `auth_user` 已建，`users` 行未建（进程中途崩溃） | 下一次带登录状态的请求自动补建 | 无需人工 |
| 编辑中会话过期或被撤销 | 新写入被拒（HTTP 401；WebSocket 以专门的关闭原因断开） | 客户端保留待同步内容，提示重新登录，登录后补发 |
| 更换 `BETTER_AUTH_SECRET` | 所有会话签名失效，所有人需重新登录 | 预期行为，写进运维说明 |
| 从备份恢复数据库 | 快照不含会话，所有人需重新登录 | 预期行为，写进恢复说明 |
| 数据库不可用 | 登录和会话校验失败，返回 500（`INTERNAL`） | 不降级为"无数据库也放行" |
| 配置错误（缺变量、生产配了开发登录） | 进程拒绝启动并指出哪一项 | 修正配置 |

## 不变量

1. 所有领域表只引用 `users.id`，不引用认证层的任何表；`users` 没有指向认证层的外键，不存邮箱和登录方式。
2. 一个登录身份（登录方式 + subject）唯一对应一个用户；同一 subject 换了邮箱仍是同一个用户。
3. 不同 subject 使用已存在的邮箱登录时被拒绝：不建会话、不建用户、不关联到已有用户。
4. 只能在已登录状态下绑定新的登录方式；已属于其他用户的身份不能被绑定过来。
5. 登录流程不保存任何 Google 令牌，也不申请 Drive 权限。
6. 退出或撤销会话后，旧 cookie 在 HTTP 和 WebSocket 握手上立即失效。
7. 所有非 GET 的 API 路由和 WebSocket 握手都校验 `Origin` 属于可信来源。
8. WebSocket 连接上的每次写入都重新确认会话有效、用户仍是该空间成员；失效时拒绝写入，不丢弃客户端待同步内容。
9. 最近活跃时间不出现在任何返回给另一位成员的接口中。
10. 业务代码只通过"当前用户"入口得知调用者，不直接读写 `auth_*` 表。
11. `BETTER_AUTH_SECRET` 和 Google 客户端密钥只来自环境变量，不进仓库、日志和备份。
12. 生产配置无法启用开发登录或任何 Better Auth 插件。
13. 契约路由默认需要登录，公开路由必须显式声明。

## 备选方案

| 方案 | 优势 | 否决理由 |
| --- | --- | --- |
| **openid-client v6 + 自己实现会话** | 经过认证的 OIDC 库；完全可控，可以只存令牌摘要；没有插件面 | 会话、CSRF、撤销、限流都要自己写，违背依据 4；如果 Better Auth 核心持续出安全问题，这是首选退路 |
| Auth.js（@auth/core） | 生态成熟，资料多 | 2025-09 起由 Better Auth 团队接手，只做安全维护，不满足依据 6 |
| Lucia | 代码量小，概念清楚 | npm 包已弃用，不满足依据 6 |
| Supabase Auth | 托管，省运维 | 默认按已验证邮箱自动合并身份，违背依据 1；需要额外部署或外部服务，违背依据 7 |
| Clerk、WorkOS | 托管，功能完整，界面现成 | 收费，身份数据在第三方，违背依据 5、7；会话不方便与自己的 WebSocket 共用（依据 3） |
| 领域表直接引用 Better Auth 的用户表 | 少一张表和一段"首次创建"逻辑 | 删除身份会牵连作者，违背依据 5 |
| `accountLinking.enabled: false` | 一个开关就能禁止按邮箱合并 | 同时禁止登录后的主动绑定，违背依据 5 |
| 保留默认的按邮箱自动合并 | 换了 Google 账号的同一人能自动认回 | 违背依据 1；同邮箱的另一个账号能直接登进已有用户 |
| 用 Better Auth 的 organization 插件管理空间 | 现成的成员和邀请接口 | 规则仍要自己约束，还扩大插件面，违背依据 6 |
| 开启 cookie 缓存 | 少一次数据库查询 | 撤销要等缓存过期，违背依据 3；两人规模下这次查询不是瓶颈 |
| 只靠 `encryptOAuthTokens` 保护令牌 | 不用写钩子 | ID 令牌仍明文入库（spike 实测）；登录根本不需要令牌 |
| 前端使用 Better Auth 的客户端 SDK | 现成的 `signIn` / `useSession` | 多一个依赖，且会话状态与 TanStack Query 的 `['me']` 重复；我们只用到两个接口 |
| 本机开发直接用真实 Google | 与生产完全一致 | 每个开发者都要有 OAuth 客户端和密钥，测试无法自动化，违背依据 9 |
| 错误格式沿用 Fastify 默认 | 不用写错误处理 | 前端拿不到稳定的错误代码，`404`、校验失败、内部错误的形状各不相同 |

## 风险与代价

- **安全公告多**：Better Auth 两年 37 条安全公告。开 Dependabot 和 GitHub 安全公告订阅，有补丁就升级并重跑认证测试；生产不启用插件。
- **会话令牌原样存储**：数据库和密钥同时泄露时可以冒充他人。缓解：密钥只在部署平台的密钥配置里，不进日志和备份。
- **邮箱冲突要人工处理**：两人规模下可以接受。
- **限流存在内存里**：只在单进程时可靠；多实例部署前要改为存数据库。
- **开发登录与生产登录走不同的 provider**：模拟服务验证了 Better Auth 的账号和会话逻辑，但没有覆盖 Google 的 ID 令牌和同意页面。靠阶段 4 的真实联调兜底。
- **多一张 `users` 表**和"首次请求时创建"的逻辑；换来认证层可以整体替换。

## 未解决的问题

每一条都给出默认做法，实现时按默认做法继续，不停下来问。

| 问题 | 默认做法 |
| --- | --- |
| Better Auth 能否只存会话令牌的摘要 | **结论（2026-10-25）**：1.7.12 没有这个选项（源码中会话令牌原样写入），维持 D6，已写进 `apps/api` README 的已知限制 |
| 新建用户时 `auth_user` 和 `auth_account` 是否同一事务写入 | **结论（2026-10-25）**：Better Auth 会把两次写入包进事务，但 Drizzle 适配器默认不开启事务（`transaction` 默认为 false）。实现中打开 `transaction: true`，并用“插入身份时强制失败”的测试确认不会留下孤立用户；关掉该选项时测试失败 |
| D10 表格之外的 Better Auth 错误代码 | 统一显示"登录没有成功，请重试" |
| Google 发布状态与 `drive.file` 是否需要审核 | 属于 ADR-0004，不在本 ADR 解决 |

## 落地顺序

### 自主实现约定

本 ADR 采纳后，阶段 1～3 由 AI 连续完成，不需要再问问题。

- **预先批准的依赖**（`npm i -E`）：`better-auth` 1.7.x（实现时的最新补丁版，不低于 1.7.12）装在 `apps/api`；`oauth2-mock-server` 9.3.0 装在 `apps/api` 的开发依赖；`@playwright/test` 与根目录现有 `playwright` 相同版本，装在根目录的开发依赖。
- **预先批准的迁移**：`auth generate` 生成的四张认证表和 `auth_account ("providerId", "accountId")` 唯一索引。`users` 表结构不变。
- **预先批准的其他改动**：
  - 契约包（D9）；`openapi.json` 重新生成；
  - `checks/verify-auth-boundary.ts` 并注册到 `check docs`；
  - CI 新增 `e2e` job（安装 Chromium，运行 Playwright），不改分支保护设置；
  - `AGENTS.md` 的命令区增加 `dev:oidc` 和端到端测试命令；
  - `architecture.md` 的"错误"一行改为指向 D9，删掉 TODO；
  - `.env.example`。
- **AI 自行决定**：D12 范围内的文件内部结构、函数拆分、测试组织；D10 范围内的具体色值、间距和字体栈。
- **只在这些情况下停下来**：实现会违反某条不变量；Better Auth 缺少某个 D 小节依赖的行为，而"未解决的问题"里没有默认做法；预先批准的依赖在同一主版本内无法通过 CI。
- **PR**：阶段 1～3 的全部代码放在**一个 PR** 里，目标为 `main`。
  - 每个阶段拆成一个或几个提交，按阶段顺序排列；每个提交都能单独通过 `npm run check -- all`，可以逐个评审。
  - 阶段 1 直接使用 PR #5 已有的提交（保留原提交，不改写）；新分支从它开始，代码 PR 打开后关闭 PR #5，并在 PR #5 里留言指向新 PR。
  - PR 描述包含 Evidence 小节，以及一张对照表：每个提交对应哪些 D 小节和不变量，每条不变量由哪个测试覆盖。
  - AI 打开 PR 并保持 CI 全绿；**不合并**，由 Ray 评审后以 merge commit 合并。CI 失败时 AI 自行修复，不需要询问。

### 阶段 1：数据库基础（沿用 PR #5 的提交）

- 范围：Drizzle、迁移命令、本机和 CI 的测试数据库、`users` 表、`verify-migrations-current`。
- 完成条件：迁移能从空库建出 `users`；`*.db.test.ts` 在 CI 的 PostgreSQL 上运行；不变量 1 的 schema 测试通过。已按本 ADR 复核，代码无需修改；`apps/api` README 中的"constraint 1"改称"不变量 1"，在阶段 2 的提交里一起改。

### 阶段 2：后端登录

- 范围：D1、D3、D5、D6、D7（不含 WebSocket）、D9、D11、D12 中的 API 部分；`dev:oidc` 脚本。
- 提交建议：先提交契约（D9 的错误格式、`access` 字段、`me` 路由），再提交后端登录。
- 完成条件：
  - 集成测试覆盖不变量 1～7（7 只含 HTTP）、9～13，标题带 `[adr:authentication-and-sessions#N]`；
  - `npm run check -- all` 通过，ADR 索引的"实施"列相应增加；
  - 本机 `npm run db:up && npm run dev:oidc && npm run dev:api` 后，用 `curl` 走通一次开发登录并拿到 `/api/me`。
- 从此改变：除健康检查外，API 路由默认需要登录。

### 阶段 3：前端登录

- 范围：D10、D12 中的 Web 部分、端到端测试、CI 的 `e2e` job。
- 提交建议：先提交前端页面和组件测试，再提交端到端测试和 CI。
- 完成条件：
  - 组件测试覆盖：`?error=` 每类提示、`RequireAuth` 的三种状态、退出失败提示；
  - 端到端测试全部通过（见验收标准）；
  - `apps/web` README 写明 D9 的例外和登录流程。

### 阶段 4：真实 Google 联调（人机协作，不在自主范围内）

前提：部署平台已由后续部署 ADR 选定，并有一个 HTTPS 地址。

| 步骤 | 谁做 | 做完后 AI 检查什么 |
| --- | --- | --- |
| 1. 在 Google Cloud 创建 OAuth 客户端（Web 应用），回调地址填 `<PUBLIC_ORIGIN>/api/auth/callback/google`，同意页面只申请基本身份范围 | 你 | 回调地址、范围与 D3、D4 一致（你把截图或配置发给 AI） |
| 2. 生成 `BETTER_AUTH_SECRET`，把它和 Google 客户端 ID、密钥配进部署平台的密钥设置；`AUTH_PROVIDER=google` | 你 | 应用能启动；D11 的启动校验通过；日志里没有密钥 |
| 3. 用你的 Google 账号登录一次 | 你 | `auth_account` 中 `providerId=google`、令牌列为空；cookie 带 `Secure` 和 `__Secure-` 前缀；首页显示名字 |
| 4. 用另一个邮箱相同、subject 不同的账号登录（没有就跳过） | 你 | 停在登录页并显示邮箱冲突提示；没有新用户 |
| 5. 退出，再用退出前复制的 cookie 请求 `/api/me` | 你和 AI | 返回 401 |
| 6. 结果记入验收证据（AUTH-01、AUTH-05） | AI | — |

## 验收标准

- 未登录时，除健康检查和 `/api/auth/*` 外的接口都返回 401（AUTH-01 的服务端部分）。
- 拒绝 Drive 权限不影响登录和使用（AUTH-04）：登录只申请基本身份范围。
- 退出后，复制的旧 cookie 被拒（AUTH-05 的服务端部分）。
- **端到端测试**（Playwright，Chromium，使用开发登录）：

| 编号 | 场景 | 期望 |
| --- | --- | --- |
| E1 | 未登录访问 `/` | 跳到 `/login` |
| E2 | 开发登录 `alice` | 进入 `/`，显示"已登录为 alice" |
| E3 | 登录后刷新页面 | 仍在 `/`，仍显示 alice |
| E4 | 点"退出" | 回到 `/login`；再访问 `/` 又被跳回 `/login` |
| E5 | 先登录 `alice` 并退出，再登录 `alice#2` | 停在 `/login`，显示邮箱冲突提示 |
| E6 | 已登录时访问 `/login` | 跳到 `/` |

- 各不变量的验证方式：

| 不变量 | 验证方式 |
| --- | --- |
| 1 | 迁移后的 schema 测试：`users` 的列和外键；所有领域表的外键只指向 `users` |
| 2、3、4 | 模拟 OIDC 完整往返的集成测试：同 subject 换邮箱、不同 subject 同邮箱、已登录绑定、未登录绑定、绑定他人身份、并发首次登录 |
| 5 | 集成测试：身份记录的令牌列为空；授权地址只含 `openid email profile` |
| 6 | 集成测试：用退出前复制的 cookie 请求 `/api/me`；WebSocket 部分随协同 ADR |
| 7 | 集成测试：不可信或缺失 `Origin` 的非 GET 请求返回 403；WebSocket 部分随协同 ADR |
| 8 | 协同协议的集成测试（协同 ADR） |
| 9 | 契约测试：`/api/me` 及以后所有成员相关响应的 schema 不含该字段 |
| 10 | `verify-auth-boundary`：`apps/api/src` 中除 `auth/` 和 `db/` 外，没有代码引用认证表 |
| 11 | 集成测试：启动和登录全过程的日志中不出现密钥；`.env` 在忽略列表中 |
| 12 | 配置单元测试：生产配置加开发登录、非本机地址加开发登录都拒绝启动 |
| 13 | 契约测试：每个路由都声明了 `access`；`user` 路由在无会话时返回 401 |

## 补充信息

- 重新评估条件：Better Auth 核心（非插件）出现严重安全公告且修复缓慢，或项目停止维护，改用 openid-client + 自己实现会话；需要的认证能力只能通过插件获得时重新评估；规格改为允许展示在线状态时重议不变量 9。
- 证据：[Better Auth spike](../../prototypes/auth/README.md)、[spike 测试日志](../validation/artifacts/auth-2026-10-24/better-auth-pg.log)。
- 对应验收：AUTH-01、AUTH-04、AUTH-05 的服务端部分由本决定覆盖；AUTH-02、AUTH-03 依赖空间 ADR；AUTH-06 依赖客户端缓存锁定。
