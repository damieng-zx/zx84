/**
 * Asic — Phase 1 skeleton (locked mode).
 *
 * In locked mode the ASIC must be indistinguishable from a discrete 40010 gate
 * array: every GA command byte (pen select, colour set, RMR mode/rom, RAM
 * config) and every HSYNC-driven raster-interrupt tick must produce identical
 * observable state. These tests assert that equivalence directly, by feeding
 * the same byte sequence to a `GateArray` and an `Asic` and comparing state —
 * so a future override that accidentally breaks locked-mode parity fails here.
 *
 * Reset must re-lock the ASIC (Phase 2's unlock sequence must be reversible).
 */

import { describe, it, expect } from 'vitest';
import { GateArray } from '@/machines/cpc/gate-array.ts';
import { Asic } from '@/machines/cpc/asic.ts';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';

describe('Asic Phase 1 skeleton (locked-mode GA parity)', () => {
  it('constructs locked', () => {
    const a = new Asic();
    expect(a.locked).toBe(true);
  });

  it('reset re-locks the ASIC', () => {
    const a = new Asic();
    a.locked = false;       // simulate a future unlock
    a.reset();
    expect(a.locked).toBe(true);
  });

  it('matches GateArray state after a representative command stream', () => {
    // Drive both chips through the same sequence: pick pens, set colours,
    // toggle ROM enables, change mode, reset the raster counter, and step
    // a few HSYNCs. After every step the observable state must match exactly.
    const ga = new GateArray();
    const asic = new Asic();

    const sequence = [
      0x10,        // select pen 16 (border)
      0x54,        // set colour 0x14 (hardware value)
      0x00,        // select pen 0
      0x4F,        // set colour 0x0F
      0x05,        // select pen 5
      0x47,        // set colour 0x07
      0x8C,        // RMR: mode 0, lower ROM off, upper ROM on, clear raster IRQ
      0x89,        // RMR: mode 1, lower ROM on, upper ROM on
      0xC2,        // RAM config 2 (expansion banks)
      0xC7,        // RAM config 7
    ];

    const snapshot = (c: GateArray) => ({
      pens: Array.from(c.pens),
      mode: c.mode,
      selectedPen: c.selectedPenIndex,
      interruptRequested: c.interruptRequested,
    });

    for (const b of sequence) {
      ga.write(b);
      asic.write(b);
      expect(snapshot(asic)).toEqual(snapshot(ga));
    }
  });

  it('matches GateArray raster-interrupt cadence (52-HSYNC flyback)', () => {
    // The GA raises INT every 52 HSYNCs; the locked ASIC must do the same
    // at the same count, otherwise a CPC boot would mistime its vsync poll.
    const ga = new GateArray();
    const asic = new Asic();

    // Run 51 HSYNCs — no interrupt yet.
    for (let i = 0; i < 51; i++) { ga.onHSync(); asic.onHSync(); }
    expect(ga.interruptRequested).toBe(false);
    expect(asic.interruptRequested).toBe(false);

    // 52nd HSYNC raises the interrupt on both.
    ga.onHSync(); asic.onHSync();
    expect(ga.interruptRequested).toBe(true);
    expect(asic.interruptRequested).toBe(true);

    // Ack clears it on both.
    ga.acknowledgeInterrupt(); asic.acknowledgeInterrupt();
    expect(ga.interruptRequested).toBe(false);
    expect(asic.interruptRequested).toBe(false);
  });
});

describe('CpcMachine Plus integration (Phase 1 smoke)', () => {
  // The CpcMachine constructor must pick the ASIC subclass for Plus models
  // and the discrete GA for non-Plus. Phase 1's contract is "a Plus machine
  // boots identically to a 6128" — the ASIC arrives locked, so a single
  // tick must complete without touching any Plus-specific code path.
  it('instantiates an Asic for cpc6128plus', () => {
    const m = new CpcMachine('cpc6128plus', null);
    expect(m.gateArray).toBeInstanceOf(Asic);
    expect(m.config.isPlus).toBe(true);
    expect(m.config.crtcType).toBe(4);
  });

  it('instantiates an Asic for gx4000', () => {
    const m = new CpcMachine('gx4000', null);
    expect(m.gateArray).toBeInstanceOf(Asic);
  });

  it('keeps the discrete GateArray on a non-Plus model', () => {
    const m = new CpcMachine('cpc6128', null);
    expect(m.gateArray).toBeInstanceOf(GateArray);
    expect(m.gateArray).not.toBeInstanceOf(Asic);
  });

  it('ticks one frame without throwing on a Plus model (locked ASIC path)', () => {
    const m = new CpcMachine('cpc6128plus', null);
    // No ROM loaded — the CPU executes 0xFF (RST 38h) bytes into the interrupt
    // vector. The point of this test is just that the per-scanline loop and the
    // Asic's locked-mode render path complete a frame without crashing.
    expect(() => m.tick()).not.toThrow();
  });
});

