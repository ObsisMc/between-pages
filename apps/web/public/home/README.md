# Opening-page artwork

Watercolor assets for the home-page reproduction experiment (2026-11-02). Book geometry, page stacks, fold and paper grain are implemented in [HomeBookSurface.tsx](../../src/pages/HomeBookSurface.tsx) and CSS, without a book or paper bitmap. All content, clocks, timeline positions, links and controls remain live HTML; none of the reference's text is baked into the page background. The original design remains in [the homepage reference](../../../../docs/adr/assets/opening-book-home-desktop.png).

| File | Purpose | Source |
| --- | --- | --- |
| `windows-watercolor.webp` | Two windows with both mascots | Built-in imagegen, reference-guided watercolor illustration |
| `windows-unbound.webp` | Same illustration with an empty partner window | Built-in imagegen edit of the preceding illustration |
| `mascots.svg`, `leaf.svg` | Rounded, asymmetric mascots and the bookmark leaf | Local SVG artwork |
| `paper-grain.svg` | A cached 128px procedural texture tile | Local SVG code; noise filter runs on the tile, not across the book |
| `serif-sc.ttf` | Homepage label and date glyphs | Google Fonts Noto Serif SC, static text subset; [OFL license](OFL.txt) |

The selected illustration PNG originals were transcoded to WebP (quality 90), without changing their composition. The bound illustration is about 379 KiB and the unbound variant about 322 KiB. There is no raster book background or paper texture. Images and fonts are served locally and do not call an image or font service at runtime. The font subset covers fixed homepage copy; names and other text fall back to the existing font stack.

## Generation prompts

Tool: built-in `image_gen.imagegen`; no CLI/API fallback. Reference: `docs/adr/assets/opening-book-home-desktop.png`.

### Windows

Use case: illustration-story. Asset type: transparent PNG decorative illustration for the Between Pages home page. Input image is a STYLE AND COMPOSITION REFERENCE only. Generate ONLY the two windows illustration from the lower left of the reference, without the book, text, UI or background. Two charming watercolor windows side by side: left honey brown wooden frame, amber light, little hanging pendant lamp, three books and small potted plant, soft peach orange rounded blob mascot with tiny black eyes and smile sitting on sill. Right muted slate blue frame, pale blue light, pendant lamp, books and small plants, soft blue blob mascot with tiny eyes and smile. Trailing olive green vines curl around the outer sides of the windows, delicate sparse pale apricot brick marks around them, warm sunlight brushstrokes below left. Handmade watercolor on fine paper, transparent irregular washes, graphite details, tiny imperfections, low contrast, delicate storybook quality exactly like reference. Windows take about 65% of asset height, vines extend below, both equal size. Wide composition around 3:2, closely framed, minimal padding. Truly transparent background, no words, no border around whole composition, no book. Preserve quiet restrained orange/blue/olive palette.

### Empty partner window

Change ONLY the blue mascot in the right window: remove it and leave the window sill empty where it sat. Keep the left orange mascot and both windows, lamps, books, plants, vines, brick accents, watercolor texture, exact dimensions, positions, colors and everything else unchanged. Keep the transparent background and existing soft washes. No new elements.

