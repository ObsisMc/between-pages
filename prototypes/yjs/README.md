# Yjs 协同验证原型

状态：独立技术验证，不是正式应用。锁定 Yjs 13.6.33；未接入 Hocuspocus、y-prosemirror 或真实登录。

## 验证路径

采用 ADR-0002 路径 A：客户端提交受约束的语义操作；服务端从认证会话取 actor，在隔离候选状态中校验整批操作，然后通过 Yjs 公共 API 生成增量。PostgreSQL 在同一事务保存语义操作、对应 Yjs 更新、版本和 outbox，提交后才响应与广播。

`Y.Array` 保存含稳定应用 ID 的字符，`Y.Map` 保存操作来源和撤销状态。字符保持为逻辑墓碑以支持离线锚点和个人撤销；显示时过滤自己已撤销或删除的内容。删除/撤销不是直接删除 Y.Array 元素；来源字段不能由客户端指定。序列插入位置由权威提交顺序决定，没有继续使用旧原型的插入树。

客户端使用实际服务端 Yjs 更新构建 committed 文档，再重放本地 pending。只接收服务端记录不会用全文替换待发输入。原型暂时发送完整提交日志，尚未实现基于 state vector 的网络差量、快照压缩和生产升级。

这是中心化权威写入的 Yjs 方案，**不是标准任意客户端二进制更新互传**，也不能直接声称兼容现成的 Yjs/Hocuspocus/Tiptap provider。ProseMirror 通过现有受限编辑适配器工作，不依赖 y-prosemirror；该绑定层的维护状态本轮没有因此得到验证。

## 文件职责

- `model.mjs`：只用 Yjs 公共 API 表达字符、操作、删除和撤销；稳定应用 ID 与 Yjs clientID 分离。
- `authority.mjs`：隔离候选文档、严格操作 schema、来源/删除/撤销权限、幂等与原子批次。
- `client.mjs`：复用现有可靠队列客户端，通过可替换 Document 接入 Yjs。
- `postgres.mjs`：独立 `yjs_probe_*` 测试表；行锁、更新日志和 outbox 同事务；禁止提交前 ACK。
- `core.test.mjs`：Yjs 独立副本、权限攻击、故障恢复和确定性网络调度。
- 共用浏览器入口、IndexedDB 和编辑策略：`../collaboration/browser/`；通过 `engine=yjs` 隔离本地 journal 命名空间。

## 运行

```sh
npm ci
npm run test:yjs
npm run test:yjs:pg
npm run test:yjs:browser
npm run test:yjs:browser:pg
npm run dev:yjs
```

PG 命令需要 Docker，创建并清理临时数据库；也可设置 `COLLAB_TEST_DATABASE_URL` 指向可丢弃数据库，再以 `COLLAB_ENGINE=yjs npm run test:pg` 运行。浏览器命令需要已安装 Playwright Chromium/Firefox/WebKit。

手动打开终端输出的 URL，保留 `engine=yjs`，另开相同 `doc` 的 `actor=B`。`probe-A/B/C` 是测试身份固定 token，不是生产认证方案。

## 仍须验证

完整历史重建、逐字符对象及应用墓碑带来时间/空间成本，尚未基准化，不据此定生产数据格式。真实授权/租户隔离、大文档、协议升级、恢复草稿交互、实机中文输入/后台生命周期均未完成。本轮通过不把产品验收清单自动置为通过。
