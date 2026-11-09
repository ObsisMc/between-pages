import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// Renders public/favicon.svg into the raster icons beside it with Playwright's Chromium, the
// browser the e2e suite already installs, so no image library is needed. Run after changing
// the SVG: `npm run icons -w @between-pages/web`. The outputs are committed.
//
// The tab icon stays transparent. The home-screen icons get the paper colour behind them:
// iOS paints transparent areas of an apple-touch-icon black, and Android launchers show the
// manifest icons on their own shapes.

const PAPER = '#fbf7f0';
const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const RASTERS: { file: string; size: number; background: string | null }[] = [
  { file: 'apple-touch-icon.png', size: 180, background: PAPER },
  { file: 'icon-192.png', size: 192, background: PAPER },
  { file: 'icon-512.png', size: 512, background: PAPER },
];
const ICO_SIZE = 32;

/** One PNG wrapped in an ICO container (a PNG entry is valid since Windows Vista). */
function ico(png: Buffer, size: number): Buffer {
  const header = Buffer.alloc(6 + 16);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  header.writeUInt8(size, 6);
  header.writeUInt8(size, 7);
  header.writeUInt8(0, 8); // palette: none
  header.writeUInt8(0, 9); // reserved
  header.writeUInt16LE(1, 10); // colour planes
  header.writeUInt16LE(32, 12); // bits per pixel
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(header.length, 18);
  return Buffer.concat([header, png]);
}

const svg = await readFile(join(publicDir, 'favicon.svg'), 'utf8');
const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const render = async (size: number, background: string | null) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<body style="margin:0;background:${background ?? 'transparent'}">
         <img src="${src}" width="${size}" height="${size}" style="display:block" />
       </body>`,
    );
    await page.waitForFunction(() => document.querySelector('img')?.complete);
    return page.screenshot({ type: 'png', omitBackground: background === null });
  };
  for (const { file, size, background } of RASTERS) {
    await writeFile(join(publicDir, file), await render(size, background));
  }
  await writeFile(join(publicDir, 'favicon.ico'), ico(await render(ICO_SIZE, null), ICO_SIZE));
} finally {
  await browser.close();
}
