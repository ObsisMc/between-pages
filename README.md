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

首版以每日日记为核心。日记之外的双人空间功能已列入[开发路线](./docs/roadmap.md)：共用规则已采纳，第一批（两地时间、心愿与送礼、见面计划、纪念日）的设计已采纳，两地时间、心愿与送礼、纪念日已实现，见面计划尚未实现；误绑纠正与更换搭档暂缓，讨论备忘见[未来功能清单](./docs/future-features.md)。

## 当前状态

更新日期：2026-11-07。阶段 1 进行中：登录与会话已完成，关系管理与范围配置设计已采纳，日记内核设计已采纳，其阶段 1（纯协同模型）与阶段 2（个人日记服务端）已实现，阶段 3（单人写作、保存、离线恢复与本人历史）已实现，首页列出本人日记卡片，关系管理与共享范围配置已实现，阶段 4（共享）进行中：服务端已能按范围开放与冻结日记，在空间页确认范围即开放，搭档在首页看到共享日记并能读写本人文字、看作者颜色、写入时间与对方光标；阶段 2（未读与日期页）已实现，真实输入法与剪贴板手动验证推到发布前：首页按日期列出两人的日记，用首字头像标出谁写了，有未读时亮圆点；日记里能跳到未读，对方修改时阅读位置不被推走；同一天两人的日记在日期页上下排列、都能直接写；阶段 3（服务器备份与 Google 可读副本）进行中：服务器备份已在生产启用（2026-11-07 首次备份与演练通过）；连接 Google Drive、每天一份可读 Doc、被改被删的处理与各种失败提示已实现并合并，真实 Google 账号已连通，其余手动验证推到发布前；双人空间功能进行中：共用规则已实现，第一批四个功能（两地时间、心愿与送礼、见面计划、纪念日）的设计已采纳，两地时间已实现：首页显示对方当地的时间、昼夜与"大概在睡"，两地时间页列出今天两人都醒着的时段；心愿与送礼已实现：两人的心愿单带链接预览和 1～5 颗心，送的人可以悄悄准备礼物、写卡片，揭晓前对方完全看不到，揭晓后进礼物墙，首页入口有未读圆点；纪念日已实现：生日、在一起的日子与其他纪念日按对方那边的日期倒数（自己的生日按自己的），各自设提前几天提醒，首页小条在最后一天倒数小时，可数第 N 天，礼物可以记为某个纪念日送的，纪念日页回看历年这一天；揭晓的礼物记在收礼人那边的日期；心愿与送礼、纪念日的手动验证待做；见面计划尚未实现，排在书页前端改版之后；书页前端改版已实现（2026-11-01），浏览器验收已通过，Ray 的手动验收待做（[清单](./docs/validation/book-frontend-manual-2026-11-01.md)）：`/days` 能从新到旧连续读两人的日记全文、跳到任意日期，右页上下两个圆形按钮直接跳到更新或更早的未读，宽窗口在左页写所选的一天、右页留着列表，窄窗口单页往返；数字书页与轻拟物双窗的[设计](./docs/design/2026-11-03-digital-paper/README.md)已采纳，实现进行中：各页顶部一条导航（此刻、日记、一起、设置）取代了「目录」书签，主页换成双窗与圆团子、最近的日期（不露正文）和两地时间；日记页改为左侧日期索引加一个主区，在「连续读」所有日记与「这一天」双人日期页之间切换，往返回到原来的阅读位置；两地时间、纪念日、心愿、空间、备份、登录与邀请页，以及日记里的编辑器、保存状态、历史与草稿，都已换成新样式；主页的两个团子可以戳和摸，对方打开主页时看到，对方的团子只按作息睡觉（[设计](./docs/adr/2026-11-03-window-mascots.md)）；已于 2026-11-07 上线到 `missu.ruihaozhang.com`（[ADR](./docs/adr/2026-11-05-production-deployment.md)），真实 Google 登录、绑定、共写与 Drive 连接已验证，cookie 与空闲 WebSocket 的手动检查列入阶段 4；各项进度只记在[开发路线](./docs/roadmap.md)。

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
