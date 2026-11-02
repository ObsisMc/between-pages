# Book assets

What every book page shares ([book-surface](../../../../docs/adr/2026-11-02-book-surface.md) D2, D3). The book's geometry, page stacks, fold and shadow are inline SVG in [BookSurface.tsx](../../src/book/BookSurface.tsx), without a book or paper bitmap; the opening's watercolor windows are in [public/home](../home/README.md).

| File | Purpose | Source |
| --- | --- | --- |
| `paper-grain.svg` | A cached 128px procedural texture tile under every page | Local SVG code; the noise filter runs on the tile, not across the book |
| `mascots.svg` | The pair of rounded, asymmetric mascots (brand, contents group titles, home clocks) | Local SVG artwork; one mascot's outline is also the inline avatar in `src/avatar` |
| `leaf.svg` | The leaf on the 「目录」 bookmark | Local SVG artwork |
| `fonts/noto-serif-sc-*.woff2` | Noto Serif SC, weights 400–700, in 101 slices by Unicode range | Google Fonts, downloaded once with its CSS for `Noto Serif SC:wght@400..700`; `@font-face` rules in [fonts.css](../../src/book/fonts.css); [OFL license](OFL.txt) |

The font slices total about 6 MiB in the repository; a browser fetches only the slices holding characters a page shows, so a page of Chinese text loads a few hundred KiB once. Fonts and images are served locally and call no font or image service at runtime.
