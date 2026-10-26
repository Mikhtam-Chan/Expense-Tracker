// make-icon.js — generates a simple 512x512 PNG launcher icon (icon.png).
// Uses sharp, which ships with hbh-web2app (also listed in devDependencies).
//
// Usage:
//   node make-icon.js           # create icon.png if missing
//   node make-icon.js --force   # overwrite an existing icon.png
//
// Drop in your own 512x512 PNG named icon.png to use that instead.
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUTPUT = path.join(__dirname, 'icon.png');
const SIZE = 512;
const force = process.argv.includes('--force');

// Adaptive icons are cropped to the inner 66% circle on most launchers, so the
// glyph is kept inside a centred disc and the outer area just carries the
// background colour. The template uses this image as the *foreground* layer
// over @color/ic_launcher_background, so a full-bleed square background here
// renders as the app colour behind a round crop.
const svg = `
<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3b82f6"/>
      <stop offset="1" stop-color="#1d4ed8"/>
    </linearGradient>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" fill="url(#bg)"/>
  <circle cx="256" cy="256" r="150" fill="#ffffff" fill-opacity="0.14"/>
  <text x="256" y="268" font-family="Segoe UI, Arial, Helvetica, sans-serif"
        font-size="260" font-weight="700" fill="#ffffff" text-anchor="middle"
        dominant-baseline="middle">$</text>
</svg>`;

async function main() {
  if (fs.existsSync(OUTPUT) && !force) {
    console.log(`[make-icon] ${OUTPUT} already exists — leaving it alone.`);
    console.log('[make-icon] Use "node make-icon.js --force" to overwrite.');
    return;
  }

  const buffer = Buffer.from(svg, 'utf8');

  await sharp(buffer)
    .resize(SIZE, SIZE, { fit: 'cover' })
    .png({ compressionLevel: 9 })
    .toFile(OUTPUT);

  const meta = await sharp(OUTPUT).metadata();
  const kb = (fs.statSync(OUTPUT).size / 1024).toFixed(1);
  console.log(
    `[make-icon] Wrote ${OUTPUT} (${meta.width}x${meta.height}, ${meta.format}, ${kb} KB)`
  );
}

main().catch((err) => {
  console.error('[make-icon] Failed:', err && err.message ? err.message : err);
  process.exit(1);
});
