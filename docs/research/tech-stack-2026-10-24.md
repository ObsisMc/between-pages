# Between Pages 技术栈调研与建议

调研日期：2026-10-24。状态：选型建议；最终决定见 [ADR-0006](../adr/0006-formal-stack.md)，其中 pnpm 改为 npm、移动端后置。持续维护是用户明确要求的生产依赖门槛。

后续进展：状态管理已确认为 TanStack Query + 按需使用 Zustand；同日完成 [Yjs 第一轮验证](../validation/yjs-collaboration-2026-10-24.md)。该轮采用服务端权威更新及自定义 ProseMirror 适配器，没有使用 y-prosemirror/Hocuspocus 默认 provider；下文对这些候选的维护和集成门槛仍有效。

## 1. 结论

推荐以 **TypeScript + React + Node.js + PostgreSQL** 为主线；Web 使用 Vite，移动端优先评估 **React Native + Expo**，后端倾向 **Fastify**。它们兼顾现有生态、跨端协作和小团队维护成本。

协同编辑单独设立选型门槛：优先验证 **ProseMirror + Yjs**，Hocuspocus 作为服务端基础设施候选；不能把这些名字组合起来就视为完成了作者权限和可靠保存。此前自研原型保留为行为基线和回归测试，不直接成为生产内核。

暂不把 `prosemirror-collab` 放入默认生产组合：它仍可作为中心化协同的对照候选，但该包稳定版本发布时间较早，新仓库维护活动本次未能完整核验，需要更强的证据后再考虑。

这里的“有前景”指：使用者和生态足够大、维护与支持可核验、能够升级和迁出、符合产品需要。无法保证某个框架未来永远流行。建议承担产品特有的作者保护复杂度，把通用能力尽量交给成熟且仍受维护的项目。

## 2. 业界采用度：证据与边界

| 证据 | 本次核验结果 | 对本项目的意义 |
| --- | --- | --- |
| Stack Overflow 2026，Web 技术题，10,281 人回答，可多选 | Node.js 46.4%、React 41.5%、Next.js 20.6%、FastAPI 18.5%、Vue 17.2%、Express 15.6%、NestJS 5.8%、Fastify 3.5%、Hono 2.8% | React/Node 有广泛采用；Fastify 是较小但可考虑的生态，不能称为使用最多的后端框架 |
| Stack Overflow 2026，数据库题，12,061 人回答 | PostgreSQL 57.9% | PG 是主流选择，与已经确认的事务和恢复需求一致 |
| GitHub Octoverse 2025 | 按贡献者计数，TypeScript 在 2025 年 8 月超过 Python、JavaScript | 支持 TS 生态活力判断，不能推导为所有企业生产服务市场第一 |
| State of JavaScript 2025，后端框架 | Express 使用领先；Nest 增长；Hono、Nitro、ElysiaJS 在满意度方面突出 | 新工具值得关注；满意度、使用量和长期维护是不同指标 |