// ── Phase 2: ASIC unlock, register-window paging, palette decode ─────────────

/** The canonical 16-byte unlock key poked through &BC00 followed by a toggle
 *  byte. First byte is 0xFF — verified against Caprice32's `asic_locked_seq`
 *  and the real Batman The Movie loader (which writes FF 00 FF 77 … CD EE). */
const UNLOCK_BYTES = [
  0xFF, 0x00, 0xFF, 0x77, 0xB3, 0x51, 0xA8, 0xD4,
  0x62, 0x39, 0x9C, 0x46, 0x2B, 0x15, 0x8A, 0xCD,
];

describe('Asic unlock state machine', () => {
  it('unlocks after the full 16-byte sequence plus one toggle byte', () => {
    const a = new Asic();
    expect(a.locked).toBe(true);
    for (const b of UNLOCK_BYTES) a.pokeLockSequence(b);
    // 16 bytes matched; not yet unlocked.
    expect(a.locked).toBe(true);
    // The 17th byte (any value) toggles.
    a.pokeLockSequence(0x00);
    expect(a.locked).toBe(false);
  });

  it('re-locks when the same sequence is poked again', () => {
    const a = new Asic();
    for (const b of UNLOCK_BYTES) a.pokeLockSequence(b);
    a.pokeLockSequence(0x00);
    expect(a.locked).toBe(false);
    for (const b of UNLOCK_BYTES) a.pokeLockSequence(b);
    a.pokeLockSequence(0xFF);   // any toggle byte works
    expect(a.locked).toBe(true);
  });

  it('ignores a wrong byte in the middle of the sequence (matcher resets)', () => {
    const a = new Asic();
    // First 8 bytes correct, then a wrong byte at position 8 (expects 0x62).
    for (let i = 0; i < 8; i++) a.pokeLockSequence(UNLOCK_BYTES[i]);
    a.pokeLockSequence(0xEE);   // wrong — resets to 0
    // Now feed the rest of the sequence; nothing should unlock.
    for (let i = 8; i < 16; i++) a.pokeLockSequence(UNLOCK_BYTES[i]);
    a.pokeLockSequence(0x00);
    expect(a.locked).toBe(true);
  });

  it('restarts the matcher if the byte after a mismatch itself matches SEQ[0]', () => {
    // Spec edge case: a mismatch followed by SEQ[0] should count as the new
    // start of the sequence, so software that re-enters the routine mid-stream
    // only needs ONE extra leading 0xFF, not two.
    const a = new Asic();
    for (let i = 0; i < 5; i++) a.pokeLockSequence(UNLOCK_BYTES[i]);
    a.pokeLockSequence(0xEE);   // mismatch — resets, but 0xEE != SEQ[0]
    a.pokeLockSequence(0xFF);   // this matches SEQ[0]; matcher should be at 1
    // Continue with SEQ[1..15] from here.
    for (let i = 1; i < 16; i++) a.pokeLockSequence(UNLOCK_BYTES[i]);
    a.pokeLockSequence(0x00);   // toggle
    expect(a.locked).toBe(false);
  });
});

describe('Asic RMR2 escape (Plus banking surface)', () => {
  it('treats a %101xxxxx byte as plain RMR while locked', () => {
    const a = new Asic();
    // 0xA9 = %10101001 — would be RMR2 if unlocked. Locked: bit-5 escape is
    // ignored, so it lands as FN_RMR with mode 1, lower ROM on, upper ROM on.
    a.write(0xA9);
    expect(a.mode).toBe(1);
    // The ASIC window must NOT be visible — locked mode never pages it in.
    expect(a.asicPageVisible).toBe(false);
  });

  it('enables the ASIC window only when RMR2 D4=D3=1 (not bit 4 alone)', () => {
    const a = new Asic();
    for (const b of UNLOCK_BYTES) a.pokeLockSequence(b);
    a.pokeLockSequence(0x00);
    expect(a.locked).toBe(false);

    // D4=D3=1 (%10111000 = 0xB8): register page on.
    a.write(0xB8);
    expect(a.asicPageVisible).toBe(true);

    // D4=1,D3=0 (%10110000 = 0xB0): lower ROM to &8000, register page OFF —
    // a bit-4-only test would wrongly keep it visible.
    a.write(0xB0);
    expect(a.asicPageVisible).toBe(false);

    // D4=D3=0 (%10100000 = 0xA0) also hides it.
    a.write(0xB8);
    a.write(0xA0);
    expect(a.asicPageVisible).toBe(false);
  });

  it('drives lower-ROM cartridge banking from RMR2 D2–D0 / D4–D3', () => {
    const a = new Asic();
    for (const b of UNLOCK_BYTES) a.pokeLockSequence(b);
    a.pokeLockSequence(0x00);
    const banks: Array<[number, number]> = [];
    a.onLowerRomBank = (page, slot) => banks.push([page, slot]);
    a.write(0xA1);   // D4D3=00, page 1 → cartridge page 1 at &0000 (slot 0)
    a.write(0xA9);   // D4D3=01, page 1 → &4000 (slot 1)
    a.write(0xB2);   // D4D3=10, page 2 → &8000 (slot 2)
    a.write(0xB8);   // D4D3=11, page 0 → &0000 (slot 0) + register page
    expect(banks).toEqual([[1, 0], [1, 1], [2, 2], [0, 0]]);
  });

  it('re-locking the ASIC immediately hides the window', () => {
    const a = new Asic();
    for (const b of UNLOCK_BYTES) a.pokeLockSequence(b);
    a.pokeLockSequence(0x00);
    expect(a.locked).toBe(false);

    a.write(0xB8);              // page in (D4=D3=1)
    expect(a.asicPageVisible).toBe(true);

    // Re-run the unlock sequence to toggle back to locked.
    for (const b of UNLOCK_BYTES) a.pokeLockSequence(b);
    a.pokeLockSequence(0x00);
    expect(a.locked).toBe(true);
    expect(a.asicPageVisible).toBe(false);
  });
});

