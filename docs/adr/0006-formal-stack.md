# ADR-0006：正式技术栈与协同内核

日期：2026-10-24。状态：已采纳；协同内核的生产验证仍未完成。来源：用户确认的技术栈讨论和 [Yjs 标准更新 spike](../../prototypes/yjs-standard/README.md)。

## 背景

阶段 0 的验证（[ADR-0002](./0002-collaboration-and-author-authorization.md)、[ADR-0005](./0005-yjs-authoritative-validation.md)）证明了作者保护和不丢字的行为可以实现，但正式栈一直是建议稿。开始搭正式项目之前，需要定下运行时、框架、协同内核、数据访问、接口契约和测试工具，作为工程规范和 CI 的依据。

ADR-0005 的路线由服务端代客户端生成所有 Yjs 更新：服务端是唯一写入者，Yjs 的合并能力几乎用不上，字符 ID、墓碑、撤销和队列全是项目代码。spike 进一步验证了另一种做法：客户端发送普通 Yjs 更新，服务端按 clientID 与用户的绑定检查每条更新。

范围前提（用户于 2026-10-24 确认）：

- 先做桌面 Web；手机浏览器、实体设备和原生客户端后置，不阻塞 Web 正式实现。
- 暂不处理中国大陆访问 Google 的问题，默认双方都能连上 Google。

## 决策

### 运行时与工程

1. 运行时为 **Node.js 26**（2026-10-28 进入 LTS，支持到 2029-04）。`engines` 要求 Node 26；现有原型需在 26 上重跑一遍测试。
2. 语言为 TypeScript strict，开启 `erasableSyntaxOnly`，让 Node 能直接运行源码；前端由 Vite 构建。
3. 包管理器为 **npm workspaces**，不使用 pnpm 或 Bun。
4. 模块划分：`apps/web`、`apps/api`（含独立 worker 入口）、`packages/contracts`、`packages/collab`；`prototypes/` 保持现状，只作为行为基线。
5. 测试：新的正式模块用 **Vitest**，行覆盖率 80%；浏览器端到端测试用 **Playwright**；原型继续用 Node 测试，不改写。
6. 格式化与静态检查用 ESLint 和 Prettier，CI 用 GitHub Actions，Git hooks 随仓库提交。PR 用 merge commit 合并，不用 squash。

### 前端

7. React + Vite + React Router，纯客户端渲染。
8. 服务端数据用 TanStack Query，跨组件状态按需用 Zustand；日记正文只由协同模块持有，不进入这两个 store。
9. 编辑器直接使用 ProseMirror，不用 Tiptap。
10. 本地存储用 IndexedDB，保存已提交副本、未确认更新、clientID 和恢复草稿。具体用 y-indexeddb 还是自写 journal，在实现时根据"绝不静默丢弃待发送内容"的测试决定。

### 协同内核

11. **每篇日记是一个 Yjs `Y.Text`（键名 `body`），换行就是普通的 `\n` 字符。** Yjs 锁定 13.6.x 的精确版本，不使用 14 预发布版。
12. 客户端用 Yjs 公开 API 生成普通更新。服务端在接受更新前检查：
    - 新字符只能使用服务端已绑定给该用户的 clientID；
    - 删除只能覆盖该用户自己 clientID 的字符；
    - 内容只能是纯文本，不允许格式或属性写入，也不允许新的顶层类型；
    - 引用的前后字符、父节点和删除范围都已存在，否则拒绝，不让更新进入等待队列。
13. 作者由字符的 Yjs ID（clientID + clock）经服务端登记的映射推出，不使用客户端提供的作者字段或标记。clientID 与用户的绑定持久化在 PG 中，一个 clientID 不能先后属于两个用户。
14. 编辑器绑定自己写：把 ProseMirror 的每个实际编辑步骤直接翻译成 `Y.Text` 的插入和删除，不通过前后文本比对去猜改动。远端光标用 `Y.RelativePosition`，个人撤销用只跟踪本人改动的 `Y.UndoManager`。
15. 更新被拒绝后，客户端重置到服务端状态，本地输入保留为恢复草稿。界面本身也拦截越权操作，所以这条路径只在出 bug 时触发。
16. 保存确认协议自己定义：更新、对应的 PG 记录和 outbox 在同一事务提交后，服务端才回复"已保存"并广播。WebSocket 层直接用 ws，暂不采用 Hocuspocus。
17. 关闭 Yjs 的垃圾回收（`gc: false`），保留删除标记，供撤销、未读定位和离线恢复使用。每个字的写入时间和接收时间由服务端按"clientID + clock 区间"另行记录，Yjs 本身不存时间。
18. `packages/collab` 不依赖应用的其他模块（数据库、HTTP、界面），以后可以单独测试，也可能提取成独立的库。