来源：[SO Web 技术数据](https://survey.stackoverflow.co/2026/technology/data/web-framework)、[SO 数据库数据](https://survey.stackoverflow.co/2026/technology/data/databases)、[GitHub Octoverse](https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/)、[State of JS 后端框架](https://2025.stateofjs.com/en-US/libraries/back-end-frameworks/)。

这些都是特定平台和自愿参与者的数据，不是全球生产系统普查；多选比例不能相加，两个题目的样本量也不同。SO 将运行时 Node.js 与框架混在同题，不能把表格当作严格的同层架构性能比较。该题里的 Flutter 数据不能用于判断移动端 Flutter 的市场采用度。

本报告没有使用 GitHub star 数量、下载数或供应商 HTTP 跑分来决定核心架构，也没有证据支持“使用这些工具就能承载某个用户规模”。容量须根据连接数、写入量、文档大小和部署环境实测。

## 3. 持续维护：必须检查到具体包

### 本次实际核验

直接查询 npm registry 的 `latest`、版本发布时间、仓库地址、弃用标记和许可证，原始结果保存于 [维护元数据快照](./dependency-maintenance-2026-10-24.json)。以下日期为 UTC，版本仅作研究证据，不是最终锁定版本。

| 包 | latest / 发布日期 | 判断 |
| --- | --- | --- |
| prosemirror-view | 1.42.8 / 2026-10-24 | 有近期发行；仓库地址已指向新托管站，编辑器层可继续评估 |
| prosemirror-collab | 1.3.1 / 2023-05-17 | 稳定发行较久；不能仅此认定停更，但暂不满足我们直接选为默认内核所需的维护证据 |
| yjs | 13.6.33 / 2026-09-23 | 有近期稳定发行；另有 14 的预发布，不因版本较新而直接采用 RC |
| y-prosemirror | 1.3.7 / 2025-07-03 | 绑定层发行较少；必须单独核验问题响应、兼容性和上游支持，不能从 Yjs 活跃推定绑定也已通过门槛 |
| @hocuspocus/server | 4.7.1 / 2026-10-12 | 有近期发行和修复记录；协议、钩子和存储语义仍需集成测试 |
| fastify | 5.12.7 / 2026-10-13 | 有近期发行及公开支持政策 |
| better-auth | 1.7.12 / 2026-10-20 | 有近期发行；认证安全和实际组合兼容性要独立审查 |
| drizzle-orm | 0.45.4 / 2026-10-08 | 有近期发行；仍需注意版本和迁移工具的兼容范围 |

这些包在查询的版本上均未发现 npm `deprecated` 字段。这只是一次元数据快照，**不是安全审计，也不保证未来维护**。可复查 [Yjs 发行记录](https://github.com/yjs/yjs/releases)、[Hocuspocus 发行记录](https://github.com/ueberdosis/hocuspocus/releases)、[Fastify 支持政策](https://fastify.dev/docs/latest/Reference/LTS/)。

ProseMirror 的旧 GitHub 仓库显示 2026-04-01 归档，但 README 明确指向新的代码托管站；因此“GitHub 归档”在此不能等同“项目停止维护”。本次浏览器无法读取新托管站（403），只能确认迁移声明和 npm 近期发行，不能声称已经审核新仓库的 issue 响应。[迁移声明](https://github.com/ProseMirror/prosemirror-collab#readme)

### 正式引入前的维护门槛

1. 确认权威源码地址、许可证、维护者和真实问题反馈渠道；归档迁移要追到新地址。
2. 检查近期适配、缺陷/安全修复和问题响应。没有发布不自动判死刑，但核心依赖长期无维护证据则暂缓采用。
3. 使用仍受支持的稳定版本；检查运行时、编辑器、绑定层和服务端的兼容矩阵。RC、beta 或已弃用包不作默认。
4. 确认数据格式、协议和本地数据库升级路径；必须能导出、迁移、恢复。
5. 核心包出现停止维护声明、持续未修复的重大漏洞或阻塞缺陷时，有替代方案；不默认由我们长期维护 fork。

正式锁版时再次查询，记录至 ADR/依赖清单；随后用自动依赖更新和定期人工检查持续跟踪。维护历史较短的热门库，不能只凭更新频繁就获得与长期项目相同的信任。

## 4. 后端语言和运行时

以下是针对本项目的工程判断，不是语言通用排名。

| 选择 | 适合的情形 | 在本项目的取舍 |
| --- | --- | --- |
| Node.js + TypeScript | Web/RN 客户端、实时连接、共享 JS 协同生态 | 首选：复用协议、校验、领域类型与测试，减少跨语言实现差异 |
| Python + FastAPI / Django | 团队 Python 熟练，数据/AI 业务或管理后台占主导 | 完全可以做正式后端；但当前核心仍是 TS 编辑器与协同，需额外维护跨语言契约或独立协同进程 |
| Go | 团队熟悉 Go，需要独立长连接网关和明确的资源控制 | 未来可用于测量后确有需要的网关；现在作为唯一后端会增加 JS 协同集成边界 |
| Rust | 对内存、延迟或底层多端核心有经过测量的要求，团队有经验 | 能做成熟服务；当前投入难以直接解决作者权限、输入法和移动编辑体验 |
| Java / Kotlin + Spring、C# + ASP.NET Core | 已有对应团队、企业基础设施或招聘优势 | 主流且可长期运营；目前没有足够收益抵消额外语言和 JS 协同服务的整合成本 |

推荐 Node 的决定性因素是生态与共享实现，不是声称其他语言不能处理 WebSocket。[FastAPI 官方也有 WebSocket 支持](https://fastapi.tiangolo.com/advanced/websockets/)。CPU 密集的快照转换、大文档校验和导出必须设预算，必要时转 worker，不能让它们阻塞实时编辑。

运行时默认选择 Node LTS。本次官方页面列出 Node 24、22 为 LTS，26 为 Current；本地验证环境为 Node 24，正式实施时复核支持状态及依赖要求。Bun/Deno 可以继续关注，暂不为运行时新颖性增加第三方兼容验证范围。[Node 支持周期](https://nodejs.org/en/about/previous-releases)

## 5. Web：React + Vite，路由与服务端分开

React 有广泛采用，并能与未来 RN 技能和领域逻辑复用。建议 Web 使用 **React + Vite + React Router**，主要采用客户端渲染，后端提供独立 API/WS。这个日记产品主要在登录后使用，离线编辑、输入体验和状态恢复比日记页面 SEO 更重要。

React 官方通常建议新应用从框架开始，也明确允许约束不合适时自行组合；React Router 可搭配 Vite，并支持多种模式。因此这里推荐的客户端应用是基于产品约束的选择，不是断言官方反对框架或 SSR。[React 官方建议](https://react.dev/learn/creating-a-react-app)、[Router 模式](https://reactrouter.com/start/modes)、[Vite](https://vite.dev/guide/)

| 候选 | 判断 |
| --- | --- |
| Next.js | 很流行，公开内容、SEO、服务端渲染和全栈路由需求明显时很合适；本项目暂不需要让编辑和保存协议依赖其服务端特性 |
| Vue / Nuxt | 成熟且可实现同样产品；若团队更熟 Vue，可改选。选 React 的主要原因是未来 RN 路径，不是 Vue 做不了协同 |
| Svelte / SvelteKit、Solid | 有各自优势；目前没有足以让我们放弃 React/RN 生态协同的独特需求 |
| TanStack Router / Start | 值得关注；不必为了采用 Query 就同时引入整套新应用框架 |

Next.js 可以自托管 Node 或容器，不等同于只能部署 Vercel，也不能把某个函数平台的连接限制归咎于 React/Next 本身。[Next.js 自托管](https://nextjs.org/docs/app/guides/self-hosting)

普通列表、用户资料、导出任务等服务端状态采用 **TanStack Query**，跨组件客户端状态**按需使用 Zustand**（用户于 2026-10-24 确认该方向）。编辑器中的待同步操作由协同核心与持久化队列管理，不能把 Query 的请求缓存或 Zustand persist 当作日记正文事实来源与可靠保存协议。UI 局部状态先用 React，不复制 Query 数据到 Zustand 维护第二份可写来源。[Query 的职责](https://tanstack.com/query/latest/docs/framework/react/guides/does-this-replace-client-state)、[State of React 2025 状态管理调查](https://2025.stateofreact.com/en-US/libraries/state-management/)

视觉建议 CSS 变量与可复用组件表达纸张、作者色和动画；Tailwind 可以选，但不是产品风格。现成组件系统也不会自动产生用户想要的温馨、简约、有质感的界面。

## 6. 协同：优先成熟内核，作者权限仍需独立设计

| 方案 | 通用能力 | 未解决的本项目问题 | 建议 |
| --- | --- | --- | --- |
| ProseMirror + Yjs | 编辑器绑定、CRDT 合并、相对位置、选择性撤销等生态 | 身份到字符来源的不可伪造映射、恶意更新检查、拒绝后的草稿恢复、提交确认 | 第一验证候选；绑定层维护审查也必须通过 |
| 上述方案 + Hocuspocus | 连接、认证钩子、状态加载/存储等基础设施 | 默认认证不是字符级授权；默认延迟存储不等于提交后确认 | 可复用候选，不无条件采用默认配置 |
| ProseMirror collab | 中心化版本和 step 变换 | 长期离线、重放、字符来源、个人撤销及包维护状态 | 对照候选，暂不列为默认生产依赖 |
| Automerge | 本地状态、离线合并、历史及 ProseMirror 集成路线 | 同样需要作者级授权、持久化确认和浏览器/移动端验证 | 第二 CRDT 候选；不声称其编辑器生态缺失 |
| 现有自研原型 | 已覆盖本项目部分行为和故障测试 | 长期算法维护、升级、压缩及更多边界尚未解决 | 保留测试与经验，不直接生产化 |

能力来源：[Yjs](https://docs.yjs.dev/)、[更新语义](https://docs.yjs.dev/api/document-updates)、[个人撤销机制](https://docs.yjs.dev/api/undo-manager)、[Hocuspocus 钩子](https://tiptap.dev/docs/hocuspocus/server/hooks)、[持久化](https://tiptap.dev/docs/hocuspocus/guides/persistence)、[Automerge](https://automerge.org/docs/hello/)。表中的优先级是本项目判断。

必须明确三个边界：

- `Y.Doc.clientID`、客户端 mark、transaction origin 都不能直接当作经过认证的用户身份。作者来源需由服务端建立并验证；格式标记不能让 A 改成 B 的颜色或归属。
- 合并保证依赖合法更新最终到达，不意味着服务端可以随意丢弃恶意更新后，其他离线更新仍会自然正确恢复。要测试对被拒绝更新有依赖的后续操作，保留可恢复的本地输入。
- Hocuspocus 提供应用前拦截钩子，但不替我们实现权限证明；文档给出的 `onStoreDocument` 有 debounce。必须验证**校验 → 原子落库 → 确认已持久化 → 广播已提交状态**，不能收到同步消息就显示“服务端已保存”。

第一轮对比验证至少覆盖：伪造作者、改作者 mark、删除他人字符、混合选区、撤销/重做、离线交错插入、重复/乱序更新、ACK 前后崩溃、更新拒绝、旧客户端重连。检查来源和时间元数据在快照压缩/恢复后是否仍然完整。线上光标是临时状态，不当作持久日记内容。

编辑器倾向直接 ProseMirror；Tiptap 是上层封装，可在需要更多内容类型时评估。它不能绕开底层维护风险，且要区分开放源码包与商业扩展/托管能力。[Tiptap 文档及扩展目录](https://tiptap.dev/docs/editor/getting-started/overview)

## 7. iOS / Android：共享业务与协议，不承诺所有界面一份代码

推荐 **React Native + Expo** 作为双平台客户端路线。RN 官方推荐新项目采用框架并明确列出 Expo；因此这是有官方支持的主流路径，不是为了少写代码而采用的临时工具。[RN 官方建议](https://reactnative.dev/docs/environment-setup)

可共享：身份与空间领域类型、API 客户端、同步状态机、权限规则的通用实现、协议编解码、日期处理和测试用例。需要平台适配：UI、导航、键盘、选择和剪贴板、本地数据库、凭据存储、生命周期与推送。

**最大门槛仍是编辑器。** ProseMirror 使用 DOM，不能直接渲染为 RN 原生 TextInput。Expo DOM components 提供通过 WebView 复用 Web 组件的路径，但桥接是另一层边界；应让每次输入和编辑器状态在编辑器侧本地处理，跨桥传语义事件和必要状态，不传整篇正文驱动每次按键。[Expo DOM components](https://docs.expo.dev/guides/dom-components/)

离线数据建议浏览器使用 IndexedDB，原生侧使用 SQLite 适配器。必须实测 WebView 存储、原生 SQLite 和桥接确认之间的持久化路径，不能只因有 SQLite 就声称 WebView 输入已经可靠落盘。[Expo SQLite](https://docs.expo.dev/versions/latest/sdk/sqlite/)

| 替代路线 | 什么情况下更合适 | 代价 |
| --- | --- | --- |
| Capacitor + 当前 Web UI | 优先最低改造成本上线移动应用，Web 编辑体验实机通过 | 多数界面仍为 Web；键盘、导航、无障碍与原生能力需要专门打磨 |
| Flutter | 移动界面优先，团队偏好 Dart，愿意重新投资编辑器集成 | 不能直接复用 TS/React UI；现有 DOM 编辑器仍需桥接或另选实现 |
| SwiftUI + Kotlin/Compose | 平台体验和系统整合明显比跨端效率重要，有维护两套客户端的人力 | 编辑器桥接或重做成本，以及跨语言契约成本 |

来源：[Capacitor](https://capacitorjs.com/docs)、[Flutter 架构](https://docs.flutter.dev/resources/architectural-overview)。这不是移动端市场占有率排名。

移动端先做一个很小的实机验证：双方输入、作者色、保护退格、中文组词、emoji、长按选区、键盘遮挡、后台/杀进程后重启和飞行模式恢复。通过后再确认 Expo + WebView 的正式 ADR。若编辑体验不合格，应调整移动编辑器路线，不因已经选择 React 就强行坚持。

后台连接不能作为保存保证。恢复到前台必须从本地未确认队列补传。面向国内外发布还要分别验证登录、推送、Google 备份可达性；Google 备份授权不应成为所有用户写日记的前提。商店登录、账号删除和支付规则在提交阶段按目标地区再次核验。

## 8. 服务端框架、API 与认证

### Fastify 是当前倾向，不冒充生态第一

| 框架 | 选择理由与限制 |
| --- | --- |
| Fastify | 插件封装、校验、日志和生命周期适合模块化常驻服务；有公开支持政策；我们需自己维持清晰模块边界 |
| NestJS | 团队扩张、希望依赖注入和统一模块约定时很合适；初期增加一定结构成本；它可使用 Fastify adapter，两者不是完全互斥的同层选择 |
| Hono | Web 标准、多运行时部署是明确优势；若主要选 Workers/边缘平台值得优先评估；当前主要需求不需要多运行时迁移 |
| Express | 使用广泛、可以生产运营；我们的选择主要考虑校验和封装方式，并非认定 Express 落后或停更 |
| ElysiaJS | 新生态值得跟踪；当前不为新颖度增加运行时与插件整合负担 |

来源：[Fastify](https://fastify.dev/docs/latest/)、[Nest Fastify adapter](https://docs.nestjs.com/techniques/performance)、[Hono](https://hono.dev/docs)。API 框架性能通常不会先于跨国网络、持久化和编辑器行为成为当前瓶颈，这是需要测量验证的工程判断。

普通接口建议 HTTP JSON + OpenAPI 契约；采用 Zod 等运行时 schema 并与框架校验/文档生成打通，避免两份 schema 漂移。协同协议单独版本化，HTTP 重试/WS 重连都不能改变操作语义。tRPC 是合理备选，能提高全 TS 开发效率，但不应让未来 Swift/Kotlin 客户端只能理解服务器内部 TS 类型。[tRPC](https://trpc.io/docs/)

认证优先集成成熟方案，**Better Auth 是第一集成候选，不是本报告已批准的依赖**：官方有 Fastify、Google 与 Expo 指南，组合方向匹配；仍需核验锁定版本、安全公告、cookie/CSRF、账号关联、移动回跳和会话撤销。[Fastify 集成](https://better-auth.com/docs/integrations/fastify)、[Expo 集成](https://better-auth.com/docs/integrations/expo)、[Google 配置](https://better-auth.com/docs/authentication/google)

Supabase Auth/其他托管 OIDC 可作为减少运维的备选，要评估数据迁移和实际地区可用性。产品登录与 Google Drive 授权分开；后者还涉及增量授权、offline refresh token、安全存储、撤销和失效恢复，不能以“Google 登录成功”作为备份授权测试通过。[Google 服务端 OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)、[Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)

## 9. 数据、任务与基础设施

主库保持 **PostgreSQL**。每个空间/日期的唯一约束、提交版本、操作幂等和 outbox 都应由数据库约束与事务保证。行锁可按文档粒度协调提交，不用全站串行锁。[PG 锁文档](https://www.postgresql.org/docs/current/explicit-locking.html)

Drizzle 倾向于适合当前显式 SQL/事务需求，Prisma 也是可行的主流候选，二者都支持事务；不应把“Prisma 不能事务”作为理由。最终比较应包括迁移 SQL 可审查性、行锁/原生 SQL、连接池、认证适配和故障注入。现有 `pg` 也可以继续承担关键事务，没有必要为统一风格重写已经清楚的 SQL。[Drizzle 事务](https://orm.drizzle.team/docs/transactions)、[Prisma 事务](https://www.prisma.io/docs/orm/fundamentals/transactions)

本地 Web 存储可引入轻量 IndexedDB 封装，如 idb；复杂查询再考虑 Dexie。浏览器存储默认可能被回收，申请持久化也可能不获批，不能承诺在用户清理站点或设备损坏后仍恢复所有未同步输入。我们要保证的是不静默覆盖待发内容，明确持久化失败并尽快同步/提供恢复途径。[Dexie 对存储持久化边界的说明](https://dexie.org/docs/StorageManager)

后台先用 **PG outbox + 独立 worker**。需要现成重试、调度和队列管理时评估 pg-boss；待实际出现更高吞吐或独立缓存需求再引入 Redis/BullMQ。不承诺外部 Google 请求 exactly-once：数据库与 Google API 不属于同一事务，必须设计幂等、版本与重试。[pg-boss](https://github.com/timgit/pg-boss)

Supabase 可以提供托管 PG/Auth 等服务，但其 Broadcast、Presence 和 Postgres Changes 本身不是已满足我们规则的字符级协同引擎。其他现成同步产品也必须接受相同作者保护和持久确认验证。[Supabase Realtime 能力范围](https://supabase.com/docs/guides/realtime)

建议初期形态：一个仓库、模块化后端、常驻 API/WS 进程、独立 worker、托管 PG、静态 Web 资源。客户端与 API 尽量同源，减少会话部署复杂度。实际提供商等地区、预算和中美连接测试后再定，不在未调研价格时承诺免费长期运营。

无需提前引入 Kubernetes、Kafka 或微服务。横向扩容时，再根据连接数、写入和内存指标加按文档路由/共享通知；所有实时广播都不能绕过授权和已提交版本规则。跨国延迟优先用本地即时输入、稳定队列和减少往返处理，不先上全球多写数据库。

Serverless 不是一概不可行：Cloudflare Durable Objects 明确支持 WebSocket。但把房间、生命周期和存储绑定到该平台是另一套架构取舍，当前优先普通 Node 服务的可迁移性。[Durable Objects WebSocket](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)

Google 可读文档与可恢复快照继续按现有 ADR 单向导出。另保留 PG 自身备份与恢复演练，不能把第三方导出成功当作数据库完整恢复能力的全部证据。

## 10. 工程工具与正式选型清单

| 层 | 当前推荐 | 状态 |
| --- | --- | --- |
| 语言 / 运行时 | TypeScript strict / Node LTS | 推荐 |
| Web | React + Vite + React Router | 推荐 |
| React 状态管理 | TanStack Query + 按需使用 Zustand；局部状态使用 React | 用户已确认方向，尚未安装 |
| 编辑器与同步 | ProseMirror + Yjs；Hocuspocus 候选 | 维护审查、权限与持久化验证后决定 |
| 移动 | React Native + Expo，编辑器 WebView 候选 | 实机验证后决定 |
| API | Fastify、HTTP JSON/OpenAPI、版本化 WS | 推荐；尚未完成集成 |
| 数据库 | PostgreSQL | 已确认方向 |
| 数据访问 | Drizzle + 必要的显式 SQL/pg | 推荐；迁移和事务测试后锁定 |
| 身份 | Better Auth 优先验证；托管 OIDC 备选 | 安全与 Web/移动集成后决定 |
| 离线 | Web IndexedDB | 用户已确认；手机相关存储与桥接验证后置 |
| 导出 / 备份 | PG outbox + worker + Google APIs | 已确认方向；正式集成未完成 |
| 仓库 | pnpm workspace，按实际模块拆包 | 推荐；移动模块不提前空建 |
| 验证 | 保留现有 Node tests；Playwright + 真实 PG；React/TS 需要时采用 Vitest | 不为更换测试框架重写已有有效测试 |
| 运维 | 容器/普通 Node 进程、托管 PG、结构化日志和告警 | 部署提供商待定 |

pnpm 已内置 workspace，不必一开始加 Nx/Turborepo。Vitest 与 Vite 集成方便，但协同正确性的证据来自真实故障、权限和多客户端测试，不来自换一个运行器。[pnpm workspace](https://pnpm.io/workspaces)、[Vitest](https://vitest.dev/guide/)

格式、lint、类型检查、schema/协议兼容、故障恢复等 CI 在技术栈确定后按真实项目落地。日志和错误收集默认排除正文、OAuth token 和导出内容。需要跟踪的指标包括提交耗时、未确认队列年龄、重连失败、权限拒绝、备份积压和恢复演练结果。

## 11. 下一步顺序与决策条件

1. **维护门槛检查**：补齐编辑器绑定层、新源码站与认证候选的维护/安全证据；无法通过者不进入生产默认组合。
2. **成熟协同内核对比**：用同一套产品行为与故障场景验证 Yjs 路线；若失败，记录具体原因，再评估 Automerge 或其他方案。不得用流行度覆盖失败。
3. **移动编辑器小验证**：实体 iPhone 与 Android，确认输入、选区、后台恢复及原生持久化桥接。
4. **身份与 PG 最小闭环**：真实登录、两人空间、明确租户隔离、迁移、提交确认、授权撤销和草稿保留。
5. **写正式 ADR 并锁版**：记录版本组合、替代方案、维护状态、升级与迁出路径；再搭正式骨架和 CI。
6. **实现每日一篇与 Google 导出**：沿用现有 spec 和验收编号，不把原型通过项自动勾成产品通过。

本报告进行了官方文档、调查和 registry 元数据调研，未运行上述候选的集成基准，也未完成其安全审计。此前原型的测试通过仅适用于当时实现；尚不能证明 Yjs/Hocuspocus、真实认证或移动端已经满足本项目要求。