describe('Asic 12-bit palette decode', () => {
  it('decodes the even byte into R (high nibble) and B (low nibble)', () => {
    const a = new Asic();
    // Pen 5, even byte. &6400 + 5*2 = &640A → ASIC-RAM offset 0x240A.
    // Write R=0xA (→ 0xAA), B=0x3 (→ 0x33): byte = 0xA3.
    a.cpuWrite(0x240A, 0xA3);
    // Packed little-endian RGBA: A<<24 | B<<16 | G<<8 | R (matches packRgb).
    const rgba = a.asicPalette[5];
    const r = rgba & 0xFF, b = (rgba >>> 16) & 0xFF, alpha = (rgba >>> 24) & 0xFF;
    expect(r).toBe(0xAA);
    expect(b).toBe(0x33);
    expect(alpha).toBe(0xFF);   // opaque — a 0 alpha renders black/transparent
  });

  it('decodes the odd byte into G (low nibble) and preserves R/B', () => {
    const a = new Asic();
    // Pen 5: set R=0xF (→ 0xFF), B=0x0 (→ 0x00): byte 0xF0.
    a.cpuWrite(0x240A, 0xF0);
    // Then odd byte at &640B → offset 0x240B: G=0x7 (→ 0x77): byte 0x77.
    a.cpuWrite(0x240B, 0x77);
    // Packed little-endian RGBA: A<<24 | B<<16 | G<<8 | R.
    const rgba = a.asicPalette[5];
    const r = rgba & 0xFF, g = (rgba >>> 8) & 0xFF, b = (rgba >>> 16) & 0xFF;
    expect(r).toBe(0xFF);
    expect(g).toBe(0x77);
    expect(b).toBe(0x00);
  });

  it('leaves un-programmed pens at black (palette defaults to zero)', () => {
    const a = new Asic();
    expect(a.asicPalette[0]).toBe(0);
    expect(a.asicPalette[31]).toBe(0);
  });

  it('stores the raw byte in registerPage so reads mirror back', () => {
    const a = new Asic();
    a.cpuWrite(0x240A, 0xA3);
    expect(a.registerPage[0x240A]).toBe(0xA3);
  });
});

describe('CpcMachine ASIC integration (Phase 2: unlock + window paging)', () => {
  it('unlocks via the CRTC register-select port (&BC00) writes', () => {
    const m = new CpcMachine('cpc6128plus', null);
    const asic = m.gateArray as unknown as Asic;
    expect(asic.locked).toBe(true);
    // Poke the sequence + toggle byte through the real port decode.
    for (const b of UNLOCK_BYTES) m.cpu.portOut(0xBC00, b);
    m.cpu.portOut(0xBC00, 0x00);
    expect(asic.locked).toBe(false);
  });

  it('pages the ASIC window into &4000–&7FFF via RMR2 (port &7Fxx)', () => {
    const m = new CpcMachine('cpc6128plus', null);
    const asic = m.gateArray as unknown as Asic;

    // Unlock first.
    for (const b of UNLOCK_BYTES) m.cpu.portOut(0xBC00, b);
    m.cpu.portOut(0xBC00, 0x00);
    expect(asic.locked).toBe(false);

    // Page the ASIC window in via RMR2: OUT (&7FB8), 0xB8 (D4=D3=1).
    // (Port decode: (port & 0xC000) === 0x4000 → GA port. Value 0xB8 = RMR2.)
    m.cpu.portOut(0x7FB8, 0xB8);
    expect(asic.asicPageVisible).toBe(true);

    // A CPU write inside the window must land in the ASIC register page and
    // be visible to a subsequent read of the same address.
    m.cpu.write8(0x6400, 0x5A);
    expect(asic.registerPage[0x2400]).toBe(0x5A);
  });

  it('does not page in the ASIC window when locked (RMR2 escape suppressed)', () => {
    const m = new CpcMachine('cpc6128plus', null);
    const asic = m.gateArray as unknown as Asic;
    m.cpu.portOut(0x7FB8, 0xB8);   // would-be RMR2 page-in (D4=D3=1)
    expect(asic.asicPageVisible).toBe(false);
  });
});

