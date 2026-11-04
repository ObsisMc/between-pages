# Between Pages：产品与架构文档

当前进度见[开发路线](./roadmap.md)（唯一记录进度的地方）。

## 阅读顺序

0. [项目主旨与命名](./project-identity.md)：暂定品牌与产品理念。
1. [MVP 功能规格](./diary-spec.md)：范围、交互规则、数据模型、接口语义及可靠性要求。
2. [验收清单](./acceptance.md)：按需求编号组织的可复现验收场景及发布门槛。
3. [ADR 索引](./adr/README.md)：为什么采用这些设计，哪些技术选择仍需验证；[个人日记与双人共享](./adr/2026-10-25-spaces-and-invitations.md)说明关系、日期范围和版本边界。
   - [日记协作内核 ADR](./adr/2026-10-26-diary-collaboration-kernel.md)：增量保存、共享轮次、保留原 ID 的干净基线、有序本地日志、固定批原子提交、正文与光标协调、跨轮次未读和长期只读历史；记录已确认规则、技术细节与两阶段验证边界。
4. [最终技术验证报告](./validation/collaboration-readiness-2026-10-24.md)：浏览器、PG、离线恢复、故障、性能与进入下一阶段的判断。
   - [Yjs 验证报告](./validation/yjs-collaboration-2026-10-24.md)：后续开源内核验证，聚焦作者权限及断线恢复。
   - [Web 基本性能检查](./validation/yjs-web-smoke-2026-10-24.md)：日常规模和多次续写的性能、保存与刷新恢复。
   - [内核设计验证](./validation/diary-kernel-design-2026-10-26.md)：保留原 ID 的干净基线、本地日志与严格依赖补验，归档原始输出；不代表产品已实现。
   - [内核批次验证](./validation/diary-kernel-batch-2026-10-26.md)：固定批次与整批原子提交在真实 PG 和浏览器日志上的临时验证，归档原始输出；不代表产品已实现。
   - [内核共享集成实测](./validation/diary-kernel-sharing-2026-10-27.md)：阶段 4 的正式代码实测：1000 篇日记一次开放的两阶段耗时、锁持有时间与锁内重建篇数；约 500 ms 往返时三种浏览器的本机输入、远端正文与光标延迟。
5. [正式技术栈 ADR-0006](./adr/0006-formal-stack.md)：已采纳的栈与协同内核；[正式实现准备方案](./implementation-preparation.md)：开发规范建议。
   - [技术栈深度调研](./research/tech-stack-2026-10-24.md)：采用度、持续维护、Web/移动端路线与正式选型门槛。
6. [第一轮历史记录](./validation/collaboration-core-2026-10-24.md)：早期协议层验证。

## 后续功能备忘

[未来功能清单](./future-features.md)记录暂缓场景和重新评估问题，目前包含误绑纠正、更换搭档与历史版本回滚；不表示已排期，实施进度仍只见开发路线。

## 市场与产品研究

- [情侣软件市场、用户需求、产品审查与上线推广报告（2026-10-30）](./research/market-product-launch-2026-10-30.md)：竞品、用户反馈、仓库现状与产品验证建议的日期快照。报告中的建议和仓库评价不是已确认的产品规格或当前进度；实施范围与状态分别以[功能规格](./diary-spec.md)和[开发路线](./roadmap.md)为准。

## 视觉探索

- [2026-10-30—31 前端示意图与早期原型归档](./design/2026-10-31-visual-exploration/README.md)：保存本轮主页、日记工作区、小角色和两地时间的探索资料；其中只有主页方向已写入 ADR。
- [2026-11-01 心愿与礼物视觉探索](./design/2026-11-01-wishes-exploration/README.md)：桌面与手机的心愿列表、私密准备、礼物墙示意；图像和交互均待确认，功能规则见心愿与送礼 ADR。
- [2026-11-01 日期界面视觉探索](./design/2026-11-01-dates-exploration/README.md)：见面月历、纪念日与见面计划两种日期选择方式；图像和交互均待确认。

## 界面设计提议

- [数字书页与轻拟物双窗（2026-11-03）](./design/2026-11-03-digital-paper/README.md)：全部页面的可交互示意、逐页截图、圆团子效果稿与实施约束；配套 [ADR](./adr/2026-11-03-digital-paper-interface.md)已采纳，实现进行中。

## Engineering (English)

- [Architecture](./architecture.md): modules, dependency direction, runtime flow.
- [Engineering standards](./engineering-standards.md): code rules with examples, reserved vocabulary.
- [Testing](./testing.md): tiers, coverage gate, mocks, flaky tests.
- [Postmortems](./postmortem/README.md): when to write one and how.
- Agent instructions and commands: [AGENTS.md](../AGENTS.md); workflow: [CONTRIBUTING.md](../CONTRIBUTING.md).

## 状态约定

- **已确认**：来自双方讨论的产品要求；实现必须满足。
- **实施默认**：为让规格可落地而补充的建议，可在实现前调整，不冒充用户已经确认的决定。
- **待验证**：技术方案尚未通过原型或测试，不能视为已经具备能力。
- 产品级验收项初始均未完成；协议层测试通过不自动等同于界面与正式服务已经通过验收。

这组文档覆盖每日日记、双人协作、Google 可读导出与备份。日记之外的双人空间功能（两地时间、心愿与送礼、见面计划、纪念日、共享页面）的共用规则见[双人空间记录 ADR](./adr/2026-10-29-space-records.md)，各功能的设计见各自的 ADR；它们的验收项随实现补充。
