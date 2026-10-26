# Between Pages

**各自生活，在同一页相遇。**

*Live your days. Meet on the page.*

一个为两个人设计的共同日记空间。随时记下生活里的小事，也能直接在彼此的文字之间，接上自己的想法。各自的声音清楚可辨，散落的日常慢慢成为共同的记忆。

名字暂定为 **Between Pages**，后续可以调整。

## 我们希望它是什么

- 随时能写，也允许不写。没有打卡、断签惩罚和回复倒计时。
- 每人每天一篇个人日记，未绑定也能写；双人空间按各自选定的日期共享，合并展示并支持穿插续写。
- 每个人的文字保留自己的归属，只能修改自己的内容；历史版本只读，不支持回滚；首版首次绑定后搭档固定，也能只看自己的文字。
- 停止共享或解绑保留只读历史；同人重绑恢复原空间，经本人确认可重新开放最新版本。
- 对方后来补在旧文里的文字，也能通过未读定位找到。
- 日记能够长期保留，导出为可直接阅读的 Google Docs，并有独立的恢复备份。

首版聚焦每日日记。见面计划、共同心愿和讨论议题等功能留待之后考虑；误绑纠正与更换搭档暂缓，讨论备忘见[未来功能清单](./docs/future-features.md)。

## 当前状态

更新日期：2026-10-26。阶段 1 进行中：登录与会话已完成，关系管理与范围配置设计待审阅，日记内核主要产品规则及验证标准已确认、ADR 仍为提议，批量验证与技术细节待补齐，相关实现及部署未开始；各项进度只记在[开发路线](./docs/roadmap.md)。

### 技术验证（阶段 0，已完成）

协同编辑的关键行为已在原型中验证：字符级作者保护、服务端校验、断线和刷新后不丢字、PostgreSQL 持久化确认。正式技术栈由 [ADR-0006](./docs/adr/0006-formal-stack.md) 确定，协同采用 Yjs `Y.Text`，客户端发送普通更新，由服务端检查作者权限。证据见[技术验证报告](./docs/validation/collaboration-readiness-2026-10-24.md)、[Yjs 验证报告](./docs/validation/yjs-collaboration-2026-10-24.md)和 [Web 基本性能检查](./docs/validation/yjs-web-smoke-2026-10-24.md)。手机支持与深入性能优化后置。

## 本地开发

需要 Node.js 26（见 `.nvmrc`）和 Docker：

```sh
nvm use && npm ci
cp .env.example .env
npm run db:up && npm run db:migrate
npm run dev:oidc    # 本地模拟登录服务，不需要 Google 账号
npm run dev:api
npm run dev:web     # 打开 http://localhost:5173/，用"开发登录"输入任意名字
```

`.env` 默认使用模拟登录（`AUTH_PROVIDER=dev`）。改用真实 Google：在 Google Cloud 创建 OAuth 客户端，回调地址填 `http://localhost:5173/api/auth/callback/google`，然后在 `.env` 里设置 `AUTH_PROVIDER=google` 和 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`，重启 API。检查命令见 [AGENTS.md](./AGENTS.md#commands)。

## 运行原型验证

```sh
npm run test:prototypes
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
| [验收清单](./docs/acceptance.md) | 个人日记、共享权限、关系生命周期及发布门槛的验收场景 |
| [架构决策记录](./docs/adr/README.md) | 领域模型、协同权限、PG 持久化、Google 导出和恢复 |
| [开发路线](./docs/roadmap.md) | 实现顺序与阶段出口 |
| [未来功能清单](./docs/future-features.md) | 暂缓功能的场景、当前边界与重新评估问题 |
| [技术验证报告](./docs/validation/collaboration-readiness-2026-10-24.md) | 87 个场景、性能样本、已解决风险与剩余门槛 |
| [实现准备方案](./docs/implementation-preparation.md) | 技术栈建议、开发规范与 CI 准备 |
| [技术栈调研](./docs/research/tech-stack-2026-10-24.md) | 采用度、持续维护、状态管理和跨端路线 |
| [Yjs 验证报告](./docs/validation/yjs-collaboration-2026-10-24.md) | 作者权限、断线恢复、真实 PG 与浏览器证据 |
| [Web 基本性能检查](./docs/validation/yjs-web-smoke-2026-10-24.md) | 日常规模、200 次编辑历史、PG 保存与刷新恢复 |

文档明确区分已确认的产品规则、可调整的实施默认和待验证的技术方案。

## 开发方式

开发以[功能规格](./docs/diary-spec.md)和[验收清单](./docs/acceptance.md)为依据。需要设计的功能先写 ADR 评审，再按 ADR 实现；功能完成以可复现的测试和验证结果为准。