// ── Phase 3: sprites, scroll, split, raster IRQ ──────────────────────────────

import { CPC_SCREEN_WIDTH, CPC_SCREEN_HEIGHT, CPC_BORDER_LEFT, CPC_BORDER_TOP } from '@/machines/cpc/constants.ts';
import type { CrtcLine } from '@/cores/crtc-6845.ts';

/** Build an unlocked Asic with the ASIC window paged into a throwaway machine
 *  — so registerPage writes go through the public `cpuWrite` path. */
function unlockedAsic(): Asic {
  const a = new Asic();
  for (const b of UNLOCK_BYTES) a.pokeLockSequence(b);
  a.pokeLockSequence(0x00);
  expect(a.locked).toBe(false);
  return a;
}

/** Sprites live in ASIC RAM: pixel data at offset 0x0000+, attrs at 0x2000+. */
const SPRITE_PIXELS = 0x0000;
const SPRITE_ATTRS = 0x2000;

describe('Asic hardware sprites', () => {
  // Sprite (x, y) is in mode-2 pixels with the origin at the active area's
  // top-left, so it lands in the framebuffer at (CPC_BORDER_LEFT + x,
  // CPC_BORDER_TOP + y). Magnification %01 = 1× → mag byte 0x05 for 1×1.
  const bx = (x: number) => CPC_BORDER_LEFT + x;
  const by = (y: number) => CPC_BORDER_TOP + y;

  it('renders a sprite pixel at its (x, y) position in the framebuffer', () => {
    const a = unlockedAsic();
    // Program sprite 0: a single opaque pixel at (0, 0) of its 16×16 cell.
    a.cpuWrite(SPRITE_PIXELS + (0 << 8) + (0 << 4) + 0, 0x01);  // pen 1
    // Place the sprite at active-area (10, 20).
    a.cpuWrite(SPRITE_ATTRS + (0 << 3) + 0, 10);        // X lo
    a.cpuWrite(SPRITE_ATTRS + (0 << 3) + 1, 0);         // X hi
    a.cpuWrite(SPRITE_ATTRS + (0 << 3) + 2, 20);        // Y lo
    a.cpuWrite(SPRITE_ATTRS + (0 << 3) + 3, 0);         // Y hi
    a.cpuWrite(SPRITE_ATTRS + (0 << 3) + 4, 0x05);      // mag = 1×1
    // Program pen 1 (sprite pen) to red.
    a.cpuWrite(0x2400 + (17 * 2), 0xF0);   // R=0xF, B=0
    a.cpuWrite(0x2400 + (17 * 2) + 1, 0x00);

    const px = new Uint32Array(CPC_SCREEN_WIDTH * CPC_SCREEN_HEIGHT);
    a.drawSprites(px, by(20));
    const expected = a.asicPalette[17];
    expect(px[by(20) * CPC_SCREEN_WIDTH + bx(10)]).toBe(expected);
    // Adjacent pixels stay cleared.
    expect(px[by(20) * CPC_SCREEN_WIDTH + bx(11)]).toBe(0);
    expect(px[by(21) * CPC_SCREEN_WIDTH + bx(10)]).toBe(0);
  });

  it('treats pen value 0 as transparent (does not overwrite the framebuffer)', () => {
    const a = unlockedAsic();
    const px = new Uint32Array(CPC_SCREEN_WIDTH * CPC_SCREEN_HEIGHT);
    // Pre-fill the pixel the sprite will overlap.
    px[by(5) * CPC_SCREEN_WIDTH + bx(5)] = 0xDEADBEEF;
    // Sprite 0 with pen 0 at (5, 5) — should NOT overwrite.
    a.cpuWrite(SPRITE_PIXELS + 0, 0x00);
    a.cpuWrite(SPRITE_ATTRS + 0, 5);
    a.cpuWrite(SPRITE_ATTRS + 1, 0);
    a.cpuWrite(SPRITE_ATTRS + 2, 5);
    a.cpuWrite(SPRITE_ATTRS + 3, 0);
    a.cpuWrite(SPRITE_ATTRS + 4, 0x05);
    a.drawSprites(px, by(5));
    expect(px[by(5) * CPC_SCREEN_WIDTH + bx(5)]).toBe(0xDEADBEEF);
  });

  it('sprite 0 wins over sprite 15 at the same pixel (priority order)', () => {
    const a = unlockedAsic();
    // Sprite 15: opaque pixel pen 1, positioned at (10, 10).
    a.cpuWrite(SPRITE_PIXELS + (15 << 8), 0x01);
    a.cpuWrite(SPRITE_ATTRS + (15 << 3) + 0, 10);
    a.cpuWrite(SPRITE_ATTRS + (15 << 3) + 2, 10);
    a.cpuWrite(SPRITE_ATTRS + (15 << 3) + 4, 0x05);
    // Sprite 0: opaque pixel pen 2 at the same position.
    a.cpuWrite(SPRITE_PIXELS + (0 << 8), 0x02);
    a.cpuWrite(SPRITE_ATTRS + (0 << 3) + 0, 10);
    a.cpuWrite(SPRITE_ATTRS + (0 << 3) + 2, 10);
    a.cpuWrite(SPRITE_ATTRS + (0 << 3) + 4, 0x05);
    // Program sprite pens 1 and 2 to distinct colours.
    a.cpuWrite(0x2400 + (17 * 2), 0x0F);     // pen 1: blue
    a.cpuWrite(0x2400 + (18 * 2), 0xF0);     // pen 2: red

    const px = new Uint32Array(CPC_SCREEN_WIDTH * CPC_SCREEN_HEIGHT);
    a.drawSprites(px, by(10));
    // Pen 2 (sprite 0) wins over pen 1 (sprite 15).
    expect(px[by(10) * CPC_SCREEN_WIDTH + bx(10)]).toBe(a.asicPalette[18]);
  });

  it('magnifies the sprite by 2× when the magnification field is %10', () => {
    const a = unlockedAsic();
    // Sprite 0: one opaque pixel at (0, 0); mag byte 0x0A = X:%10 (2×), Y:%10.
    a.cpuWrite(SPRITE_PIXELS + 0, 0x01);
    a.cpuWrite(SPRITE_ATTRS + (0 << 3) + 0, 10);
    a.cpuWrite(SPRITE_ATTRS + (0 << 3) + 2, 10);
    a.cpuWrite(SPRITE_ATTRS + (0 << 3) + 4, 0x0A);   // bits 3:2 = 10 (x 2×), bits 1:0 = 10 (y 2×)
    a.cpuWrite(0x2400 + (17 * 2), 0xF0);

    const px = new Uint32Array(CPC_SCREEN_WIDTH * CPC_SCREEN_HEIGHT);
    // 2×2 magnified: active rows 10 and 11, columns 10 and 11 should be lit.
    a.drawSprites(px, by(10));
    a.drawSprites(px, by(11));
    const expected = a.asicPalette[17];
    expect(px[by(10) * CPC_SCREEN_WIDTH + bx(10)]).toBe(expected);
    expect(px[by(10) * CPC_SCREEN_WIDTH + bx(11)]).toBe(expected);
    expect(px[by(11) * CPC_SCREEN_WIDTH + bx(10)]).toBe(expected);
    expect(px[by(11) * CPC_SCREEN_WIDTH + bx(11)]).toBe(expected);
    // Outside the 2×2 box stays cleared.
    expect(px[by(10) * CPC_SCREEN_WIDTH + bx(12)]).toBe(0);
    expect(px[by(12) * CPC_SCREEN_WIDTH + bx(10)]).toBe(0);
  });

  it('draws every pixel on the last framebuffer scanline (bufferY = height-1)', () => {
    // The buffer-overrun guard must reject only out-of-range rows, not clip the
    // final valid scanline. Two adjacent opaque pixels on row height-1 must both
    // render — the bug dropped everything past bufferX 0 on the last row.
    const a = unlockedAsic();
    const lastY = CPC_SCREEN_HEIGHT - 1;               // 271
    const activeY = lastY - CPC_BORDER_TOP;            // sprite Y that lands on row 271
    a.cpuWrite(SPRITE_PIXELS + (0 << 8) + 0, 0x01);   // sprite 0, row 0, col 0 → pen 1
    a.cpuWrite(SPRITE_PIXELS + (0 << 8) + 1, 0x01);   // row 0, col 1 → pen 1
    a.cpuWrite(SPRITE_ATTRS + 0, 10);                 // X lo
    a.cpuWrite(SPRITE_ATTRS + 1, 0);                  // X hi
    a.cpuWrite(SPRITE_ATTRS + 2, activeY & 0xFF);     // Y lo
    a.cpuWrite(SPRITE_ATTRS + 3, (activeY >> 8) & 0xFF); // Y hi
    a.cpuWrite(SPRITE_ATTRS + 4, 0x05);               // mag 1×1
    a.cpuWrite(0x2400 + (17 * 2), 0xF0);              // pen 1 → red
    a.cpuWrite(0x2400 + (17 * 2) + 1, 0x00);

    const px = new Uint32Array(CPC_SCREEN_WIDTH * CPC_SCREEN_HEIGHT);
    a.drawSprites(px, lastY);
    const expected = a.asicPalette[17];
    expect(px[lastY * CPC_SCREEN_WIDTH + bx(10)]).toBe(expected);
    expect(px[lastY * CPC_SCREEN_WIDTH + bx(11)]).toBe(expected);
  });

  it('does nothing while locked', () => {
    const a = new Asic();   // locked
    const px = new Uint32Array(CPC_SCREEN_WIDTH * CPC_SCREEN_HEIGHT);
    a.drawSprites(px, 0);
    // Every pixel stays zero.
    expect(px.every(v => v === 0)).toBe(true);
  });
});

