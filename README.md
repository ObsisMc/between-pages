# Between Pages

**各自生活，在同一页相遇。**

*Live your days. Meet on the page.*

一个为两个人设计的共同日记空间。随时记下生活里的小事，也能直接在彼此的文字之间，接上自己的想法。各自的声音清楚可辨，散落的日常慢慢成为共同的记忆。

名字暂定为 **Between Pages**，后续可以调整。

## 我们希望它是什么

- 随时能写，也允许不写。没有打卡、断签惩罚和回复倒计时。
- 一天一篇，两人共写。支持字符之间的穿插表达、实时同步和对方编辑位置。
- 每个人的文字保留自己的归属，只能修改自己的内容。
- 对方后来补在旧文里的文字，也能通过未读定位找到。
- 日记能够长期保留，导出为可直接阅读的 Google Docs，并有独立的恢复备份。

首版聚焦每日日记。见面计划、共同心愿和讨论议题等功能留待之后考虑。

## 当前状态

**已完成自研协同基线与第一轮 Yjs 验证；完整应用尚未实现。**

用户已要求先不进行正式实现；当前只整理并保存方案、验证原型和证据，React/Fastify 正式骨架与工程规范尚未落地。

仓库包含规格、ADR 和可运行的协议/浏览器验证原型。87 个不同场景通过，浏览器套件分别接内存服务和 PG，共执行 123 项次。已有 ProseMirror、IndexedDB、WebSocket 与离线刷新验证；真机和完整产品验收未完成。正式技术栈已由 [ADR-0006](./docs/adr/0006-formal-stack.md) 确定：Node 26、React/Vite、Fastify、PostgreSQL + Drizzle、Zod 契约；协同用 Yjs `Y.Text`，客户端发普通更新，服务端检查作者权限。

前端状态管理方向已确认为 **TanStack Query + 按需使用 Zustand**。正文与未确认操作由协同核心管理。新增 [Yjs 原型](./prototypes/yjs/README.md)验证服务端字符权限及离线恢复，不接受客户端任意二进制更新；正式内核仍待性能、升级与移动端验证。

Yjs 验证包含 75 个不同用例；浏览器套件分别接内存与 PG 后端，全部 Yjs 套件合计执行 116 项次，最终全部通过。原始日志、排查记录与边界见 [Yjs 验证报告](./docs/validation/yjs-collaboration-2026-10-24.md)。

[Web 基本性能检查](./docs/validation/yjs-web-smoke-2026-10-24.md)也已完成：所测场景输入处理 P95 为 3～9 毫秒，本地保存、同步和刷新后文字完整。此结果限于本地原型，不代表完整上线验收；深入优化和手机验证后置。

## 运行核心验证

需要 Node.js 24+：

```sh
npm ci
npm test
```

真实 PG 集成和服务进程崩溃测试需要 Docker：

```sh
npm run test:pg:docker
```

Yjs 专项验证：

```sh
npm run test:yjs
npm run test:yjs:pg
npm run test:yjs:browser
npm run test:yjs:browser:pg
npm run dev:yjs
```

浏览器验证命令与诊断编辑器见[原型运行说明](./prototypes/collaboration/README.md)。完整证据见[技术验证报告](./docs/validation/collaboration-readiness-2026-10-24.md)。验证台不属于正式产品。

## 文档

| 文档 | 内容 |
| --- | --- |
| [项目主旨](./docs/project-identity.md) | 名字、slogan 和产品理念 |
| [完整功能规格](./docs/diary-spec.md) | 日期、字符归属、协同、保存、未读、权限和 Google 集成 |
| [验收清单](./docs/acceptance.md) | 64 项验收场景，其中 60 项为发布阻断项 |
| [架构决策记录](./docs/adr/README.md) | 领域模型、协同权限、PG 持久化、Google 导出和恢复 |
| [开发路线](./docs/roadmap.md) | 实现顺序与阶段出口 |
| [技术验证报告](./docs/validation/collaboration-readiness-2026-10-24.md) | 87 个场景、性能样本、已解决风险与剩余门槛 |
| [实现准备方案](./docs/implementation-preparation.md) | 技术栈建议、开发规范与 CI 准备 |
| [技术栈调研](./docs/research/tech-stack-2026-10-24.md) | 采用度、持续维护、状态管理和跨端路线 |
| [Yjs 验证报告](./docs/validation/yjs-collaboration-2026-10-24.md) | 作者权限、断线恢复、真实 PG 与浏览器证据 |
| [Web 基本性能检查](./docs/validation/yjs-web-smoke-2026-10-24.md) | 日常规模、200 次编辑历史、PG 保存与刷新恢复 |

文档明确区分已确认的产品规则、可调整的实施默认和待验证的技术方案。

## 开发起点

下一步先确定正式技术栈、协议与数据版本，再落地开发规范、模块契约及配套检查。完成这些准备后，将已验证的行为迁入正式应用；真机与生产集成继续作为发布门槛。

后续开发以[功能规格](./docs/diary-spec.md)和[验收清单](./docs/acceptance.md)为依据。技术选择的变化通过 ADR 记录，功能完成以可复现的验证结果为准。
