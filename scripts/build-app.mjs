import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST_DIR = path.join(ROOT, 'app', 'dist');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function compileTsDirectory(srcRelDir, outRelDir) {
  const srcAbs = path.join(ROOT, srcRelDir);
  const outAbs = path.join(DIST_DIR, outRelDir);
  ensureDir(outAbs);

  for (const entry of fs.readdirSync(srcAbs, { withFileTypes: true })) {
    const entrySrc = path.join(srcAbs, entry.name);
    if (entry.isDirectory()) {
      compileTsDirectory(
        path.join(srcRelDir, entry.name),
        path.join(outRelDir, entry.name),
      );
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;

    const tsSource = fs.readFileSync(entrySrc, 'utf8');
    // stripTypeScriptTypes with transform removes TypeScript syntax cleanly; rewrite .ts imports to .js
    const stripped = stripTypeScriptTypes(tsSource, {
      mode: 'transform',
      sourceUrl: entry.name,
    }).replace(/(from\s+['"][^'"]+)\.ts(['"])/g, '$1.js$2');

    const jsName = entry.name.replace(/\.ts$/, '.js');
    fs.writeFileSync(path.join(outAbs, jsName), stripped, 'utf8');
  }
}

function copyStaticFile(relSrc, relDest) {
  const src = path.join(ROOT, relSrc);
  const dest = path.join(DIST_DIR, relDest);
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDirectoryRecursive(srcAbs, destAbs) {
  if (!fs.existsSync(srcAbs)) return;
  ensureDir(destAbs);
  for (const entry of fs.readdirSync(srcAbs, { withFileTypes: true })) {
    const entrySrc = path.join(srcAbs, entry.name);
    const entryDest = path.join(destAbs, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(entrySrc, entryDest);
    } else if (entry.isFile()) {
      fs.copyFileSync(entrySrc, entryDest);
    }
  }
}

fs.rmSync(DIST_DIR, { recursive: true, force: true });
ensureDir(DIST_DIR);

compileTsDirectory('packages/core/src', 'packages/core/src');
compileTsDirectory('app/src', 'app/src');

copyStaticFile('app/index.html', 'index.html');
copyStaticFile('app/styles.css', 'styles.css');
copyStaticFile('app/favicon.svg', 'favicon.svg');
copyStaticFile('app/manifest.webmanifest', 'manifest.webmanifest');
const swTemplate = fs.readFileSync(path.join(ROOT, 'app', 'sw.js'), 'utf8');
const swStamped = swTemplate.replace(
  /const CACHE_NAME = ['"][^'"]+['"];/,
  `const CACHE_NAME = 'plinglist-app-v${PKG.version}';`,
);
fs.writeFileSync(path.join(DIST_DIR, 'sw.js'), swStamped, 'utf8');
copyDirectoryRecursive(path.join(ROOT, 'app', 'public'), DIST_DIR);

if (!fs.existsSync(path.join(DIST_DIR, 'og-image.png'))) {
  const width = 1200;
  const height = 630;
  const bg = [13, 107, 88];
  const fg = [255, 255, 255];
  const a = { x: 18 / 64, y: 33.5 / 64 };
  const b = { x: 27.5 / 64, y: 43 / 64 };
  const c = { x: 46.5 / 64, y: 22 / 64 };
  const r = (3.25 / 64) * 0.88;
  const sc = (p) => ({ x: 0.5 + (p.x - 0.5) * 0.88, y: 0.5 + (p.y - 0.5) * 0.88 });
  const sa = sc(a);
  const sb = sc(b);
  const scPt = sc(c);
  const distSeg = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  const aa = 1.2 / height;
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    const ny = 0.5 + (y + 0.5 - height / 2) / height;
    for (let x = 0; x < width; x += 1) {
      const nx = 0.5 + (x + 0.5 - width / 2) / height;
      const d = Math.min(distSeg(nx, ny, sa.x, sa.y, sb.x, sb.y), distSeg(nx, ny, sb.x, sb.y, scPt.x, scPt.y)) - r;
      const alpha = Math.max(0, Math.min(1, 0.5 - d / aa));
      const off = row + 1 + x * 3;
      raw[off] = Math.round(bg[0] + (fg[0] - bg[0]) * alpha);
      raw[off + 1] = Math.round(bg[1] + (fg[1] - bg[1]) * alpha);
      raw[off + 2] = Math.round(bg[2] + (fg[2] - bg[2]) * alpha);
    }
  }
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let crcVal = n;
    for (let k = 0; k < 8; k += 1) crcVal = (crcVal & 1) !== 0 ? 0xedb88320 ^ (crcVal >>> 1) : crcVal >>> 1;
    crcTable[n] = crcVal >>> 0;
  }
  const chunk = (type, data) => {
    const tb = Buffer.from(type, 'ascii');
    const lb = Buffer.alloc(4);
    lb.writeUInt32BE(data.length, 0);
    const input = Buffer.concat([tb, data]);
    let crc = 0xffffffff;
    for (let i = 0; i < input.length; i += 1) crc = crcTable[(crc ^ input[i]) & 0xff] ^ (crc >>> 8);
    const cb = Buffer.alloc(4);
    cb.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([lb, tb, data, cb]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(path.join(DIST_DIR, 'og-image.png'), png);
}

console.log(`Built Plinglist web app into ${DIST_DIR}`);