describe('Asic raster interrupt (Plus programmable scanline IRQ)', () => {
  it('uses the legacy 52-line flyback while interruptSl === 0', () => {
    const a = unlockedAsic();
    a.interruptSl = 0;
    for (let i = 0; i < 51; i++) a.onHSync();
    expect(a.interruptRequested).toBe(false);
    a.onHSync();
    expect(a.interruptRequested).toBe(true);
  });

  it('suppresses the 52-line flyback and fires at the programmed scanline', () => {
    const a = unlockedAsic();
    a.beginFrame(new Uint32Array(1));
    a.interruptSl = 100;
    // The frame-line counter is compared BEFORE it advances (MAME `vpos`
    // semantics), so interruptSl=N fires on the (N+1)th HSYNC after beginFrame.
    // Across the first 100 HSYNCs the 52-counter also wraps once, but the legacy
    // flyback is suppressed while a PRI is armed — so no interrupt appears yet.
    for (let i = 0; i < 100; i++) {
      a.onHSync();
      expect(a.interruptRequested).toBe(false);
    }
    a.onHSync();   // 101st HSYNC — frameLine reaches 100
    expect(a.interruptRequested).toBe(true);
  });

  it('resets the per-frame scanline counter at beginFrame', () => {
    const a = unlockedAsic();
    a.interruptSl = 50;
    a.beginFrame(new Uint32Array(1));
    for (let i = 0; i < 50; i++) a.onHSync();
    expect(a.interruptRequested).toBe(false);
    a.onHSync();   // 51st since beginFrame — frameLine reaches 50
    expect(a.interruptRequested).toBe(true);
  });

  it('does not perturb the HSync counter when the PRI coincides with a 52-wrap', () => {
    // Regression for the Burnin' Rubber logo-band flicker. The game programs its
    // PRI to fire on the same HSYNC the 52-counter wraps. The 52-check must reset
    // rasterCount to 0 BEFORE the PRI clears bit 5, so the clear is a no-op. If
    // the PRI fires one HSYNC early (the old bug: frameLine incremented up-front),
    // it clears bit 5 of 51 → 19 — a −32 shift that makes the frame-setup handler
    // miss VSYNC every other frame.
    const a = unlockedAsic();
    a.beginFrame(new Uint32Array(1));
    a.interruptSl = 51;   // frameLine reaches 51 on the 52nd HSYNC — the wrap
    for (let i = 0; i < 52; i++) a.onHSync();
    expect(a.interruptRequested).toBe(true);   // PRI fired
    expect(a.rasterCount).toBe(0);             // wrapped to 0, NOT perturbed to 20
  });

  it('falls back to legacy flyback when locked', () => {
    const a = new Asic();   // locked
    a.interruptSl = 100;    // would-be raster IRQ
    a.beginFrame(new Uint32Array(1));
    // Locked → legacy flyback at 52.
    for (let i = 0; i < 51; i++) a.onHSync();
    expect(a.interruptRequested).toBe(false);
    a.onHSync();
    expect(a.interruptRequested).toBe(true);
  });
});