### 服务端与数据

19. API 用 Fastify 5，WebSocket 用 `@fastify/websocket`（底层是 ws），HTTP 与 WebSocket 共用会话校验。
20. 主库为 PostgreSQL。备份走 [ADR-0003](./0003-postgres-and-durable-commit.md) 的 outbox 加独立 worker：worker 与 API 在同一代码库，启动入口和进程分开。需要现成重试与调度时再评估 pg-boss。
21. 数据访问用 **Drizzle ORM 0.45.x**（锁精确版本），负责表结构、迁移和普通查询。行锁、幂等、outbox 等关键事务写显式 SQL。Drizzle 1.0 正式发布后单独安排升级。

### 接口契约

22. 所有 HTTP 请求和响应、所有 WebSocket 消息，都用 **Zod 4** 定义在 `packages/contracts`，只维护这一份。
23. 后端用 `fastify-type-provider-zod` 校验请求和响应；用 `@fastify/swagger` 生成 OpenAPI 3.1 文件，提交进仓库。CI 重新生成该文件并与仓库版本比对，不一致就失败。
24. 前端用 `openapi-typescript` 和 `openapi-fetch` 根据 OpenAPI 生成带类型的客户端。WebSocket 消息用带协议版本号的 Zod 联合类型，前后端都用它校验。

### 认证

25. Better Auth 是登录的第一候选，实现登录前另写 ADR，确认版本、会话、CSRF 和账号关联。Google Drive 授权与登录分开实现，见 [ADR-0004](./0004-google-export-and-recovery.md)。

## 替代方案

- **自有 TS 协同内核**（两个原型的路线）：完全可控，但合并算法、编码和撤销都要长期自己维护。在服务端可以检查普通 Yjs 更新的前提下，这部分维护不值得。
- **标准 y-prosemirror / Tiptap 协同 / Hocuspocus**：spike 证明不可用。y-prosemirror 靠前后文本比对同步，遇到重复字符会把删除和插入算到错误的字上；拆段被编码成"删除再重建"，所以在对方文字中换行会被拒绝，并发拆段会让文字错位。只禁止在对方文字里换行也解决不了。
- **服务端代生成所有 Yjs 更新**（ADR-0005）：安全，但 Yjs 只起编码作用，每个字都是一个对象，还要从完整历史重建文档。
- **Automerge**：同样需要自己做作者权限和保存确认，没有比 Yjs 更好的权限检查切入点；暂不评估。
- **Bun**：1.4 刚从 Zig 重写为 Rust，官方也说明还未完全兼容 Node。长期运行的生产服务选 Node LTS 风险更低。
- **pnpm**：只有三四个包，速度和依赖隔离上的优势体现不出来。
- **Prisma 7**：版本信号更成熟，但关键事务同样要写原生 SQL，还要多一步代码生成。**Kysely**：同样是 0.x，没有优势。
- **tRPC**：没有原生 OpenAPI，以后的原生客户端用不了。**ts-rest**：2025 年中以后基本没有发布。**oRPC**：可行的备选，暂不采用。
- **Node 24**：2026-10-20 已进入维护期。

## 后果

- 合并算法、编码、相对位置和撤销交给 Yjs；项目只维护更新检查、编辑器绑定、保存协议和时间元数据。
- 更新检查读取了 Yjs 没有承诺稳定的 `Item` 字段（`origin`、`rightOrigin`、`parent`、`parentSub`、`content`）。升级 Yjs，尤其是迁到 14，必须重跑这组检查测试。
- 编辑器绑定需要自己处理中文输入法、选区映射和粘贴；现有浏览器测试要改为针对新绑定运行。
- 以后支持富文本时，格式会生成属于设置者的格式标记，删除检查拦不住。到时要增加"格式范围只能覆盖自己的字"的检查，并定好段落格式的归属规则。树形富文本结构与作者保护冲突，不采用。
- 关闭垃圾回收后文档只增不减。spike 中 10 万字约占 470 KB，日记规模可以接受。

## 投入生产前仍需验证

spike 只覆盖了更新检查和数据模型，没有验证以下内容。这些是阶段 1、2 的实现和验收工作，不再单独做原型：

- 自写的 ProseMirror ↔ `Y.Text` 绑定在三种浏览器引擎中的表现：作者保护、中文 composition、粘贴、个人撤销和光标；
- PG 提交后才确认、幂等重试、ACK 前后进程崩溃；
- IndexedDB 离线恢复、多标签页、被拒绝后的恢复草稿；
- 时间元数据与未读定位基于"clientID + clock 区间"的实现；
- 在 Node 26 上重跑现有原型测试。

对应验收：EDIT-01～12、SYNC-01～05、SAVE-01～08。
