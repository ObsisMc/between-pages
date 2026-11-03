# 前端视觉探索归档（2026-10-30—31）

这里保存本轮讨论产生的 **40 张示意图**、**19 份早期 HTML 原型及预览文件**，以及用户提供的 **3 张参考／标注图**。生成图片按顺序编号，统一转为高质量 WebP 以减小仓库体积；原文件名见 [来源清单](./source-manifest.tsv)。可在 [图片总览](./gallery.html) 中连续查看。

这些是视觉探索资料，不是像素规范，也不表示每张图都已被采纳。图中的日记内容、时间、日期、城市、按钮文案和人物形状均为示例。产品决定以规格、ADR 及后续确认的交互设计为准。

## 当前可继续讨论的参考

| 内容 | 示意图 | 状态 |
| --- | --- | --- |
| 首页桌面双页与窄窗口单页 | [桌面](../../adr/assets/opening-book-home-desktop.png) · [窄窗口](../../adr/assets/opening-book-home-narrow.png) | 方向已写入 [首页 ADR](../../adr/2026-10-31-opening-book-home.md)；这两张原图已在 ADR 中保存 |
| 日记工作区：桌面左页编辑、右页连续列表 | [第 30 张](./images/30.webp) | 讨论中的视觉方向；列表须在书页内滚动和渐隐，头像尺寸统一 |
| 日记工作区：手机列表与单页编辑 | [第 31 张](./images/31.webp) | 讨论中的视觉方向；手机支持尚未进入当前实现范围 |
| 两地时间详情页探索 | [第 32 张](./images/32.webp) · [第 34 张](./images/34.webp) | 已讨论暂缓独立详情页；主页直接呈现时间与共同醒着的时段 |
| 目录：桌面双页、手机单页 | [桌面分组稿](./images/39.webp) · [手机分组稿](./images/40.webp) | 新提案，未确认；早期版本也保存在第 35–38 张 |

## 完整探索顺序

| 编号 | 主题 | 说明 |
| --- | --- | --- |
| [01–05](./gallery.html#early) | 早期页面方向 | 包括初版日记、现代编辑页、数字书页等；保留作比较资料 |
| [06–15](./gallery.html#characters) | 双人小角色 | 从较具象、复杂的尝试走向简单、软乎乎、可形变的角色；尚未定稿 |
| [16–18](./gallery.html#home) | 展开的书本首页 | 桌面与手机探索；现行首页参考原图另存于 ADR |
| [19–31](./gallery.html#diary) | 今天的日记与所有日记 | 包括被指出的跨中缝、空间浪费、图标尺寸不一和内容溢出等迭代；30、31 是较接近当前讨论的版本 |
| [32–34](./gallery.html#clocks) | 两地时间详情 | 桌面和手机示意；独立页面尚未定为开发目标 |
| [35–40](./gallery.html#catalog) | 目录 | 桌面和手机各有初稿、修订稿与分组稿；书签、导航层级和条目显示仍待确认 |

## 早期 HTML 原型

[原型文件目录](./prototypes/)保留了首页线框、现代编辑页、数字书页、隐私首页与日记流的 HTML 及当时的预览文件。可直接打开主文件：

- [首页线框](./prototypes/between-pages-home-wireframes.html)
- [现代编辑页](./prototypes/between-pages-editorial-prototype.html)
- [数字书页](./prototypes/between-pages-digital-book-prototype.html)
- [隐私首页与日记流](./prototypes/between-pages-privacy-and-stream.html)
- [首页概念比较](./prototypes/between-pages-home-concepts.html)

这些 HTML 是早期探索，不连接当前产品数据；其中部分字体由 Google Fonts 加载，离线打开时会回退到本机字体。

## 用户提供的参考与反馈

- [初始风格参考合集](./references/initial-visual-gallery.jpg)
- [书本中缝处文字跨页的标注](./references/gutter-feedback.webp)
- [头像尺寸和列表溢出的标注](./references/layout-feedback.webp)

这三张是用户提供的讨论材料，和上面的生成示意图区分保存。
