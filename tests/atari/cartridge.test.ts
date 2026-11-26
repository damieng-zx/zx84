/**
 * Atari cartridge boards: XEGS 32/64/128K and Bounty Bob's 40K.
 *
 * Expectations come from the hardware descriptions in the Atari800
 * documentation (DOC/cart.txt), not from this implementation:
 *
 *  - XEGS 32K is four 8K banks; the last is fixed at $A000-$BFFF and the low
 *    two bits of the byte written to $D500-$D5FF choose the bank at
 *    $8000-$9FFF. 64K adds a third bit (eight banks, bank 7 fixed) and 128K a
 *    fourth (sixteen banks, bank 15 fixed). A read of $D5xx does not switch.
 *  - Bounty Bob 40K maps four 4K banks at $8000-$8FFF and four at
 *    $9000-$9FFF, plus its remaining 8K at $A000-$BFFF. An access to
 *    $8FF6-$8FF9 picks the lower 4K bank 0-3 and $9FF6-$9FF9 the upper 4-7.
 *  - A `.car` header names the board: 12 = XEGS 32K, 13 = 64K, 14 = 128K,
 *    18 = Bounty Bob 40K.
 */

import { describe, it, expect } from 'vitest';
import { AtariCartridge, parseCartridge } from '@/machines/atari/cartridge.ts';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';

/** An image whose 8K bank `b` is filled with `b`, so a read names the bank. */
function xegsImage(banks: number): Uint8Array {
  const image = new Uint8Array(banks * 0x2000);
  for (let b = 0; b < banks; b++) image.fill(b, b * 0x2000, (b + 1) * 0x2000);
  return image;
}

/** A `.car` wrapper: a 16-byte header whose bytes 4-7 hold the type. */
function car(type: number, image: Uint8Array): Uint8Array {
  const data = new Uint8Array(16 + image.length);
  data.set([0x43, 0x41, 0x52, 0x54]); // "CART"
  new DataView(data.buffer).setUint32(4, type);
  data.set(image, 16);
  return data;
}

/** Put a cartridge's boot vectors at the end of an 8K bank. */
function vectorsAt(image: Uint8Array, end: number, run: number): void {
  image.set([run & 0xFF, run >> 8, 0x00, 0x04, run & 0xFF, run >> 8], end - 6);
}

/** A Bounty Bob image: 4K bank `b` (0-7) filled with `b`, then 8K of $77. */
function bountyBobImage(): Uint8Array {
  const image = new Uint8Array(0xa000);
  for (let b = 0; b < 8; b++) image.fill(b, b * 0x1000, (b + 1) * 0x1000);
  image.fill(0x77, 0x8000);
  return image;
}

describe('atari cartridge identification', () => {
  it('reads a headerless 32K, 64K, 128K or 40K dump as its XEGS / Bounty Bob board', () => {
    expect(parseCartridge(xegsImage(4))).toMatchObject({ type: 'xegs32' });
    const xegs64 = xegsImage(8);
    vectorsAt(xegs64, 0x10000, 0xbc00);
    expect(parseCartridge(xegs64)).toMatchObject({ type: 'xegs64' });
    expect(parseCartridge(xegsImage(16))).toMatchObject({ type: 'xegs128' });
    expect(parseCartridge(bountyBobImage())).toMatchObject({ type: 'bb40' });
  });

  it('tells a headerless 64K Williams cart from an XEGS one by where it boots', () => {
    const williams = xegsImage(8);
    vectorsAt(williams, 0x2000, 0xa000);
    expect(parseCartridge(williams)).toMatchObject({ type: 'will64' });
    const xegs = xegsImage(8);
    vectorsAt(xegs, 0x10000, 0xbc00);
    expect(parseCartridge(xegs)).toMatchObject({ type: 'xegs64' });
  });

  it('takes the board from a .car header', () => {
    expect(parseCartridge(car(8, xegsImage(8)))).toMatchObject({ type: 'will64' });
    expect(parseCartridge(car(12, xegsImage(4)))).toMatchObject({ type: 'xegs32' });
    expect(parseCartridge(car(13, xegsImage(8)))).toMatchObject({ type: 'xegs64' });
    expect(parseCartridge(car(14, xegsImage(16)))).toMatchObject({ type: 'xegs128' });
    expect(parseCartridge(car(18, bountyBobImage()))).toMatchObject({ type: 'bb40' });
  });

  it('rejects an image no board in the list carries', () => {
    const parsed = parseCartridge(new Uint8Array(0x6000));
    expect('error' in parsed && parsed.error).toContain('4K, 8K, 16K, 32K, 40K, 64K or 128K');
  });
});