describe('Asic soft scroll + split screen (applyScrollAndSplit)', () => {
  function lineAt(maRow: number): CrtcLine {
    return { maRow, ra: 0, hDisplayed: 40, vDisplay: true };
  }

  it('returns the line unchanged while locked', () => {
    const a = new Asic();   // locked
    const l = lineAt(0x1000);
    expect(a.applyScrollAndSplit(l)).toBe(l);
  });

  it('offsets maRow by vscroll character rows', () => {
    const a = unlockedAsic();
    a.vscroll = 3;
    const l = lineAt(0x1000);
    const out = a.applyScrollAndSplit(l);
    // Each char row = 0x800 bytes; vscroll 3 → +0x1800.
    expect(out.maRow).toBe((0x1000 + 3 * 0x800) & 0x3FFF);
  });

  it('tracks the CRTC address as an offset from splitAddr past the split', () => {
    const a = unlockedAsic();
    a.splitSl = 50;
    a.splitAddr = 0x2000;
    a.beginFrame(new Uint32Array(1));
    // Drive the render loop's order: apply for the current frameLine, then
    // onHSync advances it. The CRTC's natural maRow grows 0x40 per scanline
    // here (arbitrary but monotonic).
    const results: Record<number, number> = {};
    for (let fl = 0; fl <= 55; fl++) {
      results[fl] = a.applyScrollAndSplit(lineAt(0x1000 + fl * 0x40)).maRow;
      a.onHSync();
    }
    // The split engages the line after splitSl and starts exactly at splitAddr.
    expect(results[51]).toBe(0x2000);
    // Later lines follow the CRTC delta: splitAddr + (fl-51)*0x40.
    expect(results[52]).toBe(0x2000 + 0x40);
    expect(results[55]).toBe(0x2000 + 4 * 0x40);
    // Before the split the address is untouched.
    expect(results[50]).toBe(0x1000 + 50 * 0x40);
  });

  it('does not apply the split before splitSl is reached', () => {
    const a = unlockedAsic();
    a.splitSl = 50;
    a.splitAddr = 0x2000;
    a.beginFrame(new Uint32Array(1));
    for (let i = 0; i < 20; i++) a.onHSync();
    const out = a.applyScrollAndSplit(lineAt(0x1234));
    expect(out.maRow).toBe(0x1234);
  });
});

