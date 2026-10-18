/**
 * The disk interface against real firmware: boots MSX-DOS 1 from a real disk
 * image, lists it, copies a file to a second drive and checks the copy.
 *
 * Skipped unless pointed at media (none is shipped with the repository):
 *
 *   MSX_BIOS=path/to/hx-10_basic-bios1.rom      (defaults to mcp/.cache)
 *   MSX_DISK_ROM=path/to/standard-family-disk.rom   e.g. a Philips VY-0010 ROM
 *   MSX_DISK_ROM_COMPACT=path/to/compact-family.rom e.g. a National FS-FD351 ROM
 *   MSX_DOS_DISK=path/to/msx-dos-1.03.dsk       a raw MSX-DOS 1 boot disk
 *
 * Each ROM variant is exercised if its variable is set. The expectations are
 * what MSX-DOS 1.03 itself prints and what the disk holds, so they do not
 * depend on this emulator's own behaviour.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MsxMachine } from '@/machines/msx/msx-machine.ts';
import { blankMsxDisk, parseMsxFloppy, serializeMsxRaw } from '@/media/floppy/msx-disk.ts';

const BIOS = process.env.MSX_BIOS ?? join(import.meta.dirname, '../../mcp/.cache/hx-10_basic-bios1.rom');
const DISK = process.env.MSX_DOS_DISK;
const ROMS: [string, string | undefined][] = [
  ['standard family', process.env.MSX_DISK_ROM],
  ['compact family', process.env.MSX_DISK_ROM_COMPACT],
];
const ready = existsSync(BIOS) && DISK !== undefined && existsSync(DISK);

const KEYS: Record<string, string> = { ' ': 'Space', '.': 'Period', ':': 'Semicolon', '\n': 'Enter' };

/** Press a character on the emulated keyboard (letters, digits, space, . : and Enter). */
function press(m: MsxMachine, ch: string): void {
  const shift = ch === ':';
  const code = KEYS[ch] ?? (/[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : `Digit${ch}`);
  if (shift) m.keyboard.handleKeyEvent('ShiftLeft', true);
  m.keyboard.handleKeyEvent(code, true);
  for (let i = 0; i < 4; i++) m.tick();
  m.keyboard.handleKeyEvent(code, false);
  if (shift) m.keyboard.handleKeyEvent('ShiftLeft', false);
  for (let i = 0; i < 4; i++) m.tick();
}

function typeLine(m: MsxMachine, text: string, settle: number): void {
  for (const ch of text + '\n') press(m, ch);
  for (let i = 0; i < settle; i++) m.tick();
}

describe.skipIf(!ready)('real Disk BASIC ROMs', () => {
  for (const [label, romPath] of ROMS) {
    it.skipIf(!romPath || !existsSync(romPath))(`${label}: boots MSX-DOS, lists A:, copies to B:`, () => {
      const m = new MsxMachine('hx-10');
      try {
        m.loadROM(new Uint8Array(readFileSync(BIOS)));
        m.loadDiskRom(new Uint8Array(readFileSync(romPath!)).subarray(0, 0x4000));
        m.setFloppyEnabled(true);
        const dos = readFileSync(DISK!);
        m.loadDisk(parseMsxFloppy(new Uint8Array(dos)), 0);
        m.loadDisk(blankMsxDisk(0xF9), 1);
        m.turbo = true;
        m.reset();
        for (let i = 0; i < 1500; i++) m.tick();
        expect(m.ocrScreenForMcp()).toContain('MSX-DOS version');

        typeLine(m, '', 400);                       // accept the default date
        typeLine(m, 'dir', 400);
        expect(m.ocrScreenForMcp()).toContain('COMMAND  COM');

        typeLine(m, 'copy command.com b:', 900);
        expect(m.ocrScreenForMcp()).toContain('1 file copied');

        // The written disk must carry an identical copy of the file.
        const written = serializeMsxRaw(m.fdc.getDiskImage(1)!);
        const source = serializeMsxRaw(m.fdc.getDiskImage(0)!);
        const findFile = (raw: Uint8Array): Uint8Array | null => {
          const spf = raw[0x16], res = 1, root = raw[0x11] | (raw[0x12] << 8), spc = raw[0x0D];
          const rootStart = (res + 2 * spf) * 512;
          for (let i = 0; i < root; i++) {
            const e = raw.subarray(rootStart + i * 32, rootStart + i * 32 + 32);
            if (e[0] === 0) break;
            if (String.fromCharCode(...e.subarray(0, 11)) !== 'COMMAND COM') continue;
            const size = e[28] | (e[29] << 8) | (e[30] << 16);
            const dataStart = rootStart + root * 32;
            const fat = raw.subarray(512, 512 + spf * 512);
            const out = new Uint8Array(size);
            let cluster = e[26] | (e[27] << 8), off = 0;
            while (cluster >= 2 && cluster < 0xFF0 && off < size) {
              const base = dataStart + (cluster - 2) * spc * 512;
              out.set(raw.subarray(base, base + Math.min(spc * 512, size - off)), off);
              off += spc * 512;
              const o = (cluster * 3) >> 1;
              const v = fat[o] | (fat[o + 1] << 8);
              cluster = cluster & 1 ? v >> 4 : v & 0xFFF;
            }
            return out;
          }
          return null;
        };
        const original = findFile(source);
        const copy = findFile(written);
        expect(original).not.toBeNull();
        expect(copy).toEqual(original);
      } finally { m.destroy(); }
    }, 60000);
  }
});
