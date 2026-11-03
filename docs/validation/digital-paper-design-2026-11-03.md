# 数字书页设计预览验证（2026-11-03）

范围为[设计包](../design/2026-11-03-digital-paper/README.md)的模拟页面与导出文件，不验证正式应用。未连接 API 或数据库，未修改 apps/、packages/、checks/、CI、依赖或冻结原型。

## 浏览器与截图

使用 Node 26.12.1、仓库已有的 Playwright，在本机无头 Chromium 与 WebKit 打开独立导出的 index.html；通过 iframe 内真实导航按钮操作。每个引擎都验证以下十页：主页、日记、心愿与礼物、两地时间、纪念日、一个纪念日、双人空间、备份、登录、邀请。

- 预览内容宽度为 1024、348、320 px，三种宽度下十页均无文档横向溢出；两个引擎均未报告 JavaScript 异常。
- 操作通过：日期切换、双人／我的视图过滤、历史展开、模拟新增心愿、准备分类、模拟新增纪念日、共享范围两步预览、备份日志、模拟登录、模拟接受邀请。
- 提交的十张桌面截图来自 Chromium 的 1024 px 预览；手机主页来自同一导出中的窄版比较视图。日记和备份状态均为虚构示例。
- [capture-results.json](../design/2026-11-03-digital-paper/capture-results.json)保存两引擎的页面、宽度与交互结果。

复跑（使用仓库已有依赖和 Playwright 浏览器）：

```sh
node docs/design/2026-11-03-digital-paper/capture.mjs
```

脚本重写截图与结果文件，需人工检查差异；它不会启动真实服务，不向真实账号写入任何内容。查看导出时需要联网加载公共预览样式与图标。

## 与业务验收的区别

模拟页面没有服务器作者保护、增量保存、IndexedDB、本机恢复、真实共享授权、Google OAuth 或后台任务。交互通过不代表这些功能已经迁移，也不证明真实账号登录、保存成功、实际分享、已读覆盖或备份成功。

Firefox、真实 Safari、实体手机、辅助技术、实际中文输入法、真实网络性能、完整应用 E2E 和数据库测试均未在本设计包验证。正式实施时按提议 ADR 的验收标准回归。

## 仓库检查

Node 26.12.1 下执行：`npm run format`、`npm run format:check`、`npm run lint`、`npm run typecheck`、`npx vitest run --project checks`（22/22）与 `npm run check -- docs` 均通过。浏览器捕获脚本也用 Node 26.12.1 复跑通过。

未运行完整覆盖率、API/数据库测试、协同原型测试及正式应用 E2E：本 PR 只保存设计材料，没有改动其生产入口或行为。正式实施的验收门槛不因这些模拟检查而降低。
