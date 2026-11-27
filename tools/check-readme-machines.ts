/**
 * check-readme-machines.ts — compare the README's machine table (and the readable
 * model-id list) against the machine registry.
 *
 * The registry is the parts catalog; anything registered must be documented.
 *   npx tsx tools/check-readme-machines.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { registry } from '../src/machines/registry.ts';

const ROOT = path.join(import.meta.dirname, '..');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

// Registered model ids, in registry order.
const registered = registry.flatMap((entry) => entry.models as readonly string[]);

// The README's machine table links every sheet it documents.
const linkedSheets = new Set(
  [...readme.matchAll(/\]\(docs\/machines\/([a-z0-9-]+)\.md\)/g)].map((m) => m[1]),
);

// Every sheet on disk should be linked, and every link should exist.
const sheetsOnDisk = fs.readdirSync(path.join(ROOT, 'docs', 'machines'))
  .filter((n) => n.endsWith('.md') && n !== 'TEMPLATE.md')
  .map((n) => n.replace(/\.md$/, ''));

const problems: string[] = [];
for (const sheet of sheetsOnDisk) {
  if (!linkedSheets.has(sheet)) problems.push(`README does not link docs/machines/${sheet}.md`);
}
for (const sheet of linkedSheets) {
  if (!sheetsOnDisk.includes(sheet)) problems.push(`README links missing docs/machines/${sheet}.md`);
}

// A model id is documented if it appears anywhere in the README (the table's
// Models column or the readable id list under Media).
const undocumented = registered.filter((id) => !new RegExp(`\\b${id.replace(/[+]/g, '\\+')}\\b`).test(readme));
if (undocumented.length) problems.push(`README never mentions model id(s): ${undocumented.join(' ')}`);

console.log(`${registry.length} machine kind(s), ${registered.length} model id(s), ${sheetsOnDisk.length} sheet(s), ${linkedSheets.size} linked`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else {
  console.log('README covers every registered machine and sheet');
}
