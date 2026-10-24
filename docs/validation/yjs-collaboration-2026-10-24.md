# Yjs 第一轮协同编辑验证

日期：2026-10-24。范围：作者权限、离线输入、重连、PG 持久确认及现有浏览器编辑行为。不是正式应用上线验收，也不宣布生产数据格式已经确定。

后续补充：[Web 基本性能检查](./yjs-web-smoke-2026-10-24.md)已完成日常规模和有限编辑历史的测试，不等于大文档压力、压缩或升级验证。用户已要求先不进行正式实现，当前只整理现有文档、原型和证据。

## 结论与适用范围

本轮实现了 **服务端验证语义操作后生成权威 Yjs 更新** 的原型。Yjs 替代旧实验插入树，客户端使用真实 Yjs 更新恢复已提交文档，并叠加本地未确认操作。作者权限、重试和可靠确认属于项目自己的边界，不能由 CRDT 合并能力自动获得。

已测场景中，越权删除/替换/撤销及伪造来源均被服务端拒绝；合法本地输入在旧快照、离线刷新、丢 ACK 和服务进程崩溃后保持可见或从持久化队列恢复，没有在重试时重复插入。详细结果以本节测试表和保留的日志为准。

这条路线值得继续验证，**尚不作为生产内核最终定案**：完整日志重建和逐字符对象的性能、历史压缩、协议升级及真实移动端均未通过本轮验证。

## 实现和信任边界

1. HTTP 会话解析得到 actor；客户端只提交严格 schema 的插入、删除或撤销意图。actor、authorId、clientID 和任意二进制 update 不能夹带进写入请求。
2. 服务端从已提交记录重建隔离的 Y.Doc，检查字符目标、归属、撤销对象、逻辑时钟和幂等 ID。整批全部合法才生成可提交结果。
3. 通过公共 `Y.Array` / `Y.Map` API 保存字符序列、来源、编辑操作及撤销状态。应用 ID 与 Yjs clientID 无关，未依赖 Yjs 私有 struct。
4. PG 按文档行锁协调服务实例；语义记录、对应 Yjs 增量、版本和 outbox 同事务提交。提交后才返回成功并广播变更通知。
5. 客户端保存 committed、pending、recovery。已提交 Yjs 更新和本地待发意图分开；旧/重复记录做合并，不赋值覆盖全文。明确确认过的操作才能从 pending 移除。
6. 浏览器继续通过受约束的 ProseMirror 适配器输入，复用 IndexedDB 原子 journal 合并及在线光标锚点；两种引擎使用不同本地 journal 命名空间。

