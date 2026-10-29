# Google 可读副本真实账号手动验证

日期：2026-10-29 写好清单。**状态：未执行，等 Ray 配好 Google Cloud 后执行。** 本文是[服务器备份与 Google 可读副本 ADR](../adr/2026-10-28-server-backup-and-google-docs.md)落地顺序第 3、4 步要求的真实 Google 验证：自动测试用的是本地模拟的 Drive/Docs 服务，这里用两个真实 Google 账号各做一遍。执行人把每格填成"通过"或"未通过：现象"；有未通过时先修复。项目进度只见[开发路线](../roadmap.md)。

已由自动测试覆盖、这里不再重复的：只在历史版本形成后写、内容不变不写、对方未共享的日记和停止共享后的私人修改不进入 Drive、Google 不可用时照常保存并自动重试、需要重新连接与空间已满的提示（`apps/api/src/app.copy.db.test.ts`）。

## 准备

1. 照 [apps/api/README.md](../../apps/api/README.md#setting-up-google-drive-ray) 的 "Setting up Google Drive (Ray)" 配好 Google Cloud 与 `.env`。
2. `npm run db:up`，`npm run dev:oidc`、`npm run dev:api`、`npm run dev:web`、`npm run dev:worker` 各开一个终端。
3. 两个浏览器窗口分别用"开发登录"登录 A、B；A 生成邀请，B 接受；A 的范围为默认的全部日期。
4. A、B 各自在"备份"页连接自己的 Google 账号（两个都要在 Google Cloud 的测试用户里）。

## 清单

| # | 验收 | 步骤 | 预期 | 结果 |
| --- | --- | --- | --- | --- |
| 1 | GOOGLE-03、12 | A 写今天两三行，停笔 2 分钟以上，记下停笔时间 | 停笔 2 分钟形成历史版本后约 60 秒内（记下实际耗时），A 的 Drive 出现 `Between Pages/年/月/YYYY-MM-DD 周X`；打开是日期标题、图例、"A 的日记"和正文，A 的字用 A 的颜色；大纲里能跳到各个标题 | 未执行 |
| 2 | GOOGLE-04 | 第 1 步后看 B 的 Drive | B 的 Drive 有同名 Doc，A 的日记在下面（B 自己没写这天时只有 A 那篇） | 未执行 |
| 3 | GOOGLE-03 | B 在 A 那篇插一句，停笔 2 分钟 | 两人的 Doc 都更新，B 插的那句用 B 的颜色；Google Docs 的版本历史里多一个版本 | 未执行 |
| 4 | GOOGLE-06 | A 打开日期页和单篇日记页 | "已保存"旁显示"已备份到 Google 时间"和"在 Google Docs 打开"，链接打开的是这一天的 Doc | 未执行 |
| 5 | GOOGLE-03 | A 写几个字马上点备份页的"现在备份" | 约 10 秒内 Doc 就更新，不用等 2 分钟 | 未执行 |
| 6 | GOOGLE-04 | A 在空间页把范围改成不含今天，再在今天写一句私人的话，停笔 2 分钟 | B 的 Doc 底部出现"（已停止共享）"，没有那句私人的话；A 自己的 Doc 有 | 未执行 |
| 7 | GOOGLE-08 | 在 Google Docs 里手改 A 的 Doc，然后 A 在应用里再写一句 | 手改的 Doc 内容不被覆盖，它被改名为"…（在 Google 改过，已停止更新）"，新建一份同名 Doc 继续更新，备份页有记录 | 未执行 |
| 8 | GOOGLE-08 | 把 A 的某天 Doc 放进回收站，再写那天；另一天的 Doc 放进回收站后重启后台进程（启动时做每日检查） | 两天都各重新生成一份，回收站里的旧 Doc 还在，备份页有记录 | 未执行 |
| 9 | GOOGLE-01、09 | A 在备份页点"断开连接" | 显示"正在断开"，几秒后变成"未开启 Google 备份"；Google 账号的"第三方访问"里不再有 Between Pages；Drive 文件都在 | 未执行 |
| 10 | GOOGLE-02 | 断开期间 A 写几句，然后重新连接同一个账号 | 积压的日期续传到原来的 Doc，没有重复的 Doc | 未执行 |
| 11 | GOOGLE-02 | A 关掉自己所有的应用页面，B 的窗口留着；B 在 A 那篇写一句，停笔 2 分钟 | A 的 Doc 照样更新 | 未执行 |
