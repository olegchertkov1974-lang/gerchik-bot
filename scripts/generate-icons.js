/**
 * Generate PNG icons from raw pixel data.
 * Creates minimal valid PNG files without external dependencies.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPNG(width, height, drawFn) {
  const pixels = Buffer.alloc(width * height * 4);
  drawFn(pixels, width, height);

  // Build raw data with filter byte per row
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // no filter
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressed = zlib.deflateSync(raw);

  function crc32(buf) {
    let crc = 0xffffffff;
    const table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeData = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeData));
    return Buffer.concat([len, typeData, crc]);
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function setPixel(pixels, width, x, y, r, g, b, a) {
  if (x < 0 || x >= width || y < 0) return;
  const i = (y * width + x) * 4;
  if (i + 3 >= pixels.length) return;
  if (a < 255 && pixels[i + 3] > 0) {
    const srcA = a / 255, dstA = pixels[i + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    pixels[i] = Math.round((r * srcA + pixels[i] * dstA * (1 - srcA)) / outA);
    pixels[i + 1] = Math.round((g * srcA + pixels[i + 1] * dstA * (1 - srcA)) / outA);
    pixels[i + 2] = Math.round((b * srcA + pixels[i + 2] * dstA * (1 - srcA)) / outA);
    pixels[i + 3] = Math.round(outA * 255);
  } else {
    pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = a;
  }
}

function fillCircle(pixels, width, height, cx, cy, radius, r, g, b, a) {
  const r2 = radius * radius;
  for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(height - 1, Math.ceil(cy + radius)); y++) {
    for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(width - 1, Math.ceil(cx + radius)); x++) {
      const dx = x - cx, dy = y - cy;
      const dist2 = dx * dx + dy * dy;
      if (dist2 <= r2) {
        const edge = Math.max(0, Math.min(1, radius - Math.sqrt(dist2)));
        setPixel(pixels, width, x, y, r, g, b, Math.round(a * edge));
      }
    }
  }
}

function fillRoundedRect(pixels, width, height, rx, ry, rw, rh, rad, r, g, b, a) {
  for (let y = ry; y < ry + rh && y < height; y++) {
    for (let x = rx; x < rx + rw && x < width; x++) {
      let inside = true;
      // Check corners
      if (x < rx + rad && y < ry + rad) {
        const dx = x - (rx + rad), dy = y - (ry + rad);
        inside = dx * dx + dy * dy <= rad * rad;
      } else if (x >= rx + rw - rad && y < ry + rad) {
        const dx = x - (rx + rw - rad - 1), dy = y - (ry + rad);
        inside = dx * dx + dy * dy <= rad * rad;
      } else if (x < rx + rad && y >= ry + rh - rad) {
        const dx = x - (rx + rad), dy = y - (ry + rh - rad - 1);
        inside = dx * dx + dy * dy <= rad * rad;
      } else if (x >= rx + rw - rad && y >= ry + rh - rad) {
        const dx = x - (rx + rw - rad - 1), dy = y - (ry + rh - rad - 1);
        inside = dx * dx + dy * dy <= rad * rad;
      }
      if (inside) setPixel(pixels, width, x, y, r, g, b, a);
    }
  }
}

function drawMessengerIcon(pixels, width, height) {
  const s = width;
  // Background - rounded rect with gradient
  const rad = Math.round(s * 0.22);
  for (let y = 0; y < s; y++) {
    const t = y / s;
    const r = Math.round(124 + (91 - 124) * t);
    const g = Math.round(127 + (94 - 127) * t);
    const b = Math.round(191 + (166 - 191) * t);
    for (let x = 0; x < s; x++) {
      let inside = true;
      if (x < rad && y < rad) {
        inside = (x - rad) ** 2 + (y - rad) ** 2 <= rad * rad;
      } else if (x >= s - rad && y < rad) {
        inside = (x - (s - rad - 1)) ** 2 + (y - rad) ** 2 <= rad * rad;
      } else if (x < rad && y >= s - rad) {
        inside = (x - rad) ** 2 + (y - (s - rad - 1)) ** 2 <= rad * rad;
      } else if (x >= s - rad && y >= s - rad) {
        inside = (x - (s - rad - 1)) ** 2 + (y - (s - rad - 1)) ** 2 <= rad * rad;
      }
      if (inside) setPixel(pixels, width, x, y, r, g, b, 255);
    }
  }

  // Chat bubble (ellipse)
  const cx = s / 2, cy = s * 0.44;
  const ew = s * 0.34, eh = s * 0.24;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const dx = (x - cx) / ew, dy = (y - cy) / eh;
      if (dx * dx + dy * dy <= 1) {
        setPixel(pixels, width, x, y, 255, 255, 255, 242);
      }
    }
  }

  // Bubble tail (triangle)
  const tailX = s * 0.22, tailY = s * 0.78;
  const tailTopX = s * 0.24, tailTopY = cy + eh * 0.7;
  const tailRightX = s * 0.36, tailRightY = cy + eh * 0.55;
  for (let y = Math.floor(tailTopY); y <= Math.ceil(tailY); y++) {
    for (let x = Math.floor(tailX - s * 0.05); x <= Math.ceil(tailRightX); x++) {
      // Point in triangle test
      const d1 = (x - tailTopX) * (tailY - tailTopY) - (tailX - tailTopX) * (y - tailTopY);
      const d2 = (x - tailRightX) * (tailTopY - tailRightY) - (tailTopX - tailRightX) * (y - tailRightY);
      const d3 = (x - tailX) * (tailRightY - tailY) - (tailRightX - tailX) * (y - tailY);
      const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
      const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
      if (!(hasNeg && hasPos)) {
        setPixel(pixels, width, x, y, 255, 255, 255, 242);
      }
    }
  }

  // Three dots
  const dotR = s * 0.04;
  const dotY = cy;
  fillCircle(pixels, width, height, cx - s * 0.12, dotY, dotR, 91, 94, 166, 255);
  fillCircle(pixels, width, height, cx, dotY, dotR, 91, 94, 166, 255);
  fillCircle(pixels, width, height, cx + s * 0.12, dotY, dotR, 91, 94, 166, 255);
}

// Generate both sizes
const outDir = path.join(__dirname, '..', 'client', 'public');
[192, 512].forEach(size => {
  const png = createPNG(size, size, drawMessengerIcon);
  const filePath = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`Created ${filePath} (${png.length} bytes)`);
});
