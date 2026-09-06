/**
 * SAM native machine state — the browser-refresh resume path.
 *
 * Not an interchange format: SimCoupe has no snapshot handling, so there is
 * nothing to interoperate with. What matters here is that a round trip is
 * lossless, that it refuses state from different hardware, and that the packed
 * result is small enough for the shell's base64-into-localStorage budget.
 */

import { describe, expect, it } from 'vitest';
import { SamMachine } from '@/machines/sam/sam-machine.ts';
import { pack, unpack } from '@/machines/sam/snapshots/sam-state.ts';
import type { SamModel } from '@/machines/sam/models.ts';

function machine(model: SamModel = 'sam512'): SamMachine {
  const m = new SamMachine(model, null);
  m.start = async () => {};
  return m;
}

/** Put the machine into a distinctive, fully-populated state. */
function scribble(m: SamMachine): void {
  const c = m.cpu;
  c.a = 0x12; c.f = 0x34; c.b = 0x56; c.c = 0x78;
  c.d = 0x9A; c.e = 0xBC; c.h = 0xDE; c.l = 0xF0;
  c.a_ = 0x0F; c.f_ = 0x1E; c.b_ = 0x2D; c.c_ = 0x3C;
  c.d_ = 0x4B; c.e_ = 0x5A; c.h_ = 0x69; c.l_ = 0x78;
  c.ix = 0x1234; c.iy = 0x5678; c.sp = 0x9ABC; c.pc = 0xDEF0;
  c.memptr = 0x0BAD;
  c.i = 0x3F; c.r = 0x5C; c.im = 2;
  c.iff1 = true; c.iff2 = false; c.halted = true; c.eiDelay = true;
  c.tStates = 123_456;

  for (let i = 0; i < 16; i++) m.asic.clut[i] = (i * 7) & 0x7F;
  m.asic.borderIndex = 11;
  m.asic.screenOff = true;
  m.asic.status = 0x1D;
  m.asic.lineReg = 137;
  m.beeperBit = 1;
  m.micBit = 1;

  // Sound: a tone panned hard left on channel 2.
  m.psg.writeRegister(0x1C, 0x01);
  m.psg.writeRegister(0x0A, 0x64);
  m.psg.writeRegister(0x11, 0x30);
  m.psg.writeRegister(0x02, 0x0F);
  m.psg.writeRegister(0x14, 0x04);

  m.memory.setLmpr(0x25);
  m.memory.setHmpr(0x09);
  m.memory.setVmpr(0x6E);

  // Distinctive RAM: a marker in several pages plus a run to exercise packing.
  for (let p = 0; p < 8; p++) {
    const page = m.memory.getRamBank(p);
    page[0] = 0xA0 + p;
    page[1] = 0x5A;
    page.fill(0xC3, 100, 4000);
    page[page.length - 1] = 0x0F + p;
  }
}

describe('PackBits', () => {
  it('round-trips an empty buffer', () => {
    expect(Array.from(unpack(pack(new Uint8Array(0)), 0))).toEqual([]);
  });

  it('round-trips a run', () => {
    const src = new Uint8Array(1000).fill(0xC3);
    const packed = pack(src);
    expect(packed.length).toBeLessThan(src.length);
    expect(Array.from(unpack(packed, src.length))).toEqual(Array.from(src));
  });

  it('round-trips incompressible data with bounded overhead', () => {
    // Worst case is one control byte per 128 literals.
    const src = new Uint8Array(1000);
    for (let i = 0; i < src.length; i++) src[i] = (i * 37) & 0xFF;
    const packed = pack(src);
    expect(Array.from(unpack(packed, src.length))).toEqual(Array.from(src));
    expect(packed.length).toBeLessThanOrEqual(src.length + Math.ceil(src.length / 128) + 1);
  });

  it('round-trips a mixture of runs and literals', () => {
    const src = new Uint8Array(5000);
    for (let i = 0; i < src.length; i++) {
      src[i] = i % 500 < 400 ? 0 : (i * 13) & 0xFF;
    }
    const packed = pack(src);
    expect(Array.from(unpack(packed, src.length))).toEqual(Array.from(src));
  });

  it('handles a run longer than one control byte can express', () => {
    // 128 is the maximum span, so 5000 zeros must split across many controls.
    const src = new Uint8Array(5000);
    expect(Array.from(unpack(pack(src), src.length))).toEqual(Array.from(src));
  });

  it('handles a run at the very end of the buffer', () => {
    const src = new Uint8Array([1, 2, 3, 9, 9, 9, 9, 9]);
    expect(Array.from(unpack(pack(src), src.length))).toEqual(Array.from(src));
  });
});

