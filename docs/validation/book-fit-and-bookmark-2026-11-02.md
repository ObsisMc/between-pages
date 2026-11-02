# 主页的书放进窗口、书签画在书上、加载时也是书：验证（2026-11-02）

实现 [book-fit-and-bookmark](../adr/2026-11-02-book-fit-and-bookmark.md)，修正 Ray 在 2026-11-02 试用 [book-surface](../adr/2026-11-02-book-surface.md) 与 [contents-spread](../adr/2026-11-02-contents-spread.md) 时发现的三个问题。分支 `claude/book-fit-bookmark-bd31ef`，基于 PR #61 的 `claude/book-pages-reproduction-3a64b6`（`df5eb41`）。

## 修正前后

Chromium，1440×800，像素密度 1，本机一次性数据库里的两个演示账号（上海与纽约，作息 23:30–7:00）。「修正前」是 `df5eb41` 的网页代码，「修正后」是本分支，其余相同。

| 情形 | 修正前 | 修正后 |
| --- | --- | --- |
| 主页 | [窗口内](artifacts/book-fit-and-bookmark/home-1440x800-before.webp)：书比窗口高；[整页](artifacts/book-fit-and-bookmark/home-1440x800-full-before.webp)：窗口要滚动才看到书底 | [书完整在窗口内](artifacts/book-fit-and-bookmark/home-1440x800-after.webp)，书签贴在右页外缘 |
| 拦住 `/api/me` 1.2 秒 | [纸色上一行「正在打开…」](artifacts/book-fit-and-bookmark/loading-session-before.webp)，没有书 | [书，左页「正在打开…」](artifacts/book-fit-and-bookmark/loading-session-after.webp)，没有书签 |
| 拦住双人空间的数据 1.2 秒 | [一行「正在打开…」和一条孤零零的书签](artifacts/book-fit-and-bookmark/loading-space-before.webp) | [空白的书，书签在书上](artifacts/book-fit-and-bookmark/loading-space-after.webp) |
| 375×740 主页滚到中间 | 书签固定在窗口 | [书签停在窗口顶部、仍在单页上](artifacts/book-fit-and-bookmark/home-375-scrolled-after.webp) |

目录打开时的跨页修正前后像素几乎相同，没有另存截图。

## 主页的书

| 窗口 | 修正前书的大小（协调会话实测） | 修正后 |
| --- | --- | --- |
| 1280×720 | 高 893px，窗口滚动 | 1032×688，窗口不滚动 |
| 1440×800 | 高 995px，窗口滚动 | 1152×768，窗口不滚动 |
| 1920×960 | 高 1057px，窗口滚动 | 1392×928，窗口不滚动 |

修正中发现：主页右页的滚动框会把时间线两端的「0:00」「24:00」裁掉（以前它们伸进页边）。右页的滚动框因此伸入页边 2cqw，见修正后截图。

## 自动验证

本机，Node 26，`npm ci` 后，未新增 npm 依赖。

新测试在修正前的代码上先运行过，都失败：

- `e2e/book.spec.ts`「the home book fits the window…」：1280×720 下 `scrolls: true`、`inWindow: false`（未绑定账号右页有邀请，书高到宽高比 0.94）。
- `e2e/book.spec.ts`「while the session, a page or the app itself loads…」：应用脚本被拦住时 `body` 背景是 `rgba(0, 0, 0, 0)`，不是纸色。
- `book.test.tsx` 的单一书签测试、`RequireAuth.test.tsx` 的两项：书签不在书里，「正在打开…」不在左页。

修正后：

- `npm run format:check`、`npm run lint`、`npm run typecheck`、`npm run check -- docs`：通过。
- `npx vitest run --project checks`：22 项通过（依赖方向规则让 `auth` 引用 `book`，经 Ray 同意）。
- `npx vitest run --project web`：只跑了改动涉及的 `book`、`auth`、`pages`、`space`、`join` 五个目录，50 项通过；整套 web 单元测试在改动后没有再完整跑过。
- `e2e/book.spec.ts` 单独在 Chromium 下 14 项全部通过；两项新测试单独在 Chromium、WebKit 下都通过。
- 全套浏览器测试（`npm run test:e2e:db`，Chromium、WebKit，两个 worker 并行，21.7 分钟）：88 项中 79 项通过、2 项跳过、7 项失败。7 项都是超出时间预算或等待时页面还在加载，不是断言错误：
  - `clocks.spec.ts`，Chromium 32.2 秒、WebKit 32.0 秒，超出默认 30 秒；
  - WebKit 的 `anniversaries.spec.ts`（31.4 秒，即 book-surface 记录的卡在 30 秒预算上的那一项）、`feed-unread.spec.ts`、`wishes.spec.ts`（用完它自己的 60 秒）；
  - WebKit 的 `book.spec.ts` 两项：新加的加载测试在登录这一步 5 秒内没等到 `/api/me`，还没进入它自己的步骤；「目录」保留原页那一项在工作区点书签后 5 秒内没等到目录出现。
- 按 Ray 的决定，把这 7 项以单个 worker、命令行 `--timeout=60000` 重跑（不改仓库里的配置）：7 项全部通过。
- 同样条件下比较 `clocks.spec.ts`：本分支 Chromium 18.3 秒、Firefox 22.4 秒、WebKit 27.9 秒；#61（`df5eb41`）18.7、21.4、27.3 秒，没有变慢。
- 未运行：Firefox 全套（CI 才跑），`npm run test:db`（未改服务端），覆盖率门槛。之后 Ray 决定不再跑测试，所以 `anniversaries.spec.ts` 两个版本的对比耗时没有测。
