#!/usr/bin/env node
/**
 * Generate all PWA icons from the actual Kinévia logo source image.
 * Uses sharp to resize the JPEG logo to all required icon sizes.
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const SOURCE = path.join(__dirname, '..', 'public', 'icons', 'kinevia-logo-source.jpeg');
const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

// All required sizes for PWA + favicon
const ICON_SIZES = [16, 32, 72, 96, 128, 144, 152, 192, 384, 512];
const APPLE_TOUCH_SIZE = 180;

async function generateIcons() {
  // Ensure source exists
  if (!fs.existsSync(SOURCE)) {
    console.error('Source logo not found at', SOURCE);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Generate all standard icon sizes
  for (const size of ICON_SIZES) {
    const outPath = path.join(OUT_DIR, `icon-${size}.png`);
    await sharp(SOURCE)
      .resize(size, size, { fit: 'cover', position: 'centre' })
      .png()
      .toFile(outPath);
    console.log(`Generated icon-${size}.png`);
  }

  // Generate apple-touch-icon (180x180)
  const applePath = path.join(OUT_DIR, 'apple-touch-icon.png');
  await sharp(SOURCE)
    .resize(APPLE_TOUCH_SIZE, APPLE_TOUCH_SIZE, { fit: 'cover', position: 'centre' })
    .png()
    .toFile(applePath);
  console.log(`Generated apple-touch-icon.png (${APPLE_TOUCH_SIZE}x${APPLE_TOUCH_SIZE})`);

  // Generate maskable icon variants (with padding for safe zone)
  // Maskable icons need at least 10% padding on each side (safe zone is 80% center)
  for (const size of [192, 512]) {
    const outPath = path.join(OUT_DIR, `icon-${size}-maskable.png`);
    const padding = Math.round(size * 0.1);
    const innerSize = size - (padding * 2);

    // Create a teal background matching the logo, with the logo centered and padded
    const resizedLogo = await sharp(SOURCE)
      .resize(innerSize, innerSize, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer();

    await sharp({
      create: {
        width: size,
        height: size,
        channels: 4,
        background: '#0E7FA8' // turquoise from updated logo background
      }
    })
      .composite([{
        input: resizedLogo,
        top: padding,
        left: padding
      }])
      .png()
      .toFile(outPath);
    console.log(`Generated icon-${size}-maskable.png`);
  }

  // Generate favicon.ico from 32x32 PNG
  const favicon32 = path.join(OUT_DIR, 'icon-32.png');
  const faviconDest = path.join(OUT_DIR, '..', 'favicon.png');
  fs.copyFileSync(favicon32, faviconDest);
  console.log('Generated favicon.png (32x32)');

  console.log('\nAll icons generated from source logo!');
}

generateIcons().catch(err => {
  console.error('Error generating icons:', err);
  process.exit(1);
});
