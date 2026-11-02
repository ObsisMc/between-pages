# 主页原稿复现验证（2026-11-02）

本次为独立分支 `codex/home-reference-reproduction` 的主页视觉试验，起点是用户指出的 worktree 的 `03ce646`。该 worktree 与 `pr49-on-60` 分支未修改。原稿：[桌面](../adr/assets/opening-book-home-desktop.png)、[窄窗口](../adr/assets/opening-book-home-narrow.png)。

## 最终实现边界

按 Ray 本次确认，书本轮廓、页边、书脊和阴影为 [HomeBookSurface.tsx](../../apps/web/src/pages/HomeBookSurface.tsx) 的内联 SVG 与 [home.css](../../apps/web/src/pages/home.css)，没有整本书的位图背景。纸张使用本地 128px 过程式 SVG 纹理块，避免整页噪声滤镜；静态桌面书页单独合成。只有水彩窗台使用 WebP 插画，来源与实际生成提示词见 [素材说明](../../apps/web/public/home/README.md)。全部文字、日期、时钟、时间轴与控件仍为真实 HTML。

宽窗口为展开的双页，896px 及以下为纵向单页。双人空间入口收在页脚；未绑定与解绑后的邀请保持可用。日记工作区与服务端不在本次修改范围。

## 自动验证

- Node 26，`npm ci` 安装现有锁定依赖；未新增依赖。
- `npm run format`、`npm run format:check`、`npm run lint`、`npm run typecheck`、`npm run build`、`npm run check -- docs`。
- 相关组件：`npx vitest run --project web apps/web/src/pages/HomePage.test.tsx apps/web/src/two-clocks/two-clocks.test.tsx apps/web/src/book/book.test.tsx apps/web/src/pages/SiteContents.test.tsx`，33 项通过。
- 原有 `e2e/book.spec.ts` 在真实一次性 PostgreSQL、Chromium 与 WebKit 下完整跑过，22 项通过；书本改为 SVG 后，对主页、目录、不同关系状态以及桌面/375px/320px 的相关项目单独复验。
- 最终稳定源码复验：10 项通过（3.6 分钟）：`bash scripts/with-test-postgres.sh npx playwright test e2e/book.spec.ts --project=chromium --project=webkit --workers=1 --grep 'wide:|one sheet|home shows no diary text|home and 目录 per relationship'`。
- 用合约形状的合成网络数据另查两种浏览器的 1536、1280、375、320px、DPR 2：未绑定/绑定、目录打开与 Escape、无横向溢出、不请求日记正文，以及系统深色主题下的主页可读性。截图中的时间、日期和账号是演示值，产品本身没有固定这些值。

未为静态样式或 SVG 数值编写镜像测试；使用原有几何边界和真实操作测试。未修改断言、重试或超时。

排查中发现并修复过插画在窄书页超出几像素的问题。一次在浏览器测试运行中编辑源码，触发 Vite 热更新失败，随后一个 WebKit 登录检查停在“正在打开…”；最终复验在源码稳定后单独执行。组件测试也观察过一次既有目录返回焦点的竞争，相关目录逻辑未改，后续 33 项通过，未增加重试。

## 帧响应诊断

这是当前执行机的无头浏览器、本地生产构建、合成 API、1536×1024、DPR 2 下的三次诊断，不能替代真实 Safari/手机或跨国网络验收。

通过同一页面的 `performance.now()` 分开记录：点击目录 → MutationObserver 看到目录 DOM → 第一帧回调 → 第二帧回调。两次帧回调之间的时间包括浏览器帧调度与渲染，不能仅凭它区分 CPU 绘制、GPU 合成或执行机负载。

| 引擎 | 主页可见 | 点击至第二帧（3 次） | 目录 DOM 更新（3 次） |
| --- | --- | --- | --- |
| Chromium | 650ms | 219 / 27 / 42ms | 145 / 12 / 5ms |
| WebKit | 1051ms | 1492 / 982 / 569ms | 129 / 16 / 8ms |

WebKit 的主要延迟位于 DOM 更新后的帧阶段，仍明显慢于 Chromium；不能宣称视觉复杂度没有代价，也不能把这个延迟归因于等待接口。该限制仍保留。初始 SVG 纸纹由大量细线组成，已经改为缓存的小块 SVG 纹理；提高合成层隔离后后续帧有改善，但不是所有真实设备的性能保证。

## 截图

- [Chromium 桌面双页](artifacts/home-reproduction/desktop.png)
- [Chromium 窄窗口整页](artifacts/home-reproduction/narrow.png)
- [WebKit 桌面双页](artifacts/home-reproduction/webkit-desktop.png)

## 待人工确认

- Ray 对照原稿确认纸张、书脊、插画、字体与比例。
- 真实 Safari、手机浏览器与慢网络的响应和加载体验；本轮未做。
- 构建仍提示全站 JS 包超过 500KB；拆分现有全站包不在本次主页复现范围。

本轮未运行完整 CI 矩阵与全仓库覆盖率门槛；运行范围为本记录列出的相关组件、主页浏览器验收和静态检查。

## 小角色轮廓修正

Ray 指出品牌与时钟旁的小头像呈圆台形后，将 SVG 的收窄顶部、近乎平直的底部改为饱满且不完全对称的连续曲线，同时减弱底部渐变，避免硬质立体感。窗口里的水彩角色未改。构建通过，Chromium 桌面/窄屏与 WebKit 桌面截图已更新，无页面脚本错误；这是静态 SVG 外观修正，未增加镜像测试或重复整套 e2e。[放大效果](artifacts/home-reproduction/mascots-detail.png)。
