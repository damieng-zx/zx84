/**
 * add-machine-images.ts — put each machine's screen and keyboard into its sheet.
 *
 *   npx tsx tools/add-machine-images.ts
 *
 * Both pictures go between the sheet's opening description and its
 * specification table, as one centred row: the screen as the machine boots and
 * the on-screen keyboard the pane draws. A centred block cannot wrap the table
 * the way a float would. Running the tool twice changes nothing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const DOCS = path.join(import.meta.dirname, '..', 'docs', 'machines');
/** Relative to a sheet in docs/machines/, not to the docs root. */
const IMAGES = '../images/machines';

export interface ImagePair {
  /** Sheet file name, without `.md`. */
  readonly sheet: string;
  /** First picture's description, used as its alt text. */
  readonly screen: string;
  /** The keyboard picture's alt text, or null when the machine has none. */
  readonly keyboard: string | null;
}

export const PAIRS: readonly ImagePair[] = [
  { sheet: 'zx-spectrum', screen: 'The ZX Spectrum 48K at its © 1982 copyright prompt', keyboard: 'The 48K rubber membrane keyboard, every cap carrying its keyword and symbol legends' },
  { sheet: 'sinclair-clones', screen: 'The Pentagon 128 at its 128 menu', keyboard: 'The Pentagon 128 keyboard' },
  { sheet: 'zx80-zx81', screen: 'The ZX81 showing its inverted-K cursor', keyboard: 'The ZX81 keyboard, with its keyword and function legends' },
  { sheet: 'timex-computer-2048', screen: 'The Timex Computer 2048 at its copyright prompt', keyboard: 'The TC2048 keyboard, with its Portuguese legends' },
  { sheet: 'timex-sinclair-2068', screen: 'The Timex Sinclair 2068 at boot', keyboard: 'The TS2068 keyboard, with its cartridge and Spectrum keys' },
  { sheet: 'amstrad-cpc', screen: 'The CPC 6128 at the Locomotive BASIC prompt', keyboard: 'The CPC 6128 keyboard, with its numeric keypad' },
  { sheet: 'amstrad-pcw', screen: 'The PCW 8256 at power-on: with no system disc in drive A there is nothing to boot', keyboard: 'The PCW 8256 keyboard, with its word-processor keypad' },
  { sheet: 'tatung-einstein', screen: 'The Einstein TC-01 at the MOS prompt', keyboard: 'The Einstein TC-01 keyboard, with its keypad' },
  { sheet: 'msx', screen: 'The Toshiba HX-10 at the MSX BASIC boot screen', keyboard: 'The Toshiba HX-10 keyboard' },
  { sheet: 'memotech-mtx', screen: 'The MTX512 at the READY prompt', keyboard: 'The MTX512 keyboard, with its cursor keypad' },
  { sheet: 'camputers-lynx', screen: 'The Lynx 48K at its prompt', keyboard: 'The Lynx 48K keyboard, with its numeric keypad' },
  { sheet: 'jupiter-ace', screen: 'The Ace at power-on: it clears to paper white and waits at the FORTH prompt for input', keyboard: 'The Jupiter Ace keyboard, with its FORTH word legends' },
  { sheet: 'enterprise', screen: 'The Enterprise 128 showing its animated EXOS copyright screen', keyboard: null },
  { sheet: 'acorn-system', screen: 'The Acorn System 5 at the Acorn DOS prompt', keyboard: 'The ASCII keyboard deck the System machines used' },
  { sheet: 'acorn-atom', screen: 'The Acorn Atom at its ACORN ATOM banner', keyboard: 'The Atom keyboard, with its matrix legends' },
  { sheet: 'bbc-micro', screen: 'The BBC Micro Model B at its BASIC prompt', keyboard: 'The Model B keyboard, with its red function keys' },
  { sheet: 'acorn-electron', screen: 'The Acorn Electron at its BASIC prompt', keyboard: 'The Electron keyboard, with its function keys' },
  { sheet: 'apple-i', screen: 'The Apple I at its monitor prompt', keyboard: 'The Apple I keyboard' },
  { sheet: 'apple-ii', screen: 'The Apple //e at its Apple II banner', keyboard: 'The Apple //e keyboard, with its open and solid Apple keys' },
  { sheet: 'atari-8bit', screen: 'The Atari 800XL at the Altirra BASIC prompt', keyboard: 'The Atari 800XL keyboard, with its console keys' },
  { sheet: 'commodore-64', screen: 'The Commodore 64 at its BASIC banner', keyboard: 'The Commodore 64 breadbin keyboard, with its function keys' },
  { sheet: 'commodore-128', screen: 'The Commodore 128 at its BASIC 7.0 banner', keyboard: 'The Commodore 128 keyboard, with its numeric keypad' },
  { sheet: 'commodore-vic-20', screen: 'The VIC-20 at its BASIC banner', keyboard: 'The VIC-20 breadbin keyboard' },
];

/**
 * Markdown for the pair: one centred row, screen first. No width attribute —
 * each picture draws at its natural size, so it is never resampled.
 */
function markdown(pair: ImagePair): string {
  const images = [
    `<img src="${IMAGES}/${pair.sheet}.png" alt="${pair.screen}">`,
  ];
  if (pair.keyboard) {
    images.push(`<img src="${IMAGES}/${pair.sheet}-keyboard.png" alt="${pair.keyboard}">`);
  }
  return `<p align="center">\n  ${images.join('<br>\n  ')}\n</p>`;
}

/**
 * Insert the block, or replace the one already there. Sheets are edited in
 * place so a wording or sizing change reaches the six dozen existing files
 * without hand-editing them.
 */
function apply(file: string, pair: ImagePair): 'added' | 'updated' | 'unchanged' {
  const text = fs.readFileSync(file, 'utf8');
  const block = markdown(pair);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);

  // An existing block is the centred paragraph that holds this sheet's screen.
  const screenAnywhere = `${IMAGES}/${pair.sheet}.png`;
  const first = lines.findIndex((line) => line.includes(screenAnywhere));
  if (first >= 0) {
    let start = first;
    while (start > 0 && !lines[start].startsWith('<p align')) start--;
    let end = first;
    while (end < lines.length && !lines[end].includes('</p>')) end++;
    if (lines[start].startsWith('<p align') && end < lines.length) {
      const current = lines.slice(start, end + 1).join(eol);
      if (current === block.split('\n').join(eol)) return 'unchanged';
      lines.splice(start, end - start + 1, ...block.split('\n'));
      fs.writeFileSync(file, lines.join(eol));
      return 'updated';
    }
  }

  const tableAt = lines.findIndex((line) => line.trim() === '| | |');
  if (tableAt < 2) throw new Error(`${file}: no specification table found`);
  let insertAt = tableAt;
  while (insertAt > 1 && lines[insertAt - 1].trim() === '') insertAt--;

  lines.splice(insertAt, 0, '', ...block.split('\n'));
  fs.writeFileSync(file, lines.join(eol));
  return 'added';
}

const counts: Record<string, number> = { added: 0, updated: 0, unchanged: 0 };
for (const pair of PAIRS) {
  const file = path.join(DOCS, `${pair.sheet}.md`);
  if (!fs.existsSync(file)) {
    console.error(`missing sheet: ${file}`);
    continue;
  }
  const result = apply(file, pair);
  counts[result]++;
  if (result !== 'unchanged') console.log(`${result} ${pair.sheet}.md`);
}
console.log(`${counts.added} added, ${counts.updated} updated, ${counts.unchanged} unchanged`);
