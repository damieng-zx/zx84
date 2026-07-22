/**
 * MCP generic load routing — every non-Spectrum machine mounts through its
 * own MediaService. The CPC branch used to be hand-rolled and narrower than
 * the machine's own service (.dsk/.cpr only); the generic path must expose
 * the full surface (.cdt tape, .dsk disk, .cpr cartridge) and work headless
 * (the services stop()/start() around mounts — no start monkey-patching here).
 */

import { describe, it, expect } from 'vitest';
import { mountMediaBytes } from '../../mcp/loader.ts';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { serializeDSK } from '@/media/floppy/dsk.ts';
import { blankMgtDisk } from '@/media/floppy/mgt-image.ts';

/** Minimal valid TZX/CDT: magic + version, empty body. */
const TINY_TZX = new Uint8Array([0x5a, 0x58, 0x54, 0x61, 0x70, 0x65, 0x21, 0x1a, 1, 20]);

/** Minimal valid CPR: header + one cb00 chunk filled with a marker byte. */
function tinyCpr(fill: number): Uint8Array {
  const out = new Uint8Array(12 + 8 + 0x4000);
  out[0] = 0x52; out[1] = 0x49; out[2] = 0x46; out[3] = 0x46;   // 'RIFF'
  const riffSize = 4 + 8 + 0x4000;
  out[4] = riffSize & 0xFF;
  out[5] = (riffSize >> 8) & 0xFF;
  out[8] = 0x41; out[9] = 0x4d; out[10] = 0x53; out[11] = 0x21; // 'AMS!'
  out[12] = 0x63; out[13] = 0x62; out[14] = 0x30; out[15] = 0x30; // 'cb00'
  out[16] = 0x00; out[17] = 0x40;                                // size 0x4000
  out.fill(fill, 20);
  return out;
}

describe('MCP generic load path on the CPC', () => {
  it('mounts a .cdt tape through the CPC media service', async () => {
    const c = new CpcMachine('cpc6128', null);
    const result = await mountMediaBytes(c, TINY_TZX, 'game.cdt');
    expect(result).toBe('Tape loaded: game.cdt');
    c.destroy();
  });

  it('mounts a .dsk into the drive named by the unit hint', async () => {
    const c = new CpcMachine('cpc6128', null);
    const dsk = serializeDSK(blankMgtDisk(40, 1));
    expect(await mountMediaBytes(c, dsk, 'game.dsk')).toBe('Disk A: loaded: game.dsk');
    expect(await mountMediaBytes(c, dsk, 'other.dsk', undefined, 'unit:1')).toBe('Disk B: loaded: other.dsk');
    expect(c.fdc.getDiskImage(0)).not.toBeNull();
    expect(c.fdc.getDiskImage(1)).not.toBeNull();
    c.destroy();
  });

  it('inserts and boots a .cpr cartridge on a Plus model', async () => {
    const c = new CpcMachine('cpc6128plus', null);
    const result = await mountMediaBytes(c, tinyCpr(0x77), 'game.cpr');
    expect(result).toBe('Cartridge: game.cpr');
    // The slot power-cycles the machine; page 0 overlays the lower ROM.
    expect(c.services.roms.cartridge?.name).toBe('game.cpr');
    expect(c.memory.readByte(0x0000)).toBe(0x77);
    c.destroy();
  });
});