describe('SAM state round trip', () => {
  it('restores every CPU register', async () => {
    const a = machine();
    scribble(a);
    const blob = a.services.snapshots.saveSync()!;
    a.destroy();

    const b = machine();
    expect(await b.services.snapshots.restoreSync(blob)).toBe(true);

    const c = b.cpu;
    expect([c.a, c.f, c.b, c.c, c.d, c.e, c.h, c.l])
      .toEqual([0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0]);
    expect([c.a_, c.f_, c.b_, c.c_, c.d_, c.e_, c.h_, c.l_])
      .toEqual([0x0F, 0x1E, 0x2D, 0x3C, 0x4B, 0x5A, 0x69, 0x78]);
    expect([c.ix, c.iy, c.sp, c.pc, c.memptr])
      .toEqual([0x1234, 0x5678, 0x9ABC, 0xDEF0, 0x0BAD]);
    expect([c.i, c.r, c.im]).toEqual([0x3F, 0x5C, 2]);
    expect([c.iff1, c.iff2, c.halted, c.eiDelay]).toEqual([true, false, true, true]);
    expect(c.tStates).toBe(123_456);
    b.destroy();
  });

  it('restores the ASIC, including a disarmed line register', async () => {
    const a = machine();
    scribble(a);
    const blob = a.services.snapshots.saveSync()!;
    a.destroy();

    const b = machine();
    await b.services.snapshots.restoreSync(blob);
    expect(Array.from(b.asic.clut)).toEqual(
      Array.from({ length: 16 }, (_, i) => (i * 7) & 0x7F));
    expect(b.asic.borderIndex).toBe(11);
    expect(b.asic.screenOff).toBe(true);
    expect(b.asic.status).toBe(0x1D);
    expect(b.asic.lineReg).toBe(137);
    expect(b.beeperBit).toBe(1);
    expect(b.micBit).toBe(1);
    b.destroy();

    // -1 means "never armed" and must survive as -1, not 0xFFFF.
    const c = machine();
    const fresh = c.services.snapshots.saveSync()!;
    const d = machine();
    await d.services.snapshots.restoreSync(fresh);
    expect(d.asic.lineReg).toBe(-1);
    c.destroy(); d.destroy();
  });

  it('restores the sound chip, which is otherwise write-only', async () => {
    const a = machine();
    scribble(a);
    const expected = a.psg.channelFrequency(2);
    const blob = a.services.snapshots.saveSync()!;
    a.destroy();

    const b = machine();
    await b.services.snapshots.restoreSync(blob);
    expect(b.psg.enabled).toBe(true);
    expect(b.psg.channelFrequency(2)).toBeCloseTo(expected, 6);
    expect(b.psg.amplitudeOf(2)).toEqual([0x0F, 0x00]);
    b.destroy();
  });

  it('restores paging and the RAM under it', async () => {
    const a = machine();
    scribble(a);
    const blob = a.services.snapshots.saveSync()!;
    a.destroy();

    const b = machine();
    await b.services.snapshots.restoreSync(blob);
    expect(b.memory.lmpr).toBe(0x25);
    expect(b.memory.hmpr).toBe(0x09);
    expect(b.memory.vmpr).toBe(0x6E);
    for (let p = 0; p < 8; p++) {
      const page = b.memory.getRamBank(p);
      expect(page[0]).toBe(0xA0 + p);
      expect(page[1]).toBe(0x5A);
      expect(page[2000]).toBe(0xC3);
      expect(page[page.length - 1]).toBe(0x0F + p);
    }
    // ...and the section pointers were rebuilt against the restored RAM.
    expect(b.memory.readByte(0x0000)).toBe(0xA0 + 5);
    b.destroy();
  });

  it('restores external RAM when the megabyte interface is fitted', async () => {
    const a = machine();
    a.memory.setExternalPages(64);
    a.memory.setHmpr(0x80);
    a.memory.setLepr(3);
    a.memory.writeByte(0x8000, 0x77);
    const blob = a.services.snapshots.saveSync()!;
    a.destroy();

    const b = machine();
    b.memory.setExternalPages(64);
    await b.services.snapshots.restoreSync(blob);
    expect(b.memory.readByte(0x8000)).toBe(0x77);
    b.destroy();
  });

  it('clears held keys, which are host state rather than machine state', async () => {
    const a = machine();
    const blob = a.services.snapshots.saveSync()!;
    a.destroy();

    const b = machine();
    b.keyboard.handleKeyEvent(
      { code: 'KeyZ', key: '', shift: false, ctrl: false, alt: false }, true);
    b.joystick.set('fire', true);
    await b.services.snapshots.restoreSync(blob);
    expect(b.keyboard.anyDown).toBe(false);
    expect(b.joystick.read()).toBe(0xFF);
    b.destroy();
  });
});

