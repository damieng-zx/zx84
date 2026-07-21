import { describe, it, expect } from 'vitest';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';

/** Build a "firmware" page that writes a marker byte to RAM and loops.
 *  Padded with 0xFF (RST 38h) filler so we can spot under-runs. */
function firmwarePage(marker: number): Uint8Array {
  const fw = new Uint8Array(0x4000).fill(0xFF);
  let i = 0;
  fw[i++] = 0xF3;                                   // DI
  fw[i++] = 0x3E; fw[i++] = marker;                 // LD A,marker
  fw[i++] = 0x32; fw[i++] = 0x00; fw[i++] = 0x80;   // LD (0x8000),A
  fw[i++] = 0xC3; fw[i++] = 0x06; fw[i++] = 0x00;   // JP 0x0006 (loop)
  return fw;
}

function buildCpr(pages: (Uint8Array | undefined)[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < pages.length; i++) {
    if (!pages[i]) continue;
    const id = new Uint8Array([0x63, 0x62, 0x30 + Math.floor(i / 10), 0x30 + (i % 10)]);
    const len = new Uint8Array([0x00, 0x40, 0, 0]);   // 0x4000 little-endian
    chunks.push(id, len, pages[i]!);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(12 + total);
  out[0] = 0x52; out[1] = 0x49; out[2] = 0x46; out[3] = 0x46;   // 'RIFF'
  const rs = 4 + total;
  out[4] = rs & 0xFF; out[5] = (rs >> 8) & 0xFF;
  out[8] = 0x41; out[9] = 0x4D; out[10] = 0x53; out[11] = 0x21; // 'AMS!'
  let off = 12;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

describe('DEBUG: Plus cartridge load + boot trace', () => {
  it('readByte(0) returns cartridge page 0 first byte after loadCartridge + reset', () => {
    const m = new CpcMachine('cpc6128plus', null);
    const pages: (Uint8Array | undefined)[] = new Array(32).fill(undefined);
    pages[0] = firmwarePage(0x42);
    m.memory.loadCartridge(pages);
    m.reset();
    expect(m.memory.readByte(0)).toBe(0xF3);   // DI = first byte of the firmware
  });

  it('CPU executes cartridge firmware — marker appears in RAM after tick', () => {
    const m = new CpcMachine('cpc6128plus', null);
    const pages: (Uint8Array | undefined)[] = new Array(32).fill(undefined);
    pages[0] = firmwarePage(0x42);
    m.memory.loadCartridge(pages);
    m.reset();
    expect(m.memory.readByte(0x8000)).toBe(0x00);   // pristine
    m.tick();
    expect(m.memory.readByte(0x8000)).toBe(0x42);   // firmware wrote the marker
  });

  it('end-to-end via the cartridge slot (parseCpr + slot.insert + tick)', async () => {
    const m = new CpcMachine('cpc6128plus', null);
    m.start = async () => {};
    const pages: (Uint8Array | undefined)[] = new Array(32).fill(undefined);
    pages[0] = firmwarePage(0x99);
    const cpr = buildCpr(pages);
    m.services.roms.cartridge!.insert(cpr, 'test.cpr');
    expect(m.memory.readByte(0)).toBe(0xF3);
    m.tick();
    expect(m.memory.readByte(0x8000)).toBe(0x99);
  });

  it('resolveMemoryRegion maps the Plus cartridge region ids from the descriptor', () => {
    // descriptor.ts declares cpcCartLower/Basic/Amsdos for Plus models; the
    // Memory pane resolves them through here. page1 = BASIC, page3 = AMSDOS.
    const m = new CpcMachine('cpc6128plus', null);
    const pages: (Uint8Array | undefined)[] = new Array(32).fill(undefined);
    pages[0] = new Uint8Array(0x4000).fill(0xA0);
    pages[1] = new Uint8Array(0x4000).fill(0xB1);
    pages[3] = new Uint8Array(0x4000).fill(0xC3);
    m.memory.loadCartridge(pages);
    m.reset();

    const lower = m.resolveMemoryRegion('cpcCartLower');
    expect(lower?.baseAddr).toBe(0x0000);
    expect(lower?.data[0]).toBe(0xA0);

    const basic = m.resolveMemoryRegion('cpcCartBasic');
    expect(basic?.baseAddr).toBe(0xC000);
    expect(basic?.data[0]).toBe(0xB1);

    const amsdos = m.resolveMemoryRegion('cpcCartAmsdos');
    expect(amsdos?.baseAddr).toBe(0xC000);
    expect(amsdos?.data[0]).toBe(0xC3);
  });
});
