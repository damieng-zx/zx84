/**
 * Spectrum font hunting — scan live RAM for character sets and add them to
 * the shared font store.
 *
 * Three techniques, all Spectrum-memory-layout specific:
 *   CHARS   — read the CHARS system variable (0x5C36); a font sits 256 bytes
 *             past it when its space glyph is blank.
 *   COPYR   — find the ROM copyright glyph block signature; the font starts
 *             760 bytes earlier when its space glyph is blank.
 *   SCGRAB  — collect non-blank tiles from the 0x4000 screen bitmap, then
 *             look for a RAM block whose 96 glyphs match them.
 *
 * Lives in the machine's ui/ folder because every address above is Spectrum
 * silicon, not something the generic Fonts pane may know. The pane reaches
 * it through the machine-ui manifest (`HuntFonts`).
 */

import { machine, setStatus } from '@/shell/context.ts';
import { loadFontStore, saveFontStore, type FontEntry } from '@/shell/lifecycle.ts';
import { setFontName, persistSetting } from '@/store/settings.ts';

const COPYRIGHT_SIG = [0x3C, 0x42, 0x99, 0xA1, 0xA1, 0x99, 0x42, 0x3C];

function extractScreenTiles(mem: Uint8Array): Set<string> {
  const tiles = new Set<string>();
  for (let cr = 0; cr < 24; cr++) {
    for (let col = 0; col < 32; col++) {
      const bytes: number[] = [];
      let blank = true;
      for (let py = 0; py < 8; py++) {
        const y = cr * 8 + py;
        const addr = 0x4000 | ((y & 0xC0) << 5) | ((y & 0x07) << 8) | ((y & 0x38) << 2);
        const b = mem[addr + col];
        bytes.push(b);
        if (b !== 0) blank = false;
      }
      if (!blank) tiles.add(bytes.join(','));
    }
  }
  return tiles;
}

function tileKey(mem: Uint8Array, offset: number): string {
  return `${mem[offset]},${mem[offset+1]},${mem[offset+2]},${mem[offset+3]},${mem[offset+4]},${mem[offset+5]},${mem[offset+6]},${mem[offset+7]}`;
}

const BLANK_KEY = '0,0,0,0,0,0,0,0';

function isFontBlank(mem: Uint8Array, fontStart: number): boolean {
  // Check if font is entirely blank (all 768 bytes are zero)
  // We skip the first character (space) which should be blank, and check chars 1-95
  for (let c = 1; c < 96; c++) {
    const offset = fontStart + c * 8;
    for (let b = 0; b < 8; b++) {
      if (mem[offset + b] !== 0) return false;
    }
  }
  return true; // All characters 1-95 are blank
}

function bytesToB64(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
  return btoa(binary);
}

function getActiveFilename(): string {
  try { return localStorage.getItem('zx84-last-file') ?? ''; } catch { return ''; }
}

