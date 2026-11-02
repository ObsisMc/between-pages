# Opening-page artwork

The watercolor windows of the opening's left page (home, login and invitation), drawn by `<BookOpening>` in [src/book](../../src/book/Opening.tsx). The book itself, its paper grain, the mascots, the bookmark leaf and the type are shared by every page and live in [public/book](../book/README.md). All content, clocks, links and controls remain live HTML; none of the reference's text is baked into an image. The original design remains in [the homepage reference](../../../../docs/adr/assets/opening-book-home-desktop.png).

| File | Purpose | Source |
| --- | --- | --- |
| `windows-watercolor.webp` | Two windows with both mascots | Built-in imagegen, reference-guided watercolor illustration |
| `windows-unbound.webp` | Same illustration with an empty partner window | Built-in imagegen edit of the preceding illustration |

The selected illustration PNG originals were transcoded to WebP (quality 90), without changing their composition. The bound illustration is about 379 KiB and the unbound variant about 322 KiB. Images are served locally and call no image service at runtime.

## Generation prompts

Tool: built-in `image_gen.imagegen`; no CLI/API fallback. Reference: `docs/adr/assets/opening-book-home-desktop.png`.

### Windows

Use case: illustration-story. Asset type: transparent PNG decorative illustration for the Between Pages home page. Input image is a STYLE AND COMPOSITION REFERENCE only. Generate ONLY the two windows illustration from the lower left of the reference, without the book, text, UI or background. Two charming watercolor windows side by side: left honey brown wooden frame, amber light, little hanging pendant lamp, three books and small potted plant, soft peach orange rounded blob mascot with tiny black eyes and smile sitting on sill. Right muted slate blue frame, pale blue light, pendant lamp, books and small plants, soft blue blob mascot with tiny eyes and smile. Trailing olive green vines curl around the outer sides of the windows, delicate sparse pale apricot brick marks around them, warm sunlight brushstrokes below left. Handmade watercolor on fine paper, transparent irregular washes, graphite details, tiny imperfections, low contrast, delicate storybook quality exactly like reference. Windows take about 65% of asset height, vines extend below, both equal size. Wide composition around 3:2, closely framed, minimal padding. Truly transparent background, no words, no border around whole composition, no book. Preserve quiet restrained orange/blue/olive palette.

### Empty partner window

Change ONLY the blue mascot in the right window: remove it and leave the window sill empty where it sat. Keep the left orange mascot and both windows, lamps, books, plants, vines, brick accents, watercolor texture, exact dimensions, positions, colors and everything else unchanged. Keep the transparent background and existing soft washes. No new elements.

