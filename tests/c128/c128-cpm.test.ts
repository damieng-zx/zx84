/**
 * CP/M 3.0 on the 128, from the VICE project's `c128-cpm/cpm3.d81` (a 1581 boot
 * disk) with the real ROMs: the KERNAL boots it, the Z80 loader runs and calls
 * the 8502 for disk reads, and CP/M comes up with its prompt and reads the
 * disk. Needs the 128's ROMs, the 1581's DOS and the image in mcp/.cache
 * (c128-dev/cpm3.d81); skipped without them.
 */

import { describe, it, expect } from 'vitest';
import { C128Machine } from '@/machines/c128/c128-machine.ts';
import { romImage } from '../snapshot/native-state-helpers.ts';

const basicLo = romImage('c128-dev/basiclo');
const basicHi = romImage('c128-dev/basichi');
const kernal = romImage('c128-dev/kernal');
const chargen = romImage('c128-dev/chargen');
const dos = romImage('dos1581.rom');
const disk = romImage('c128-dev/cpm3.d81');

const run = (m: C128Machine, frames: number): void => { for (let f = 0; f < frames; f++) m.tick(); };

function typeLine(m: C128Machine, text: string): void {
  for (const ch of text) {
    const key = ch === ' ' ? 'space' : ch.toLowerCase();
    m.keyboard.setKey(key, true); run(m, 6);
    m.keyboard.setKey(key, false); run(m, 6);
  }
  m.keyboard.setKey('return', true); run(m, 6);
  m.keyboard.setKey('return', false);
}

describe.skipIf(!basicLo || !basicHi || !kernal || !chargen || !dos || !disk)('CP/M 3.0 from a 1581 boot disk', () => {
  it('boots to the A> prompt and lists the disk', () => {
    const m = new C128Machine(null);
    m.loadRoms(basicLo, basicHi, kernal, chargen);
    m.installDrive(dos!, '1581');
    m.drive!.mountImage(disk!, 'cpm3.d81');
    m.reset();
    run(m, 1200);
    const banner = m.ocrScreenForMcp();
    expect(banner).toContain('CP/M 3.0 On the Commodore 128');
    expect(banner).toContain('A>');
    typeLine(m, 'dir');
    run(m, 600);
    const listing = m.ocrScreenForMcp();
    expect(listing).toContain('CPM+');
    expect(listing).toContain('SYS');
    expect(listing).toContain('CCP');
    m.destroy();
  }, 60_000);
});
