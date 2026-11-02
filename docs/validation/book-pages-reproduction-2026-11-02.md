# 所有书页的书本外观与「目录」跨页验证（2026-11-02）

实现 [book-surface](../adr/2026-11-02-book-surface.md) 与 [contents-spread](../adr/2026-11-02-contents-spread.md)：主页复现的 SVG 书本、纸纹、Noto Serif SC 与小角色头像用于所有书页，「目录」改为盖在当前页上的整页跨页。分支 `claude/book-pages-reproduction-3a64b6`，起点为 Codex 的主页复现（`ee31de8`，带在同一 PR 中）。

## 范围

| 页面 | 宽窗口 | 窄窗口 |
| --- | --- | --- |
| 主页 `/` | 3∶2 的书（Codex 的复现，改用共享表面与字体） | 单页 |
| 所有日记 `/days`、`/days/:date` | 窗口高的书，左页写、右页列表，各自滚动 | 单页列表、单页日期 |
| 目录 | 盖在当前页上的跨页：左页日记与管理，右页一起 | 单页：日记、一起、管理 |
| 两地时间、心愿与礼物、纪念日、一个纪念日、双人空间、备份、Google 回调 | 窗口高的书，按 book-surface D5 分到左右页 | 单页，先左后右 |
| 登录、邀请 | 左页开篇（品牌、短句、水彩窗台），右页表单 | 单页 |
| 旧链接 `/diaries/*` | 左页日记（页内滚动），右页「在所有日记中打开这一天」 | 单页 |

## 自动验证

本机，Node 26，`npm ci` 后，未新增 npm 依赖。字体切片取自 Google Fonts，经 Ray 同意。

- `npm run format:check`、`npm run lint`、`npm run typecheck`、`npm run check -- docs`：通过。
- `npx vitest run --project checks`：22 项通过（依赖方向规则加了 `book`，经 Ray 同意）。
- `npx vitest run --project web`：295 项中 294 项通过。`DiaryPage.test.tsx` 的「says saved to the server only once the batch is acknowledged」在多个测试文件并行时偶尔失败：打开日记 1 秒内没等到「已保存到服务器」。单独跑能通过；在未改动的基线 `ee31de8` 上同样三次失败一次，所以不是这次引入的，也没有为它加超时或重试。
- 浏览器测试，真实 API 与一次性 PostgreSQL：
  - `e2e/book.spec.ts` 在 Chromium、WebKit 下 24 项全部通过（8.1 分钟）。
  - 第一次全套运行（`npm run test:e2e:db`，Chromium、WebKit，默认并行）：69 项通过，13 项失败。其中两处是这次的问题，已修复：
    - 左页的「↓ 下面有新内容」盖住了「下一处未读」：提示的位置是相对按钮组的，改动时被移到了按钮上；
    - 书页测试在目录打开时取到了被隐藏的原页。
  - 「选一天后列表不动」在 1280×720 下必然失败：新书页的纸边让列表框变矮，要点的日期跑到了视野外，Playwright 先滚动列表才能点到，这是用户的滚动，不是页面丢了位置。测试改为选视野内的两天，原意不变；`workspace.spec.ts` 在两种引擎下 6 项全部通过。
  - 其余失败多为 WebKit 在并行负载下超时。单进程重跑 8 个文件，WebKit 20 项中 19 项通过。
  - 唯一没有稳定通过的是 `anniversaries.spec.ts`。它的步骤全部完成，只是超出 30 秒预算：

    | 引擎 | 基线 | 本分支 |
    | --- | --- | --- |
    | Chromium | 17.1 秒 | 22.2 秒 |
    | WebKit | 23.6 秒 | 29.2 秒（一次 30.1 秒，失败） |

    这正是 Ray 延后处理的速度问题，没有提高超时。
- 未运行：Firefox（CI 才跑），`npm run test:db` 中的 API 与数据库测试（本次未改服务端），覆盖率门槛。

## 帧响应

本机无头浏览器，1536×1024，像素密度 2，开发服务器，演示数据。方法同主页复现记录：从点击书签起，记 MutationObserver 看到目录 DOM 的时间和第二帧回调的时间，每页 3 次，单位毫秒（DOM / 第二帧）。

| 页面 | Chromium | WebKit |
| --- | --- | --- |
| `/` | 50/104 · 31/57 · 36/62 | 40/879 · 76/1312 · 19/645 |
| `/days` | 58/69 · 34/53 · 52/79 | 139/1547 · 56/680 · 53/749 |
| `/days/:date` | 51/70 · 53/69 · 70/81 | 76/748 · 137/1347 · 48/778 |
| `/wishes` | 97/165 · 38/63 · 38/66 | 26/666 · 32/1327 · 24/706 |

WebKit 的目录 DOM 在 0.14 秒内就更新好了，到第二帧却要 0.65–1.55 秒，与主页复现时的 0.57–1.49 秒同一量级，现在每一页都是这样。按 Ray 的决定，本轮不优化。

## 截图

Chromium，1280×800 与 375×740，像素密度 1；用的是本机开发数据，截图中的名字、日期与日记均为演示内容。

- 宽窗口：[主页](artifacts/book-pages/chromium-wide-home.webp)、[所有日记](artifacts/book-pages/chromium-wide-days.webp)、[左页打开一天](artifacts/book-pages/chromium-wide-day.webp)、[目录](artifacts/book-pages/chromium-wide-contents.webp)、[心愿与礼物](artifacts/book-pages/chromium-wide-wishes.webp)、[两地时间](artifacts/book-pages/chromium-wide-clocks.webp)、[双人空间](artifacts/book-pages/chromium-wide-space.webp)、[登录](artifacts/book-pages/chromium-wide-login.webp)
- 窄窗口：[主页](artifacts/book-pages/chromium-narrow-home.webp)、[一天](artifacts/book-pages/chromium-narrow-day.webp)、[目录](artifacts/book-pages/chromium-narrow-contents.webp)、[心愿与礼物](artifacts/book-pages/chromium-narrow-wishes.webp)
- WebKit 宽窗口：[左页打开一天](artifacts/book-pages/webkit-wide-day.webp)、[目录](artifacts/book-pages/webkit-wide-contents.webp)

这台机器没有中文衬线字，截图里的字全部来自随项目提供的 Noto Serif SC。

## 未做与待确认

- Ray 对照参考稿确认各页的纸面、字体、头像与比例。
- 真实 Safari、手机浏览器与慢网络；本轮只在本机无头浏览器里看过。
- 性能按 Ray 的决定不优化，帧时间只记录。
- WebKit 下 `anniversaries.spec.ts` 接近或超出 30 秒预算，见上文；怎么处理（性能优化、拆分测试或调整预算）由 Ray 决定。
