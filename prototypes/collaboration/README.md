# 协同核心验证原型

这是技术验证台，正式应用尚未开始实现。验证范围包括协议权限、真实 PostgreSQL 事务、浏览器编辑、IndexedDB、多标签页、WebSocket 光标与离线刷新。最终技术栈和开发规范仍需在正式实现前确认。

## 运行

需要 Node.js 24+。第一次运行浏览器测试时安装 Playwright 浏览器：

```sh
npm ci
npx playwright install chromium firefox webkit
npm run test:prototypes
npm run test:pg:docker
npm run test:browser
npm run test:browser:pg
npm run benchmark:collab
```

PG 测试需 Docker。脚本创建独立的、仅监听本机临时端口的数据库，结束后自动删除。默认镜像 `postgres:18-alpine`，可通过 `COLLAB_TEST_PG_IMAGE` 指定版本或 digest。

也可设置 `COLLAB_TEST_DATABASE_URL` 后运行 `npm run test:pg` 或 `npm run test:browser`。必须使用可丢弃的测试数据库，测试会创建 `collab_probe_*` 表及虚构数据。

手动查看诊断编辑器：

```sh
npm run dev:probe
```

启动后终端给出本机地址；在两个窗口打开相同 `doc`、不同 `actor=A` / `actor=B`。关闭进程即结束服务；此命令的服务端数据仅在内存中，浏览器草稿由 IndexedDB 保留。它不是正式可用的日记服务，不包含真实身份认证。

## 模块边界

| 文件 | 契约 |
| --- | --- |
| model.mjs | 实验性稳定 Unicode scalar ID 插入树、删除标签与个人操作 toggle；无全文覆盖入口 |
| authority.mjs | 可信会话身份、严格载荷、作者保护、时钟检查、原子批次及幂等 |
| client.mjs | committed / pending / recovery 分离，本机持久化，旧状态合并及批次重试 |
| file-journal.mjs | Node 文件持久化验证适配器，原子替换和文件/目录同步 |
| postgres.mjs | 文档行锁串行提交，操作、版本和 outbox 同事务；提交后才确认 |
| http.mjs | HTTP 权限验证台，身份由服务端 resolver 提供，不从正文取 actor |
| browser/journal.mjs | IndexedDB readwrite 事务内合并快照、广播标签页更新、提交完成后才确认本机保存 |
| browser/policy.mjs | 整篇可见文本的 grapheme 边界、作者级删除跳转、相对光标与缓存 |
| browser/editor.mjs | ProseMirror 编辑与 composition 缓冲；诊断接口供测试使用 |
| browser/server.mjs | 仅监听本机的测试静态服务、HTTP 和 WebSocket 房间，支持内存或测试 PG |
| browser/sw.js | 测试离线 shell，只缓存静态页面/脚本，不缓存私有 API 正文 |
| test/ | 攻击、并发、断线、随机调度、真实浏览器、PG 与 SIGKILL、性能测试 |

原型只操作已存在的虚构日记。没有正式邀请、Google 登录或备份上传。HTTP/WS 使用固定测试 token 到 A/B/C 的服务端映射；不能将此验证台公开部署为产品。

## 协议与可靠性

`edit` 仅允许 `id, kind, clock, after, text, deleteIds`，新增作者由认证会话确定。删除目标必须全部属于该作者，失败则整条操作不提交。`toggle` 只能启用/停用自己的 edit，撤销不会移除另一人的后续插入，也不会误清除其他设备独立产生的删除标签。

稳定字符标识为 `{operationId}/{scalarIndex}`。底层保存 Unicode scalar，编辑器在整篇可见文本上计算 grapheme 边界；后加的重音符、emoji 组合及旗帜可被完整处理。跨作者共同形成的 grapheme 采取保守保护，禁止部分修改。插入树保留删除锚点，离线插入仍能定位。

客户端合并已提交日志与本机 pending，不赋值覆盖全文；只有读到完全匹配的已提交记录才清除 pending。乱序完整日志可重排，稀疏缺口不部分应用，保留本地内容并重新拉取。服务端拒绝的内容保留为明确标记的恢复草稿。

最多 64 条操作组成一个原子提交批次，批内依赖按顺序验证。任何一条越权或非法则整个批次不提交。单条 payload 仍限制 4096 UTF-16 长度/4096 删除目标；大段粘贴和大范围删除需在正式实现中拆分为有明确事务语义的受限批次。验证台不会把超限输入伪称为保存成功。

禁止客户端把逻辑时钟跳到上限；服务端只接受符合当前因果进度的计数。重试按操作 ID 去重，重用 ID 改载荷或改作者被拒绝。

## 测试覆盖与边界

浏览器套件使用真实 Chromium、Firefox 和 WebKit 引擎，并分别连接内存服务和 PG；包含触屏/小视口模拟。Chromium CDP 覆盖浏览器原生 composition 路径，Chromium 另有原生剪贴板测试。三引擎公共 clipboard handler 用 fixture 测试，明确不冒充三平台原生剪贴板。

这些结果不等于实体 iPhone / Android 的 OS 输入法、后台回收、低内存与真实中美网络已经验收。未测试能力也包括正式账号安全、生产多实例路由、日志压缩、协议升级和 Google 上传。

初次加载仍重建完整日志，序列算法为实验实现。生产前应审查内核、冻结版本与迁移策略，并保留已建立的回归测试，不直接复制验证代码上线。

完整结论见[验证报告](../../docs/validation/collaboration-readiness-2026-10-24.md)及[正式实现准备方案](../../docs/implementation-preparation.md)。
