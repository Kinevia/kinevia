#!/usr/bin/env node
// Generate PWA icons as PNG files for Kinévia
// Uses raw PNG generation (no external deps) - teal gradient "K" logo

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Kinévia brand colors (turquoise blue from logo)
const PRIMARY_START = { r: 0x1D, g: 0xAD, b: 0xE4 }; // #1DADE4 turquoise-light
const PRIMARY_END   = { r: 0x0E, g: 0x7F, b: 0xA8 }; // #0E7FA8 turquoise-dark
const WHITE = { r: 255, g: 255, b: 255 };

// CRC32 for PNG
function crc32(buf) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function writeUint32BE(buf, val, offset) {
  buf[offset] = (val >>> 24) & 0xFF;
  buf[offset+1] = (val >>> 16) & 0xFF;
  buf[offset+2] = (val >>> 8) & 0xFF;
  buf[offset+3] = val & 0xFF;
}

function createChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  writeUint32BE(len, data.length, 0);
  const crcData = Buffer.concat([typeBytes, data]);
  const crcVal = Buffer.alloc(4);
  writeUint32BE(crcVal, crc32(crcData), 0);
  return Buffer.concat([len, typeBytes, data, crcVal]);
}

function generatePNG(size) {
  const width = size;
  const height = size;
  const radius = size * 0.18; // rounded corners

  // Create RGBA pixel data
  const pixels = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;

      // Rounded rect background
      const cx = Math.min(x, width - 1 - x);
      const cy = Math.min(y, height - 1 - y);

      // Check if inside rounded rect
      let inBg = true;
      if (cx < radius && cy < radius) {
        const dx = radius - cx;
        const dy = radius - cy;
        if (dx*dx + dy*dy > radius*radius) inBg = false;
      }

      if (inBg) {
        // Gradient from top-left to bottom-right
        const t = (x + y) / (width + height);
        const r = Math.round(PRIMARY_START.r + t * (PRIMARY_END.r - PRIMARY_START.r));
        const g = Math.round(PRIMARY_START.g + t * (PRIMARY_END.g - PRIMARY_START.g));
        const b = Math.round(PRIMARY_START.b + t * (PRIMARY_END.b - PRIMARY_START.b));
        pixels[idx] = r;
        pixels[idx+1] = g;
        pixels[idx+2] = b;
        pixels[idx+3] = 255;
      } else {
        // Transparent
        pixels[idx] = 0;
        pixels[idx+1] = 0;
        pixels[idx+2] = 0;
        pixels[idx+3] = 0;
      }
    }
  }

  // Draw "K" letter in white
  // Center the K - use simple pixel drawing
  const kScale = size * 0.55;
  const kX = size * 0.22; // left edge of K stem
  const kY = size * 0.22; // top edge
  const stemWidth = size * 0.12;
  const stemHeight = kScale;
  const armThick = size * 0.11;

  function setWhite(px, py) {
    if (px < 0 || px >= width || py < 0 || py >= height) return;
    const idx = (Math.round(py) * width + Math.round(px)) * 4;
    if (pixels[idx+3] > 0) { // only paint on background
      pixels[idx] = WHITE.r;
      pixels[idx+1] = WHITE.g;
      pixels[idx+2] = WHITE.b;
      pixels[idx+3] = 255;
    }
  }

  // Draw vertical stem
  for (let py = kY; py < kY + stemHeight; py++) {
    for (let px = kX; px < kX + stemWidth; px++) {
      setWhite(Math.round(px), Math.round(py));
    }
  }

  // Draw upper arm (top-right diagonal)
  const midY = kY + stemHeight * 0.5;
  const rightX = kX + kScale * 0.72;

  for (let i = 0; i <= 1.0; i += 0.002) {
    // Upper arm: from (kX+stemWidth, midY) to (rightX, kY)
    const ax = kX + stemWidth + i * (rightX - kX - stemWidth);
    const ay = midY + i * (kY - midY);
    // Draw thick line
    for (let t = -armThick/2; t < armThick/2; t += 0.5) {
      const nx = -(midY - kY);
      const ny = rightX - kX - stemWidth;
      const len = Math.sqrt(nx*nx + ny*ny);
      setWhite(Math.round(ax + t * nx/len), Math.round(ay + t * ny/len));
    }
  }

  // Lower arm: from (kX+stemWidth, midY) to (rightX, kY + stemHeight)
  for (let i = 0; i <= 1.0; i += 0.002) {
    const ax = kX + stemWidth + i * (rightX - kX - stemWidth);
    const ay = midY + i * (kY + stemHeight - midY);
    for (let t = -armThick/2; t < armThick/2; t += 0.5) {
      const nx = -(kY + stemHeight - midY);
      const ny = rightX - kX - stemWidth;
      const len = Math.sqrt(nx*nx + ny*ny);
      setWhite(Math.round(ax + t * nx/len), Math.round(ay + t * ny/len));
    }
  }

  // Encode as PNG
  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  writeUint32BE(ihdr, width, 0);
  writeUint32BE(ihdr, height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // IDAT - raw image data with filter bytes
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = y * (1 + width * 4) + 1 + x * 4;
      rawData[dstIdx] = pixels[srcIdx];
      rawData[dstIdx+1] = pixels[srcIdx+1];
      rawData[dstIdx+2] = pixels[srcIdx+2];
      rawData[dstIdx+3] = pixels[srcIdx+3];
    }
  }

  const compressed = zlib.deflateSync(rawData);

  return Buffer.concat([
    sig,
    createChunk('IHDR', ihdr),
    createChunk('IDAT', compressed),
    createChunk('IEND', Buffer.alloc(0))
  ]);
}

// Generate all required sizes
const sizes = [16, 32, 72, 96, 128, 144, 152, 180, 192, 384, 512];
const outDir = path.join(__dirname, '../public/icons');

for (const size of sizes) {
  const png = generatePNG(size);
  const filename = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`;
  fs.writeFileSync(path.join(outDir, filename), png);
  console.log(`Generated ${filename} (${png.length} bytes)`);
}

// Also write icon-192 and icon-512
console.log('All icons generated!');
