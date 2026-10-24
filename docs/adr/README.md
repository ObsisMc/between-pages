# 架构决策记录

日期：2026-10-24。“已采纳”表示设计决定成立，不表示代码已经实现。“提议，待验证”必须通过验证再升级状态；后续改动通过新 ADR 替代，保留决策历史。

| ADR | 状态 | 决策 |
| --- | --- | --- |
| [0001](./0001-diary-domain-and-time.md) | 已采纳 | 每日共享文档、字符级用户归属、本地日期和 UTC 时间分离 |
| [0002](./0002-collaboration-and-author-authorization.md) | 技术验证通过；正式选型待确认 | 受约束增量操作、作者保护与重连合并；最终序列算法/编辑器待选 |
| [0003](./0003-postgres-and-durable-commit.md) | 已采纳；部署待选 | PG 主存储、持久化确认、事务 outbox；替换 D1 脚手架默认 |
| [0004](./0004-google-export-and-recovery.md) | 已采纳；运维默认待调整 | Google 可读单向副本与版本化恢复数据分开保存 |

产品需求见 [规格](../diary-spec.md)，验证义务见 [验收清单](../acceptance.md)。
