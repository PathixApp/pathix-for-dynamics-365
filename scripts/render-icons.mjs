// Renders the extension's icons and store images from static/icons/icon.svg.
//
//   node scripts/render-icons.mjs
//
// Run it after changing icon.svg and commit what it writes. The build only
// copies static/, so the PNGs are committed rather than rendered at build time.
// It uses the Chromium that @playwright/test already installs for the smoke
// test, so it adds no dependency.
//
// Writes:
//   static/icons/16.png, 32.png, 48.png  toolbar and extensions page, full bleed
//   static/icons/128.png                 install dialog and store icon: 96 px of
//                                        art inside 16 px of transparent padding,
//                                        as the Chrome Web Store asks
//   store/assets/edge-logo-300.png       Edge Add-ons extension logo
//   store/assets/promo-small-440x280.png Chrome Web Store small promo tile
import { chromium } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";

const svg = await readFile("static/icons/icon.svg", "utf8");

/** The icon art at `size` px, centred in a `box` px square with transparent padding. */
function iconPage(size, box = size) {
  const art = svg.replace('width="128" height="128"', `width="${size}" height="${size}"`);
  return `<html><body style="margin:0;background:transparent;width:${box}px;height:${box}px;display:flex;align-items:center;justify-content:center">${art}</body></html>`;
}

const PROMO = `<html><body style="margin:0;width:440px;height:280px;background:#11161c;display:flex;align-items:center;gap:28px;padding:0 32px;box-sizing:border-box;font-family:'Segoe UI',system-ui,sans-serif">
${svg.replace('width="128" height="128"', 'width="132" height="132"')}
<div><div style="color:#ffffff;font-size:27px;font-weight:600;line-height:1.2">What fires on<br>this field?</div>
<div style="color:#b5bcc4;font-size:15px;margin-top:12px">Pathix for Dynamics 365</div></div>
</body></html>`;

const outputs = [
  { file: "static/icons/16.png", html: iconPage(16), width: 16, height: 16 },
  { file: "static/icons/32.png", html: iconPage(32), width: 32, height: 32 },
  { file: "static/icons/48.png", html: iconPage(48), width: 48, height: 48 },
  { file: "static/icons/128.png", html: iconPage(96, 128), width: 128, height: 128 },
  { file: "store/assets/edge-logo-300.png", html: iconPage(300), width: 300, height: 300 },
  { file: "store/assets/promo-small-440x280.png", html: PROMO, width: 440, height: 280 },
];

await mkdir("store/assets", { recursive: true });
const browser = await chromium.launch();
try {
  for (const { file, html, width, height } of outputs) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(html);
    await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width, height } });
    await page.close();
    console.log(`${file} ${width}x${height}`);
  }
} finally {
  await browser.close();
}
