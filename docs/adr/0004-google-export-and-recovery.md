# ADR-0004：Google 可读副本与恢复快照

- 状态：已采纳
- 日期：2026-10-24
- 决策者：Ray
- 范围：备份
- 关联：依赖 ADR-0003；数据快照与恢复要求被 server-backup-and-google-docs 取代

> 迁移说明（2026-10-25）：ADR 改为新格式，本文正文冻结。原状态行为：已采纳；频率、保留周期及文件组织为实施默认，可调整。

## 背景

用户希望服务器不可用后仍能独立阅读日记，且数据可从独立服务恢复。Google Doc 适合阅读，却不能仅凭字体颜色完整恢复作者 ID、写入时间、读取进度及协同状态。

## 决策

1. 采用 PG 主存储到 Google 的异步单向输出，不做 Google Docs 双向共同编辑。
2. 每日一份可读 Google Doc，保留日期、名字/颜色图例、原顺序正文及换行；按年/月组织为实施默认。
3. 同时上传版本化、可校验的结构化数据快照，保留恢复所需状态。快照记录 schemaVersion、文档/空间 ID、提交版本、UTC 创建时间、校验和及必要的文件映射，不导出会话或 OAuth 凭据。
4. 文件归备份目标用户的 Google 账号管理，应用停止后仍可直接访问。首版一个空间连接一个目标；共享给另一方需明确操作，不默认公开。
5. Google 登录认证与 Drive 授权解耦。最小授权优先使用 drive.file；后台使用 OAuth 离线访问。令牌加密保存，撤销/过期可重新连接；用户断开授权不删除既有文件。
6. 任务来自事务 outbox，按文档串行化、幂等重试、失败退避。Doc 和快照分别记录完成版本，二者共同覆盖的版本才算完整 Google 备份。
7. 检测 Google 外部修改时暂停覆盖并提示；写入带 revision 条件，避免检查与写入之间的竞态。Doc 被删除不反向删除 PG，也不自动无限创建新文件。
8. 备份保留历史，不把所有删除即时传播到历史快照。实施默认保留最近 30 天每日版与最近 12 个月月度版；PG 自身另有备份，不把 Doc 当数据库备份替代品。
9. 服务健康时以约 60 秒备份延迟为初始 RPO 目标，不承诺 Google 故障或断网时同样达成；已上传的数据才受到此独立副本保护。不设未经验证的 RTO 数值。

## 恢复要求

在空环境恢复日记、作者映射、顺序、日期、UTC 时间、读取进度及可继续协作的状态；身份重新绑定并重新授权，不能靠恢复旧登录会话获取访问。恢复前验证 schemaVersion 与完整性。给出实测恢复耗时，作为将来 RTO 目标依据。

仅 Google Doc 可读但结构化快照失败时，明确标记备份不完整；不能宣称完整应用可恢复。

## 替代方案

- 仅同步 Google Doc：能阅读，不能保证完整恢复。
- 仅备份 PG dump：完整恢复价值高，但用户无法直接阅读日记。
- 每键一次同步 Google：增加配额与故障压力，没有必要。
- Google 作为实时编辑主库：当前自定义作者保护与离线行为不易保持；用户已经选择 PG 主存储。

## 后果与验证

异步备份存在尚未上传的窗口，状态必须透明。快照含私密正文，应放在用户受控的私有文件夹，不进公开链接或日志。原生可读 Docs 意味着 Google 能处理明文内容，不能声称端到端加密。

OAuth 外部应用若停留在 Testing 且申请 Drive 权限，刷新令牌通常七天过期；正式运行必须处理发布状态与所需验证，不能依赖反复手工授权。

验收：GOOGLE-01～12。

## 官方资料

- [Docs API 权限范围](https://developers.google.com/workspace/docs/api/auth)：支持 drive.file 等授权范围。
- [OAuth 离线授权](https://developers.google.com/identity/protocols/oauth2/web-server)：后台刷新访问令牌。
- [OAuth 令牌生命周期](https://developers.google.com/identity/protocols/oauth2)：测试状态及其他令牌失效情形。
- [文字格式](https://developers.google.com/workspace/docs/api/how-tos/format-text)：作者字体色的导出能力。
- [Docs 批量更新及写入控制](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate)：条件版本写入。

文件组织、快照结构、保留策略和成功版本语义是本项目决定，不是 Google 默认提供的恢复保证。