export function huntSpectrumFonts(): void {
  if (!machine) { setStatus('No emulator running'); return; }
  const mem = machine.memory.snapshot();
  const store = loadFontStore();
  const existingIds = new Set(store.map(e => e.id));
  const existingAddrs = new Set(store.filter(e => e.address != null).map(e => e.address!));
  const added: FontEntry[] = [];
  const filename = getActiveFilename().replace(/\.[^.]+$/, '') || '';
  const RAM_START = 0x4000;

  console.group('[FontHunt] Starting hunt…');
  console.log('Active file:', filename || '(none)');
  console.log('Existing fonts:', existingIds.size);

  const lo = mem[0x5C36], hi = mem[0x5C37];
  let charsAddr = lo | (hi << 8);
  console.group('[CHARS] System variable');
  console.log(`Raw bytes: [${lo}, ${hi}] → address ${charsAddr}`);
  if (charsAddr === 0) { charsAddr = 0x3C00; console.log('Zero — defaulting to', charsAddr); }
  const charsFont = charsAddr + 256;
  console.log(`Font start: ${charsAddr} + 256 = ${charsFont}`);
  if (charsFont + 768 > 65536) { console.log('Out of range, skipping'); }
  else if (charsFont < RAM_START) { console.log(`In ROM (< ${RAM_START}), skipping`); }
  else {
    const spaceBytes = Array.from(mem.slice(charsFont, charsFont + 8));
    const spaceBlank = spaceBytes.every(b => b === 0);
    console.log('Space bytes:', spaceBytes.join(', '), spaceBlank ? '✓ blank' : '✗ not blank');
    if (spaceBlank) {
      if (isFontBlank(mem, charsFont)) {
        console.log('✗ Font is entirely blank, skipping');
      } else {
        const id = `chars:${charsFont}`;
        if (existingIds.has(id) || existingAddrs.has(charsFont)) { console.log('Already captured:', id); }
        else {
          console.log('✓ Captured:', id);
          added.push({ id, label: filename || 'CHARS', address: charsFont, technique: 'chars', data: bytesToB64(mem.slice(charsFont, charsFont + 768)) });
          existingIds.add(id); existingAddrs.add(charsFont);
        }
      }
    }
  }
  console.groupEnd();

  console.group('[COPYR] © signature scan');
  let copyrHits = 0, copyrValidated = 0;
  for (let addr = Math.max(RAM_START, 760); addr <= 65536 - 8; addr++) {
    let match = true;
    for (let j = 0; j < 8; j++) { if (mem[addr + j] !== COPYRIGHT_SIG[j]) { match = false; break; } }
    if (!match) continue;
    copyrHits++;
    const fontStart = addr - 760;
    if (fontStart < RAM_START) { console.log(`© at ${addr} → font at ${fontStart} (ROM, skip)`); continue; }
    const spaceBytes = Array.from(mem.slice(fontStart, fontStart + 8));
    const spaceBlank = spaceBytes.every(b => b === 0);
    if (!spaceBlank) { console.log(`© at ${addr} → font at ${fontStart}, space: [${spaceBytes.join(',')}] ✗`); continue; }
    if (isFontBlank(mem, fontStart)) { console.log(`© at ${addr} → font at ${fontStart}, ✗ font is entirely blank`); continue; }
    copyrValidated++;
    const id = `copyr:${fontStart}`;
    if (existingIds.has(id) || existingAddrs.has(fontStart)) { console.log(`© at ${addr} → font at ${fontStart} ✓ (already captured)`); }
    else {
      console.log(`© at ${addr} → font at ${fontStart} ✓ Captured`);
      added.push({ id, label: filename || '© scan', address: fontStart, technique: 'copyr', data: bytesToB64(mem.slice(fontStart, fontStart + 768)) });
      existingIds.add(id); existingAddrs.add(fontStart);
    }
  }
  console.log(`Signature hits: ${copyrHits}, validated: ${copyrValidated}`);
  console.groupEnd();

  console.group('[SCGRAB] Screen tile scan');
  const screenTiles = extractScreenTiles(mem);
  console.log(`Unique non-blank screen tiles: ${screenTiles.size}`);
  if (screenTiles.size < 15) { console.log('Need ≥15 tiles, skipping SCGRAB'); }
  else {
    let spaceCandidates = 0, bestMatches = 0, bestAddr = -1;
    for (let fontStart = RAM_START; fontStart + 768 <= 65536; fontStart++) {
      const id = `scgrab:${fontStart}`;
      if (existingIds.has(id) || existingAddrs.has(fontStart)) continue;
      if (tileKey(mem, fontStart) !== BLANK_KEY) continue;
      spaceCandidates++;
      let valid = true, matches = 0;
      for (let s = 1; s < 96; s++) {
        const off = fontStart + s * 8;
        const key = tileKey(mem, off);
        if (key === BLANK_KEY) { valid = false; break; }
        if (screenTiles.has(key)) matches++;
      }
      if (matches > bestMatches) { bestMatches = matches; bestAddr = fontStart; }
      if (!valid || matches < 15) continue;
      console.log(`✓ Font at ${fontStart}: ${matches}/95 slots match screen tiles`);
      added.push({ id, label: filename || 'SCGRAB', address: fontStart, technique: 'scgrab', data: bytesToB64(mem.slice(fontStart, fontStart + 768)) });
      existingIds.add(id); existingAddrs.add(fontStart);
    }
    console.log(`Space-start candidates: ${spaceCandidates}, best match: ${bestMatches} tiles at ${bestAddr}`);
  }
  console.groupEnd();

  if (added.length === 0) {
    console.log('[FontHunt] No new fonts found'); console.groupEnd();
    setStatus('No new fonts found in RAM'); return;
  }
  saveFontStore([...store, ...added]);
  setFontName(added[added.length - 1].id);
  persistSetting('font', added[added.length - 1].id);
  console.log(`[FontHunt] Total found: ${added.length} —`, added.map(e => `${e.technique}:${e.address}`).join(', '));
  console.groupEnd();
  setStatus(`Found ${added.length} font${added.length > 1 ? 's' : ''}`);
}