describe('atari XEGS cartridges', () => {
  it('32K: the last 8K bank stays at $A000, the written value picks the lower bank', () => {
    const cart = new AtariCartridge('xegs32', xegsImage(4));
    expect([cart.read(0x8000), cart.read(0x9fff)]).toEqual([0, 0]);
    expect([cart.read(0xa000), cart.read(0xbfff)]).toEqual([3, 3]);

    cart.control(0xd500, true, 1);
    expect(cart.read(0x8000)).toBe(1);
    expect(cart.read(0xa000)).toBe(3);

    // All two bits count, so bank 3 may also sit at $8000.
    cart.control(0xd5aa, true, 3);
    expect(cart.read(0x8000)).toBe(3);
    expect(cart.read(0xa000)).toBe(3);
  });

  it('64K: three bits pick one of eight banks; bank 7 is fixed', () => {
    const cart = new AtariCartridge('xegs64', xegsImage(8));
    cart.control(0xd500, true, 5);
    expect(cart.read(0x8000)).toBe(5);
    expect(cart.read(0xa000)).toBe(7);
    // Bits above the bank count do not leak into the bank number.
    cart.control(0xd500, true, 0xfe);
    expect(cart.read(0x8000)).toBe(6);
  });

  it('128K: four bits pick one of sixteen banks; bank 15 is fixed', () => {
    const cart = new AtariCartridge('xegs128', xegsImage(16));
    cart.control(0xd500, true, 9);
    expect(cart.read(0x8000)).toBe(9);
    expect(cart.read(0xa000)).toBe(15);
  });

  it('switches on a write only: a read of $D5xx leaves the bank alone', () => {
    const cart = new AtariCartridge('xegs32', xegsImage(4));
    cart.control(0xd501, true, 2);
    cart.control(0xd500, false, 1);
    expect(cart.read(0x8000)).toBe(2);
  });
});

describe('atari Williams 64K cartridge', () => {
  it('maps all eight 8K banks at $A000; the access address picks the bank', () => {
    const cart = new AtariCartridge('will64', xegsImage(8));
    expect(cart.read(0xa000)).toBe(0);
    cart.control(0xd503, true, 0);
    expect(cart.read(0xa000)).toBe(3);
    expect(cart.read(0xbfff)).toBe(3);
    // Reads switch this board too: the address carries the bank number.
    cart.control(0xd505, false, 0);
    expect(cart.read(0xa000)).toBe(5);
  });

  it('is uncovered by an access to $D508-$D50F', () => {
    const cart = new AtariCartridge('will64', xegsImage(8));
    cart.control(0xd508, true, 0);
    expect(cart.enabled).toBe(false);
    expect(cart.read(0xa000)).toBe(-1);
    cart.control(0xd500, true, 0);
    expect(cart.enabled).toBe(true);
    expect(cart.read(0xa000)).toBe(0);
  });
});

describe('atari Bounty Bob 40K cartridge', () => {
  it('maps the 4K banks at $8000/$9000 and the last 8K at $A000', () => {
    const cart = new AtariCartridge('bb40', bountyBobImage());
    expect(cart.read(0x8000)).toBe(0);
    expect(cart.read(0x8fff)).toBe(0);
    expect(cart.read(0x9000)).toBe(4);
    expect(cart.read(0x9fff)).toBe(4);
    expect(cart.read(0xa000)).toBe(0x77);
    expect(cart.read(0xbfff)).toBe(0x77);
  });

  it('an access to $8FF6-$8FF9 or $9FF6-$9FF9 selects that 4K bank', () => {
    const cart = new AtariCartridge('bb40', bountyBobImage());
    cart.read(0x8ff7);
    expect(cart.read(0x8000)).toBe(1);
    expect(cart.read(0x9000)).toBe(4); // the upper window is independent
    cart.read(0x9ff8);
    expect(cart.read(0x9000)).toBe(6);
    expect(cart.read(0x8000)).toBe(1);
    cart.read(0x8ff6);
    expect(cart.read(0x8000)).toBe(0);
  });
});

describe('atari cartridge bank switching through the machine bus', () => {
  it('an XEGS write switches the bank; a read does not', () => {
    const m = new AtariMachine('atari800xl', null);
    try {
      m.memory.insertCart(xegsImage(4));
      expect(m.memory.readByte(0xa000)).toBe(3);
      m.memory.writeByte(0xd500, 2);
      expect(m.memory.readByte(0x8000)).toBe(2);
      m.memory.readByte(0xd501);
      expect(m.memory.readByte(0x8000)).toBe(2);
    } finally {
      m.destroy();
    }
  });

  it('a debugger peek of Bounty Bob never switches a bank', () => {
    const m = new AtariMachine('atari800xl', null);
    try {
      m.memory.insertCart(bountyBobImage());
      expect(m.memory.peekByte(0x8ff7)).toBe(0);
      expect(m.memory.readByte(0x8000)).toBe(0);
      expect(m.memory.readByte(0x8ff7)).toBe(1); // a real access does switch
      expect(m.memory.readByte(0x8000)).toBe(1);
    } finally {
      m.destroy();
    }
  });
});
