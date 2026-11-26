/**
 * Atari cartridge boards: the bank-switched families beyond the original
 * 4K/8K/16K and OSS carts.
 *
 * Expectations come from the hardware descriptions in the Atari800
 * documentation (DOC/cart.txt), not from this implementation:
 *
 *  - XEGS 32K is four 8K banks; the last is fixed at $A000-$BFFF and the low
 *    two bits of the byte written to $D500-$D5FF choose the bank at
 *    $8000-$9FFF. 64K adds a third bit (eight banks, bank 7 fixed) and 128K a
 *    fourth (sixteen banks, bank 15 fixed). A read of $D5xx does not switch.
 *  - Williams 32/64K maps four/eight 8K banks at $A000, selected by the low
 *    address bits ($D500-$D503 / $D507), and $D508-$D50F uncovers RAM.
 *  - DB 32K is the XEGS layout selected by the address instead of the value:
 *    the low two bits pick the $8000 bank and bank 3 stays at $A000.
 *  - Express 64K ($D570-$D57F), Diamond 64K ($D5D0-$D5DF) and SpartaDOS X 64K
 *    ($D5E0-$D5EF) count banks down from the top of their control page; SDX
 *    128K adds a second page ($D5F0-$D5FF) for banks 0-7, with the low page
 *    holding banks 8-15.
 *  - Atarimax 128K selects banks 0-15 through $D500-$D50F and is uncovered by
 *    $D510-$D51F; $D520-$D5FF is ignored.
 *  - MegaCart holds 16K banks at $8000; the written value's low bits pick the
 *    bank and bit 7 uncovers RAM.
 *  - Bounty Bob 40K maps four 4K banks at $8000-$8FFF and four at
 *    $9000-$9FFF, plus its remaining 8K at $A000-$BFFF. An access to
 *    $8FF6-$8FF9 picks the lower 4K bank 0-3 and $9FF6-$9FF9 the upper 4-7.
 *  - A `.car` header names the board.
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

/** A MegaCart image: 16K bank `b` filled with `b`. */
function megaImage(banks: number): Uint8Array {
  const image = new Uint8Array(banks * 0x4000);
  for (let b = 0; b < banks; b++) image.fill(b, b * 0x4000, (b + 1) * 0x4000);
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
    expect(parseCartridge(car(5, xegsImage(4)))).toMatchObject({ type: 'db32' });
    expect(parseCartridge(car(8, xegsImage(8)))).toMatchObject({ type: 'will64' });
    expect(parseCartridge(car(9, xegsImage(8)))).toMatchObject({ type: 'express64' });
    expect(parseCartridge(car(10, xegsImage(8)))).toMatchObject({ type: 'diamond64' });
    expect(parseCartridge(car(11, xegsImage(8)))).toMatchObject({ type: 'sdx64' });
    expect(parseCartridge(car(22, xegsImage(4)))).toMatchObject({ type: 'will32' });
    expect(parseCartridge(car(26, megaImage(1)))).toMatchObject({ type: 'mega16' });
    expect(parseCartridge(car(27, megaImage(2)))).toMatchObject({ type: 'mega32' });
    expect(parseCartridge(car(28, megaImage(4)))).toMatchObject({ type: 'mega64' });
    expect(parseCartridge(car(32, megaImage(64)))).toMatchObject({ type: 'mega1024' });
    expect(parseCartridge(car(41, xegsImage(16)))).toMatchObject({ type: 'atarimax128' });
    expect(parseCartridge(car(43, xegsImage(16)))).toMatchObject({ type: 'sdx128' });
    expect(parseCartridge(car(12, xegsImage(4)))).toMatchObject({ type: 'xegs32' });
    expect(parseCartridge(car(13, xegsImage(8)))).toMatchObject({ type: 'xegs64' });
    expect(parseCartridge(car(14, xegsImage(16)))).toMatchObject({ type: 'xegs128' });
    expect(parseCartridge(car(18, bountyBobImage()))).toMatchObject({ type: 'bb40' });
  });

  it('finds the control page of a headerless 64K $A000 board', () => {
    const sdx = new Uint8Array(0x10000);
    sdx.set([0x8d, 0xe0, 0xd5], 0); // STA $D5E0
    expect(parseCartridge(sdx)).toMatchObject({ type: 'sdx64' });
    const express = new Uint8Array(0x10000);
    express.set([0x8d, 0x77, 0xd5], 0); // STA $D577
    expect(parseCartridge(express)).toMatchObject({ type: 'express64' });
    const diamond = new Uint8Array(0x10000);
    diamond.set([0x8d, 0xd7, 0xd5], 0); // STA $D5D7
    expect(parseCartridge(diamond)).toMatchObject({ type: 'diamond64' });
  });

  it('finds a headerless 128K SDX or Atarimax board', () => {
    const sdx = new Uint8Array(0x20000);
    sdx.set([0x8d, 0xe7, 0xd5], 0); // STA $D5E7
    expect(parseCartridge(sdx)).toMatchObject({ type: 'sdx128' });
    const atarimax = new Uint8Array(0x20000);
    vectorsAt(atarimax, 0x2000, 0xa000);
    expect(parseCartridge(atarimax)).toMatchObject({ type: 'atarimax128' });
  });

  it('finds a headerless 32K DB or Williams board by its vectors', () => {
    const db = new Uint8Array(0x8000);
    db.set([0x8d, 0x01, 0xd5], 0); // STA $D501: address-decoded
    vectorsAt(db, 0x8000, 0xa000); // bank 3 fixed at $A000
    expect(parseCartridge(db)).toMatchObject({ type: 'db32' });
    const williams = new Uint8Array(0x8000);
    williams.set([0x8d, 0x01, 0xd5], 0);
    vectorsAt(williams, 0x2000, 0xa000); // bank 0 at $A000
    expect(parseCartridge(williams)).toMatchObject({ type: 'will32' });
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

describe('atari Williams 32K, DB 32K and the $A000 control-page boards', () => {
  it('Williams 32K: four 8K banks at $A000, $D508-$D50F uncovers RAM', () => {
    const cart = new AtariCartridge('will32', xegsImage(4));
    expect(cart.read(0xa000)).toBe(0);
    cart.control(0xd502, true, 0);
    expect(cart.read(0xa000)).toBe(2);
    cart.control(0xd503, true, 0);
    expect(cart.read(0xbfff)).toBe(3);
    cart.control(0xd508, true, 0);
    expect(cart.enabled).toBe(false);
    expect(cart.read(0xa000)).toBe(-1);
  });

  it('DB 32K: the address bits pick the $8000 bank and bank 3 stays at $A000', () => {
    const cart = new AtariCartridge('db32', xegsImage(4));
    cart.control(0xd501, true, 0);
    expect(cart.read(0x8000)).toBe(1);
    expect(cart.read(0xa000)).toBe(3);
    cart.control(0xd502, true, 0);
    expect(cart.read(0x9fff)).toBe(2);
  });

  it('Express 64K: $D577 = bank 0 down to $D570 = bank 7', () => {
    const cart = new AtariCartridge('express64', xegsImage(8));
    cart.control(0xd577, true, 0);
    expect(cart.read(0xa000)).toBe(0);
    cart.control(0xd570, true, 0);
    expect(cart.read(0xa000)).toBe(7);
    cart.control(0xd578, true, 0);
    expect(cart.enabled).toBe(false);
  });

  it('Diamond 64K: $D5D7 = bank 0 down to $D5D0 = bank 7', () => {
    const cart = new AtariCartridge('diamond64', xegsImage(8));
    cart.control(0xd5d7, true, 0);
    expect(cart.read(0xa000)).toBe(0);
    cart.control(0xd5d0, true, 0);
    expect(cart.read(0xa000)).toBe(7);
    cart.control(0xd5d8, true, 0);
    expect(cart.enabled).toBe(false);
  });

  it('SpartaDOS X 64K: $D5E7 = bank 0 down to $D5E0 = bank 7; $D5E8 off', () => {
    const cart = new AtariCartridge('sdx64', xegsImage(8));
    cart.control(0xd5e7, true, 0);
    expect(cart.read(0xa000)).toBe(0);
    cart.control(0xd5e0, true, 0);
    expect(cart.read(0xa000)).toBe(7);
    cart.control(0xd5e8, true, 0);
    expect(cart.enabled).toBe(false);
    expect(cart.read(0xa000)).toBe(-1);
  });

  it('SpartaDOS X 128K: $D5F7-$D5F0 = banks 0-7, $D5E7-$D5E0 = banks 8-15', () => {
    const cart = new AtariCartridge('sdx128', xegsImage(16));
    cart.control(0xd5f7, true, 0);
    expect(cart.read(0xa000)).toBe(0);
    cart.control(0xd5f0, true, 0);
    expect(cart.read(0xa000)).toBe(7);
    cart.control(0xd5e7, true, 0);
    expect(cart.read(0xa000)).toBe(8);
    cart.control(0xd5e0, true, 0);
    expect(cart.read(0xa000)).toBe(15);
    cart.control(0xd5e8, true, 0);
    expect(cart.enabled).toBe(false);
  });

  it('Atarimax 128K: $D500-$D50F banks, $D510-$D51F off, $D520+ ignored', () => {
    const cart = new AtariCartridge('atarimax128', xegsImage(16));
    cart.control(0xd50a, true, 0);
    expect(cart.read(0xa000)).toBe(10);
    cart.control(0xd510, true, 0);
    expect(cart.enabled).toBe(false);
    cart.control(0xd520, true, 0); // ignored: the cart stays off
    expect(cart.enabled).toBe(false);
    cart.control(0xd505, true, 0); // a bank write brings it back
    expect(cart.read(0xa000)).toBe(5);
  });
});

describe('atari MegaCart', () => {
  it('holds 16K banks at $8000; the written value picks the bank', () => {
    const cart = new AtariCartridge('mega64', megaImage(4));
    cart.control(0xd500, true, 2);
    expect(cart.read(0x8000)).toBe(2);
    expect(cart.read(0xbfff)).toBe(2);
    cart.control(0xd501, true, 3);
    expect(cart.read(0x8000)).toBe(3);
  });

  it('bit 7 of the written value uncovers RAM, and reads never switch', () => {
    const cart = new AtariCartridge('mega64', megaImage(4));
    cart.control(0xd500, true, 0x81);
    expect(cart.enabled).toBe(false);
    expect(cart.read(0x8000)).toBe(-1);
    cart.control(0xd500, true, 1); // a later write re-enables it
    expect(cart.read(0x8000)).toBe(1);
    cart.control(0xd500, false, 2); // a read carries no value
    expect(cart.read(0x8000)).toBe(1);
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

  it('a SpartaDOS X write switches its $A000 bank', () => {
    const m = new AtariMachine('atari800xl', null);
    try {
      m.memory.insertCart(car(11, xegsImage(8)));
      expect(m.memory.readByte(0xa000)).toBe(0);
      m.memory.writeByte(0xd5e0, 0);
      expect(m.memory.readByte(0xa000)).toBe(7);
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