本轮不是标准 y-prosemirror/provider 接线，未安装 y-prosemirror 或 Hocuspocus，不能声称它们已通过维护或集成验证。同步通道仍拉取完整权威记录；没有实现网络 state-vector 差量或生产快照压缩。[Yjs 更新 API](https://docs.yjs.dev/api/document-updates)、[共享序列 API](https://docs.yjs.dev/api/shared-types/y.array)

设计记录：[ADR-0005](../adr/0005-yjs-authoritative-validation.md)。代码入口与运行方法：[Yjs 原型说明](../../prototypes/yjs/README.md)。

## 自动验证结果

| 套件 | 场景数 | 结果 / 原始证据 |
| --- | --- | --- |
| Yjs 协议、权限和恢复 | 22 | 通过；[core.log](./artifacts/yjs-2026-10-24/core.log) |
| Yjs + 真实 PostgreSQL | 12 | 通过；[postgres.log](./artifacts/yjs-2026-10-24/postgres.log) |
| 三浏览器 + Yjs 内存后端 | 41 | 通过；[browser-memory.log](./artifacts/yjs-2026-10-24/browser-memory.log) |
| 三浏览器 + Yjs PG 后端 | 41 | 通过；[browser-postgres.log](./artifacts/yjs-2026-10-24/browser-postgres.log) |
| 默认核心测试（旧协议/策略 39 + Yjs 22） | 61 | 通过；[all-core.log](./artifacts/yjs-2026-10-24/all-core.log) |
| 旧内核 PG 回归 | 12 | 通过；[legacy-postgres.log](./artifacts/yjs-2026-10-24/legacy-postgres.log) |
| 旧内核浏览器回归 | 36 | 通过；[legacy-browser.log](./artifacts/yjs-2026-10-24/legacy-browser.log) |

Yjs 共有 75 个不同用例；同一套 41 项浏览器测试在两个后端各运行一次，共 116 项次全部通过。默认核心测试包含 Yjs 的 22 项，不能再当作额外的 22 个不同用例累加。

确定性调度额外覆盖 30 个插入网络调度、共 1,200 次插入，以及 15 个混合调度、共 525 步。混合调度包含 A/B/A 三设备、删除自己的字符、个人撤销/重做、丢 ACK 和客户端重开。检查最终一致、无重复 ID，以及全部预期可见字符的来源与内容。随机步骤不是单独的产品验收项，也不是对任意网络调度的形式化证明。

### 作者权限证据

- 独立 vanilla Y.Doc 可以应用服务端实际二进制更新，乱序和重复应用后得到相同序列。
- 对照测试故意绕过权限，直接应用恶意 Yjs 更新，可以删除他人字符。这证明通用 `applyUpdate` 本身不是作者级安全边界；并非本服务端接受了这次攻击。
- 受控通道拒绝他人删除/替换、伪造 actor/authorId/clientID、附带恶意二进制更新、撤销他人编辑、重复 ID 换身份/换载荷及未知锚点。
- 批次第二条非法时，第一条合法插入也不发布，PG 版本和 outbox 不增加。
- 通过测试身份 B 的真实 HTTP 请求绕过界面发起攻击，确认共享正文与更新记录未改变；测试身份来自固定 token 映射，不能等同生产 Google 登录审计。
- ProseMirror 中 A/B/A 字体归属、保护退格跳转、混合选区替换/剪切拒绝、粘贴去除外部 author 属性、个人撤销不删对方内嵌文字均运行浏览器验证。

### 不丢字与持久化证据

- 离线连续输入、基于本地新增字符继续输入，旧快照到达后保留待发操作。
- IndexedDB 存储后刷新、真实 browser context offline 后刷新、同账号多标签页合并，恢复时不以旧全文覆盖。
- 数据库提交后丢失确认，保留 pending；重新加载服务/连接池并重试后只提交一次。
- 两个服务实例同时写同篇日记，及多请求重复提交同一批次，版本、更新记录和 outbox 保持一致。
- SQL 写入后、COMMIT 前故障回滚；真实子进程在 COMMIT 前/后分别 SIGKILL，恢复结果符合对应事务边界。
- 在三个浏览器中使用服务端屏障：操作已提交但 HTTP 响应仍挂起，此时刷新，待发队列仍能恢复并根据已提交记录去重。随后用合成 pagehide/pageshow 检查恢复处理器还能继续写入；这部分不冒充真实 BFCache 测试。
- Chromium 的 DOM MutationObserver 观察中，已输入文本在旧快照和响应丢失场景中未消失；最终两端文字一致。它覆盖该场景的 DOM 变化，不是所有浏览器每一帧画面的证明。
- 本地存储失败显示失败状态并保留当前页面输入；拒绝/不兼容操作保留完整恢复草稿和依赖操作，不伪装已保存。

## 发现的问题与修正

保留了[初次 PG 浏览器失败日志](./artifacts/yjs-2026-10-24/browser-postgres-initial-failure.log)：WebKit 在刷新附近报告同源 records 请求的 access-control pageerror，文字恢复断言未报告丢失。单独重复存储测试未稳定复现；进一步加入“提交后响应挂起再刷新”后，捕获到旧页面拉取请求的堆栈。

上游报告说明 WebKit 会把文档替换期间的新请求取消错误分类为访问控制错误，并可能通过 Playwright `pageerror` 暴露。本次现象与其吻合，不把错误文案直接解释为服务端 CORS 配置问题，也不声称核验了当前二进制的 WebKit 源码。[Playwright 上游问题](https://github.com/microsoft/playwright/issues/43120)

原型加入离页请求收尾：beforeunload 尽早停止新请求，pagehide 作后备，取消旧请求、重连及重试；传输入口再次检查已暂停/离页状态；pageshow 恢复时重建请求生命周期。未屏蔽 pageerror，未放宽错误断言。**离页事件不是保存机制**：移动端未必派发这些事件，输入可靠性仍依靠编辑时的本地持久化与重试。

修正后，定向测试及最终两轮全量 Yjs 浏览器测试均通过，旧内核浏览器回归也通过。结论限于所列环境与调度，不声称修复 WebKit 引擎本身或覆盖所有导航生命周期。

测试夹具也经过修正：最初依赖 Playwright 路由挂起响应，在 Firefox/WebKit 未可靠触发，记录于 [内存夹具失败日志](./artifacts/yjs-2026-10-24/browser-memory-interception-fixture-failure.log)及 [PG 排查轮次](./artifacts/yjs-2026-10-24/browser-postgres-interception-fixture-attempt.log)。最终改为服务端提交后屏障，直接控制真实提交/响应边界。夹具失败与应用导航错误分别记录，没有通过删掉失败断言获得通过。

## 环境、复现与证据边界

- Node v24.20.0；Yjs 13.6.33；PostgreSQL 18.6（临时 Docker 数据库）。
- Playwright 1.64.1；Chromium 156.0.8078.4、Firefox 157.0、WebKit 27.2；Linux 无头浏览器。
- 250ms 额外 API 请求延迟测试有 20 个输入样本；其数字保留于日志。它是本地注入延迟，不是中美真实网络或实体手机性能。未用这轮小文档测试推导大文档容量。
- 源码与依赖摘要：[source-manifest.json](./artifacts/yjs-2026-10-24/source-manifest.json)。日志仅使用合成文字和固定测试身份。

```sh
npm ci
npm test
npm run test:yjs:pg
npm run test:yjs:browser
npm run test:yjs:browser:pg
```

本轮未测试或未完成：大文档/长历史的时间和内存预算，快照/墓碑压缩后的作者来源及撤销语义，协议和 IndexedDB 升级，真实多租户认证与会话撤销，移动端 WebView/SQLite 衔接，实体手机 OS 中文输入法、后台/杀进程、低内存，以及实际 Google 导出/备份。CDP composition 是浏览器组合输入，合成生命周期是处理器验证，均不能替代这些门槛。

## 下一阶段

继续保留维护审查门槛；先量化 Yjs 表达和完整历史重建的成本，再验证快照/增量同步与旧客户端兼容，随后推进 Web 正式骨架与真实身份隔离闭环。用户于 2026-10-24 确认手机相关工作暂缓，实机及原生编辑器验证不作为当前 Web 推进的前置条件。没有通过相应验证前，不把该原型写成“生产级协同已完成”，不勾选完整产品验收清单。