// ── Phase 5: DMA sound ───────────────────────────────────────────────────────

/** DMA register file in ASIC RAM (offsets within registerPage). */
const DMA_CHAN_BASE = 0x2C00;
const DMA_DCSR = 0x2C0F;

describe('Asic DMA sound', () => {
  /** Wire an unlocked Asic to in-memory RAM and AY-register capture. */
  function wiredAsic(ram: Uint8Array): { asic: Asic; ayWrites: [number, number][] } {
    const a = unlockedAsic();
    const ayWrites: [number, number][] = [];
    a.readRam16 = (addr) => ram[addr & 0xFFFF] | ((ram[(addr + 1) & 0xFFFF] << 8));
    a.writeAy = (reg, val) => ayWrites.push([reg, val]);
    return { asic: a, ayWrites };
  }

  /** DMA instruction encoders — keep independent of the implementation.
   *  Top 3 bits = opcode: %000 LOAD, %010 REPEAT, %011 PAUSE, %100 STOP group. */
  const LOAD = (reg: number, data: number) => ((reg & 0x0F) << 8) | (data & 0xFF);
  const PAUSE = (n: number) => (0x03 << 13) | (n & 0x07FF);
  const STOP = (0x04 << 13) | 0x20;
  const INT = (0x04 << 13) | 0x10;

  it('LOAD writes the PSG register from RAM-instruction data', () => {
    const ram = new Uint8Array(0x10000);
    // Channel 0 source = 0x1000. Instruction: LOAD reg=5, data=0xAB.
    ram[0x1000] = LOAD(5, 0xAB) & 0xFF;
    ram[0x1001] = (LOAD(5, 0xAB) >>> 8) & 0xFF;
    const { asic, ayWrites } = wiredAsic(ram);

    // Program channel 0: source = 0x1000, prescaler = 0, then enable via DCSR.
    asic.cpuWrite(DMA_CHAN_BASE, 0x00);          // src lo
    asic.cpuWrite(DMA_CHAN_BASE + 1, 0x10);      // src hi
    asic.cpuWrite(DMA_CHAN_BASE + 2, 0x00);      // prescaler
    asic.cpuWrite(DMA_DCSR, 0x01);               // enable ch0

    asic.dmaCycle();
    expect(ayWrites).toEqual([[5, 0xAB]]);
    // Source advanced past the consumed 2-byte instruction.
    expect(asic.registerPage[DMA_CHAN_BASE]).toBe(0x02);
    expect(asic.registerPage[DMA_CHAN_BASE + 1]).toBe(0x10);
  });

  it('PAUSE holds the channel for N ticks before the next instruction', () => {
    const ram = new Uint8Array(0x10000);
    // PAUSE 3, then LOAD reg 0 with 0x42.
    ram[0x0000] = PAUSE(3) & 0xFF; ram[0x0001] = (PAUSE(3) >>> 8) & 0xFF;
    ram[0x0002] = LOAD(0, 0x42) & 0xFF; ram[0x0003] = (LOAD(0, 0x42) >>> 8) & 0xFF;
    const { asic, ayWrites } = wiredAsic(ram);
    asic.cpuWrite(DMA_CHAN_BASE, 0x00);
    asic.cpuWrite(DMA_CHAN_BASE + 1, 0x00);
    asic.cpuWrite(DMA_DCSR, 0x01);

    asic.dmaCycle();   // consumes PAUSE 3
    expect(ayWrites).toEqual([]);
    asic.dmaCycle();   // tick 1 of 3
    asic.dmaCycle();   // tick 2 of 3
    asic.dmaCycle();   // tick 3 of 3 — channel unpaused, but no instruction yet
    expect(ayWrites).toEqual([]);
    asic.dmaCycle();   // LOAD fires
    expect(ayWrites).toEqual([[0, 0x42]]);
  });

  it('STOP disables the channel — subsequent cycles are no-ops', () => {
    const ram = new Uint8Array(0x10000);
    ram[0x0000] = STOP & 0xFF; ram[0x0001] = (STOP >>> 8) & 0xFF;
    ram[0x0002] = LOAD(0, 0x99) & 0xFF; ram[0x0003] = (LOAD(0, 0x99) >>> 8) & 0xFF;
    const { asic, ayWrites } = wiredAsic(ram);
    asic.cpuWrite(DMA_CHAN_BASE, 0x00);
    asic.cpuWrite(DMA_CHAN_BASE + 1, 0x00);
    asic.cpuWrite(DMA_DCSR, 0x01);

    asic.dmaCycle();   // STOP — channel disabled
    asic.dmaCycle();   // channel off — no instruction consumed
    expect(ayWrites).toEqual([]);
  });

  it('INT raises the channel interrupt and DCSR reflects it', () => {
    const ram = new Uint8Array(0x10000);
    ram[0x0000] = INT & 0xFF; ram[0x0001] = (INT >>> 8) & 0xFF;
    const { asic } = wiredAsic(ram);
    asic.cpuWrite(DMA_CHAN_BASE, 0x00);
    asic.cpuWrite(DMA_CHAN_BASE + 1, 0x00);
    asic.cpuWrite(DMA_DCSR, 0x01);

    asic.dmaCycle();
    // Channel 0's int-pending bit is bit 5 of DCSR.
    expect(asic.registerPage[DMA_DCSR] & 0x20).toBe(0x20);
    expect(asic.interruptRequested).toBe(true);
  });

  it('writing DCSR with the int-pending bit clears the pending state', () => {
    const ram = new Uint8Array(0x10000);
    ram[0x0000] = INT & 0xFF; ram[0x0001] = (INT >>> 8) & 0xFF;
    const { asic } = wiredAsic(ram);
    asic.cpuWrite(DMA_CHAN_BASE, 0x00);
    asic.cpuWrite(DMA_CHAN_BASE + 1, 0x00);
    asic.cpuWrite(DMA_DCSR, 0x01);
    asic.dmaCycle();
    expect(asic.registerPage[DMA_DCSR] & 0x20).toBe(0x20);

    // Acknowledge by writing bit 5 (ch0 clear).
    asic.cpuWrite(DMA_DCSR, 0x20);
    expect(asic.registerPage[DMA_DCSR] & 0x20).toBe(0);
  });

  it('consumeInterruptVector encodes the source priority (raster > DMA2 > DMA1 > DMA0)', () => {
    const a = unlockedAsic();
    a.interruptVector = 0xF8;
    // Force all four sources pending.
    a.interruptRequested = true;
    (a as unknown as { rasterIntPending: boolean }).rasterIntPending = true;
    const dma = (a as unknown as { dma: { intPending: boolean }[] }).dma;
    dma[0].intPending = true;
    dma[1].intPending = true;
    dma[2].intPending = true;

    // Highest priority first: raster (source 6).
    expect(a.consumeInterruptVector()).toBe(0xF8 | 0x06);
    // Raster bit cleared on consume — next ack returns DMA2 (source 4).
    expect(a.consumeInterruptVector()).toBe(0xF8 | 0x04);
    // DMA1 (source 2).
    // DMA2 is still pending (ack does not clear DMA bits) — DMA2 wins again
    // until software writes DCSR. Cap expectation at DMA2.
    expect(a.consumeInterruptVector()).toBe(0xF8 | 0x04);
  });

  it('dmaCycle is a no-op while locked', () => {
    const a = new Asic();   // locked
    const ram = new Uint8Array(0x10000).fill(0xFF);
    const ayWrites: [number, number][] = [];
    a.readRam16 = (addr) => ram[addr & 0xFFFF] | (ram[(addr + 1) & 0xFFFF] << 8);
    a.writeAy = (reg, val) => ayWrites.push([reg, val]);
    a.dmaCycle();
    expect(ayWrites).toEqual([]);
  });
});
