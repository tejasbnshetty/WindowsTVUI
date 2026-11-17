// Generates the placeholder app icon (build/icon.ico + build/icon.png) with no dependencies:
// a blue rounded square with a white "play" triangle. Run with `npm run icon`; the output is committed.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4; // supersampling per axis, for smooth edges

// ---- tiny PNG encoder ----
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- the picture, in unit coordinates ----
function roundedRectSdf(px, py, half, r) {
  const qx = Math.abs(px - 0.5) - (half - r), qy = Math.abs(py - 0.5) - (half - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const A = [0.40, 0.27], B = [0.40, 0.73], C = [0.76, 0.5];
function inTriangle(px, py) {
  const s = (p1, p2) => (px - p2[0]) * (p1[1] - p2[1]) - (p1[0] - p2[0]) * (py - p2[1]);
  const d1 = s(A, B), d2 = s(B, C), d3 = s(C, A);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function render(size) {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / size, py = (y + (sy + 0.5) / SS) / size;
          if (roundedRectSdf(px, py, 0.5, 0.2) > 0) continue; // outside the rounded square
          // diagonal blue gradient
          const t = (px + py) / 2;
          let cr = 59 + (29 - 59) * t, cg = 130 + (78 - 130) * t, cb = 246 + (216 - 246) * t;
          if (inTriangle(px, py)) { cr = 255; cg = 255; cb = 255; }
          r += cr; g += cg; b += cb; a += 255;
        }
      }
      const n = SS * SS, i = (y * size + x) * 4;
      const cover = a / (255 * n);
      if (cover > 0) {
        out[i] = Math.round(r / (cover * n)); out[i + 1] = Math.round(g / (cover * n)); out[i + 2] = Math.round(b / (cover * n));
        out[i + 3] = Math.round(cover * 255);
      }
    }
  }
  return out;
}

// ---- ICO container with PNG-compressed images ----
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = [], blobs = [];
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    entries.push(e); blobs.push(data); offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

const outDir = path.join(__dirname, "..", "build");
fs.mkdirSync(outDir, { recursive: true });
const images = SIZES.map((size) => ({ size, data: png(size, render(size)) }));
fs.writeFileSync(path.join(outDir, "icon.ico"), ico(images));
fs.writeFileSync(path.join(outDir, "icon.png"), png(512, render(512)));
console.log(`wrote build/icon.ico (${SIZES.join(", ")} px) and build/icon.png (512 px)`);