describe('SAM state validation', () => {
  it('refuses state saved on a different model', async () => {
    // The models differ in how many pages answer, so the blocks would not
    // line up even if the header were ignored.
    const a = machine('sam256');
    const blob = a.services.snapshots.saveSync()!;
    a.destroy();

    const b = machine('sam512');
    expect(await b.services.snapshots.restoreSync(blob)).toBe(false);
    b.destroy();
  });

  it('refuses rubbish rather than throwing', async () => {
    const m = machine();
    expect(await m.services.snapshots.restoreSync(new Uint8Array(0))).toBe(false);
    expect(await m.services.snapshots.restoreSync(new Uint8Array(64))).toBe(false);
    expect(await m.services.snapshots.restoreSync(
      new TextEncoder().encode('ZX84SAM1' + 'x'.repeat(64)))).toBe(false);
    m.destroy();
  });

  it('offers no interchange format, and says so if asked to save one', async () => {
    const m = machine();
    expect(m.services.snapshots.formats()).toEqual([]);
    const r = await m.services.snapshots.apply(new Uint8Array(10), 'game.sna');
    expect(r.ok).toBe(false);
    await expect(m.services.snapshots.save('.sna')).rejects.toThrow();
    m.destroy();
  });
});

describe('SAM state size', () => {
  it('packs a booted machine small enough for localStorage', async () => {
    // The shell base64-encodes this into localStorage, a ~5 MB budget for the
    // whole origin. 512K raw would be ~700 KB encoded; packing mostly-zero RAM
    // must do far better than that.
    const m = machine();
    scribble(m);
    const blob = m.services.snapshots.saveSync()!;
    const base64Size = Math.ceil(blob.length / 3) * 4;
    expect(base64Size).toBeLessThan(256 * 1024);
    m.destroy();
  });

  it('stays bounded even with incompressible RAM', async () => {
    const m = machine();
    for (let p = 0; p < m.memory.internalPageCount; p++) {
      const page = m.memory.getRamBank(p);
      for (let i = 0; i < page.length; i++) page[i] = (i * 37 + p) & 0xFF;
    }
    const blob = m.services.snapshots.saveSync()!;
    // 512K plus PackBits' worst-case overhead, plus a small header.
    expect(blob.length).toBeLessThan(512 * 1024 + 512 * 1024 / 128 + 4096);
    m.destroy();
  });
});
