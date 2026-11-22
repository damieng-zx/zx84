/**
 * verify-machine-images.ts — check every machine sheet's pictures really load.
 *
 * Each `src` is resolved the way a Markdown renderer resolves it: relative to
 * the sheet that carries it, not to the docs root. That is the check that
 * matters — a path that only looks right from one directory is exactly how the
 * sheets shipped with broken images the first time.
 *
 *   npx tsx tools/verify-machine-images.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const DOCS = path.join(ROOT, 'docs', 'machines');
const IMAGES = path.join(ROOT, 'docs', 'images', 'machines');

const problems: string[] = [];
const referenced = new Set<string>();
const sheetsWithImages = new Set<string>();

for (const name of fs.readdirSync(DOCS)) {
  if (!name.endsWith('.md') || name === 'TEMPLATE.md') continue;
  const sheet = path.join(DOCS, name);
  const text = fs.readFileSync(sheet, 'utf8');

  const srcs = [...text.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  if (srcs.length === 0) problems.push(`${name}: no machine images`);
  if (srcs.length) sheetsWithImages.add(name);

  for (const src of srcs) {
    // Remote or absolute paths are not ours to check.
    if (/^(https?:|data:|file:|\/)/.test(src)) continue;
    // Resolve against the sheet's own directory, as a renderer would.
    const resolved = path.resolve(path.dirname(sheet), src);
    if (!fs.existsSync(resolved)) {
      problems.push(`${name}: broken image path "${src}" (resolves to ${path.relative(ROOT, resolved)})`);
      continue;
    }
    if (resolved.startsWith(IMAGES + path.sep)) {
      referenced.add(path.relative(IMAGES, resolved));
    }
  }

  // Pictures are shown at their natural size: a width (or height) attribute
  // rescales them, which is how the sheets first shipped with squashed keys.
  for (const tag of text.match(/<img[^>]*>/g) ?? []) {
    const scaled = /\s(width|height)="/.exec(tag);
    if (scaled) {
      const src = /\ssrc="([^"]+)"/.exec(tag)?.[1] ?? tag;
      problems.push(`${name}: resized picture (${scaled[1]}=) "${src}"`);
    }
  }
}

for (const file of fs.readdirSync(IMAGES)) {
  if (!referenced.has(file)) problems.push(`unused image: docs/images/machines/${file}`);
}

console.log(`${sheetsWithImages.size} sheet(s) with pictures, ${referenced.size} image(s) referenced, ${fs.readdirSync(IMAGES).length} on disk`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else {
  console.log('every picture resolves from its sheet');
}
