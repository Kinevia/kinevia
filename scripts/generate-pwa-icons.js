#!/usr/bin/env node
/**
 * Generate PWA icons for Kinévia
 * Uses sharp to convert SVG → PNG at 192x192 and 512x512
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

// SVG icon: gradient background (turquoise blue), rounded corners, white K
function buildSvg(size) {
  const radius = Math.round(size * 0.2);
  const fontSize = Math.round(size * 0.52);
  const textY = Math.round(size * 0.72);
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1DADE4"/>
      <stop offset="100%" stop-color="#0E7FA8"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${radius}" fill="url(#g)"/>
  <text x="${size / 2}" y="${textY}" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="800" fill="white" text-anchor="middle">K</text>
</svg>`;
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const sizes = [192, 512];

Promise.all(sizes.map(size => {
  const svg = Buffer.from(buildSvg(size));
  const outPath = path.join(outDir, `icon-${size}.png`);
  return sharp(svg)
    .png()
    .toFile(outPath)
    .then(() => console.log(`✅ Generated ${outPath}`));
})).catch(err => {
  console.error('Error generating icons:', err);
  process.exit(1);
});
