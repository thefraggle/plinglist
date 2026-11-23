import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST_DIR = path.join(ROOT, 'app', 'dist');

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

fs.rmSync(DIST_DIR, { recursive: true, force: true });
ensureDir(DIST_DIR);

compileTsDirectory('packages/core/src', 'packages/core/src');
compileTsDirectory('app/src', 'app/src');

copyStaticFile('app/index.html', 'index.html');
copyStaticFile('app/styles.css', 'styles.css');
copyStaticFile('app/manifest.webmanifest', 'manifest.webmanifest');
copyStaticFile('app/sw.js', 'sw.js');

console.log(`Built Plinglist web app into ${DIST_DIR}`);
