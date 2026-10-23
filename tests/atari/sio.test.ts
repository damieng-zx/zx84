/**
 * Native SIO tests: the DCB handshake, sector transfers, error statuses, and
 * the machine trap that services the OS's SIO entry without the bit-level
 * serial routine.
 *
 * Status codes are the OS's: 1 done, 138 timeout (no device answered),
 * 139 NAK (command refused), 144 device error (the drive answered but
 * failed). The bus ID is DDEVIC + DUNIT - 1, as the OS's SIO forms it.
 */

import { describe, it, expect } from 'vitest';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';
import { ATR_HEADER_SIZE, ATR_MAGIC } from '@/media/floppy/atr.ts';
import { ATARI_OS_SIZE, ATARI_XL_OS_SIZE } from '@/machines/atari/models.ts';

function makeAtr(): Uint8Array {
  const sectors = 720;
  const atr = new Uint8Array(ATR_HEADER_SIZE + sectors * 128);
  atr[0] = ATR_MAGIC & 0xff;
  atr[1] = ATR_MAGIC >> 8;
  const paragraphs = (sectors * 128) >> 4;
  atr[2] = paragraphs & 0xff;
  atr[3] = (paragraphs >> 8) & 0xff;
  atr[4] = 128;
  for (let n = 1; n <= sectors; n++) {
    atr.fill(n & 0xff, ATR_HEADER_SIZE + (n - 1) * 128, ATR_HEADER_SIZE + n * 128);
  }
  return atr;
}

function makeMachine(): AtariMachine {
  const m = new AtariMachine('atari800', null);
  m.services.disks.insert('a', makeAtr(), 'test.atr');
  return m;
}

interface Dcb {
  device?: number;
  unit?: number;
  command: number;
  buffer: number;
  length: number;
  sector?: number;
}

function setDcb(m: AtariMachine, dcb: Dcb): void {
  const w = (addr: number, value: number) => m.memory.writeByte(addr, value);
  w(0x0300, dcb.device ?? 0x31);
  w(0x0301, dcb.unit ?? 1);
  w(0x0302, dcb.command);
  w(0x0304, dcb.buffer & 0xff);
  w(0x0305, (dcb.buffer >> 8) & 0xff);
  w(0x0308, dcb.length & 0xff);
  w(0x0309, (dcb.length >> 8) & 0xff);
  w(0x030a, (dcb.sector ?? 0) & 0xff);
  w(0x030b, ((dcb.sector ?? 0) >> 8) & 0xff);
  w(0x0303, 0);
}

/** Fake the stack so the SIO return can be observed (PC 0x1200). */
function callSio(m: AtariMachine): void {
  m.cpu.sp = 0xfd;
  m.memory.writeByte(0x01fe, 0xff);
  m.memory.writeByte(0x01ff, 0x11);
  m.sio.handle();
}

describe('atari native SIO', () => {
  it('answers STATUS with the drive status block', () => {
    const m = makeMachine();
    try {
      setDcb(m, { command: 0x53, buffer: 0x4000, length: 4 });
      callSio(m);
      expect(m.memory.readByte(0x0303)).toBe(0x01);
      expect(m.memory.readByte(0x4000)).toBe(0x00);
      expect(m.memory.readByte(0x4002)).toBe(0xe0); // timeout
      expect(m.cpu.pc).toBe(0x1200);
    } finally {
      m.destroy();
    }
  });

  it('reads a sector into the DCB buffer and reports the length', () => {
    const m = makeMachine();
    try {
      setDcb(m, { command: 0x52, buffer: 0x4000, length: 128, sector: 19 });
      callSio(m);
      expect(m.memory.readByte(0x0303)).toBe(0x01);
      // The OS returns the status in Y and STATUS ($30), N clear on success.
      expect(m.cpu.y).toBe(0x01);
      expect(m.memory.readByte(0x0030)).toBe(0x01);
      expect(m.cpu.p & 0x80).toBe(0);
      expect(m.cpu.p & 0x02).toBe(0);
      expect(m.memory.readByte(0x4000)).toBe(19);
      expect(m.memory.readByte(0x407f)).toBe(19);
      expect(m.memory.readByte(0x0308)).toBe(128);
    } finally {
      m.destroy();
    }
  });

  it('writes a sector from the DCB buffer', () => {
    const m = makeMachine();
    try {
      for (let i = 0; i < 128; i++) m.memory.writeByte(0x4000 + i, 0x99);
      setDcb(m, { command: 0x57, buffer: 0x4000, length: 128, sector: 6 });
      callSio(m);
      expect(m.memory.readByte(0x0303)).toBe(0x01);
      expect(m.services.disks.readSector(0x31, 6)![0]).toBe(0x99);
    } finally {
      m.destroy();
    }
  });

  it('times out on an empty drive, as if it were switched off', () => {
    // A drive that is on with no disk makes the OS print BOOT ERROR forever;
    // an empty drive is modelled as off so a diskless machine boots.
    const m = new AtariMachine('atari800', null);
    try {
      setDcb(m, { command: 0x52, buffer: 0x4000, length: 128, sector: 1 });
      m.cpu.p &= ~0x80;
      callSio(m);
      expect(m.memory.readByte(0x0303)).toBe(0x8a);
      expect(m.cpu.pc).toBe(0x1200); // still returns to the caller
      // An error comes back negative so the caller's BMI takes it.
      expect(m.cpu.y).toBe(0x8a);
      expect(m.cpu.p & 0x80).toBe(0x80);
    } finally {
      m.destroy();
    }
  });

  it('rejects a write to a protected disk', () => {
    const m = makeMachine();
    try {
      m.services.disks.setWriteProtect('a', true);
      setDcb(m, { command: 0x57, buffer: 0x4000, length: 128, sector: 1 });
      callSio(m);
      expect(m.memory.readByte(0x0303)).toBe(0x90); // device error 144
      expect(m.services.disks.readSector(0x31, 1)![0]).toBe(1);
    } finally {
      m.destroy();
    }
  });

  it('addresses D2: as DDEVIC $31 with DUNIT 2', () => {
    const m = makeMachine();
    try {
      m.services.disks.insert('b', makeAtr(), 'two.atr');
      m.services.disks.writeSector(0x32, 5, new Uint8Array(128).fill(0x22));
      setDcb(m, { unit: 2, command: 0x52, buffer: 0x4000, length: 128, sector: 5 });
      callSio(m);
      expect(m.memory.readByte(0x4000)).toBe(0x22);
    } finally {
      m.destroy();
    }
  });

  it('times out for a device that is not there (D3:)', () => {
    const m = makeMachine();
    try {
      setDcb(m, { unit: 3, command: 0x53, buffer: 0x4000, length: 4 });
      callSio(m);
      expect(m.memory.readByte(0x0303)).toBe(0x8a);
    } finally {
      m.destroy();
    }
  });

  it('rejects an unknown command', () => {
    const m = makeMachine();
    try {
      setDcb(m, { command: 0x42, buffer: 0x4000, length: 4 });
      callSio(m);
      expect(m.memory.readByte(0x0303)).toBe(0x8b);
    } finally {
      m.destroy();
    }
  });
});

describe('atari native SIO: transfer length and sector numbers', () => {
  it('refuses sector 0 and a sector past the end with a NAK, before any data moves', () => {
    const m = makeMachine();
    try {
      for (const sector of [0, 721, 0xffff]) {
        for (const command of [0x52, 0x57, 0x50, 0x56]) {
          m.memory.writeByte(0x4000, 0x77);
          setDcb(m, { command, buffer: 0x4000, length: 128, sector });
          callSio(m);
          expect(m.memory.readByte(0x0303)).toBe(0x8b);
        }
      }
      expect(m.memory.readByte(0x4000)).toBe(0x77);
      // The last real sector still reads.
      setDcb(m, { command: 0x52, buffer: 0x4000, length: 128, sector: 720 });
      callSio(m);
      expect(m.memory.readByte(0x0303)).toBe(0x01);
    } finally {
      m.destroy();
    }
  });

  it('times out a read whose DBYT is longer than the sector the drive sends', () => {
    const m = makeMachine();
    try {
      setDcb(m, { command: 0x52, buffer: 0x4000, length: 256, sector: 19 });
      callSio(m);
      expect(m.memory.readByte(0x0303)).toBe(0x8a);
      expect(m.memory.readByte(0x4000)).toBe(19); // what arrived is in the buffer
      expect(m.memory.readByte(0x0308)).toBe(0);  // DBYT is left as the caller set it
      expect(m.memory.readByte(0x0309)).toBe(1);
    } finally {
      m.destroy();
    }
  });

  it('reports a checksum error when DBYT is shorter than the sector the drive sends', () => {
    const m = makeMachine();
    try {
      m.memory.writeByte(0x4000 + 64, 0x55);
      setDcb(m, { command: 0x52, buffer: 0x4000, length: 64, sector: 19 });
      callSio(m);
      expect(m.memory.readByte(0x0303)).toBe(0x8f);
      expect(m.memory.readByte(0x4000 + 63)).toBe(19);
      expect(m.memory.readByte(0x4000 + 64)).toBe(0x55); // nothing past DBYT was written
    } finally {
      m.destroy();
    }
  });

  it('judges a write by its data frame: short times out, long is NAKed, and nothing is written', () => {
    const m = makeMachine();
    try {
      for (let i = 0; i < 256; i++) m.memory.writeByte(0x4000 + i, 0x99);
      setDcb(m, { command: 0x57, buffer: 0x4000, length: 64, sector: 6 });
      callSio(m);
      expect(m.memory.readByte(0x0303)).toBe(0x8a);
      setDcb(m, { command: 0x57, buffer: 0x4000, length: 256, sector: 6 });
      callSio(m);
      expect(m.memory.readByte(0x0303)).toBe(0x8b);
      expect(m.services.disks.readSector(0x31, 6)![0]).toBe(6);
    } finally {
      m.destroy();
    }
  });
});

describe('atari SIO call leaves the OS state a real one does', () => {
  it('sets the checksum-sent and timeout flags, clears CRITIC and defaults the timer-1 routine', () => {
    const m = makeMachine();
    try {
      m.memory.writeByte(0x003b, 0);       // CHKSNT
      m.memory.writeByte(0x0042, 1);       // CRITIC
      m.memory.writeByte(0x0226, 0); m.memory.writeByte(0x0227, 0); // CDTMA1
      setDcb(m, { command: 0x52, buffer: 0x4000, length: 128, sector: 19 });
      callSio(m);
      expect(m.memory.readByte(0x003b)).toBe(0xff);
      expect(m.memory.readByte(0x0042)).toBe(0);
      expect(m.memory.readByte(0x0317)).toBe(1);   // TIMFLG: no timeout
      expect(m.memory.readByte(0x0226)).toBe(0xc0);
      expect(m.memory.readByte(0x0227)).toBe(0xe4);
      // A routine the program installed is left alone.
      m.memory.writeByte(0x0226, 0x34); m.memory.writeByte(0x0227, 0x12);
      setDcb(m, { command: 0x52, buffer: 0x4000, length: 128, sector: 19 });
      callSio(m);
      expect(m.memory.readByte(0x0226)).toBe(0x34);
      expect(m.memory.readByte(0x0227)).toBe(0x12);
    } finally {
      m.destroy();
    }
  });

  it('clears TIMFLG on a timeout', () => {
    const m = makeMachine();
    try {
      setDcb(m, { unit: 3, command: 0x53, buffer: 0x4000, length: 4 });  // D3: is not there
      callSio(m);
      expect(m.memory.readByte(0x0303)).toBe(0x8a);
      expect(m.memory.readByte(0x0317)).toBe(0);
    } finally {
      m.destroy();
    }
  });

  it('puts channels 3 and 4 back at 19200 baud with asynchronous receive after a disk call', () => {
    const m = makeMachine();
    try {
      m.memory.writeByte(0x0232, 0x03);
      m.pokey.writeReg(0x04, 0x99);
      setDcb(m, { command: 0x52, buffer: 0x4000, length: 128, sector: 19 });
      callSio(m);
      expect(m.memory.readByte(0x0232)).toBe(0x13);   // SSKCTL
      expect(m.pokey.skctl).toBe(0x13);
      expect(m.pokey.audf[2]).toBe(0x28);
      expect(m.pokey.audf[3]).toBe(0x00);
    } finally {
      m.destroy();
    }
  });

  it('leaves the serial setup alone for the program recorder', () => {
    const m = new AtariMachine('atari800', null);
    try {
      m.pokey.writeReg(0x04, 0x99);
      m.pokey.writeReg(0x0f, 0x03);
      setDcb(m, { device: 0x60, unit: 0, command: 0x52, buffer: 0x4000, length: 131 });
      callSio(m);
      expect(m.pokey.audf[2]).toBe(0x99);
      expect(m.pokey.skctl).toBe(0x03);
    } finally {
      m.destroy();
    }
  });

  it('returns with carry cleared for a failure below $8A, set otherwise, with A 0 and X $FE', () => {
    const m = makeMachine();
    try {
      m.cpu.p |= 0x01;
      setDcb(m, { command: 0x52, buffer: 0x4000, length: 128, sector: 19 });
      callSio(m);
      expect(m.cpu.p & 0x01).toBe(1);                      // success: $01
      expect([m.cpu.a, m.cpu.x]).toEqual([0, 0xfe]);
      setDcb(m, { command: 0x57, buffer: 0x4000, length: 256, sector: 19 });
      callSio(m);                                          // long write: NAK, $8B
      expect(m.cpu.p & 0x01).toBe(1);
      m.services.disks.setWriteProtect('a', true);
      setDcb(m, { command: 0x57, buffer: 0x4000, length: 128, sector: 19 });
      callSio(m);                                          // write protect: device error $90
      expect(m.memory.readByte(0x0303)).toBe(0x90);
      expect(m.cpu.p & 0x01).toBe(1);
    } finally {
      m.destroy();
    }
  });

  it('is left to the OS when the buffer covers TIMFLG, or BREAK has been pressed', () => {
    const m = makeMachine();
    try {
      m.memory.writeByte(0x0011, 1);
      setDcb(m, { command: 0x52, buffer: 0x4000, length: 128, sector: 19 });
      expect(m.sio.claims()).toBe(true);
      setDcb(m, { command: 0x52, buffer: 0x0300, length: 128, sector: 19 });   // $0300-$037F holds $0317
      expect(m.sio.claims()).toBe(false);
      setDcb(m, { command: 0x52, buffer: 0x0318, length: 128, sector: 19 });   // starts past it
      expect(m.sio.claims()).toBe(true);
      m.memory.writeByte(0x0011, 0);                                           // BREAK pressed
      expect(m.sio.claims()).toBe(false);
    } finally {
      m.destroy();
    }
  });
});

describe('atari SIO trap', () => {
  it('services a JSR to the OS SIO entry and returns to the next instruction', () => {
    const m = new AtariMachine('atari800', null);
    const rom = new Uint8Array(ATARI_OS_SIZE);
    // $E000: JSR SIOV ($E459) ; LDA #$42 ; STA $10 ; JMP $E007
    rom.set([0x20, 0x59, 0xe4, 0xa9, 0x42, 0x85, 0x10, 0x4c, 0x07, 0xe0], 0x800);
    rom[0x27fc] = 0x00;
    rom[0x27fd] = 0xe0;
    try {
      m.services.roms.installSystemRom(rom);
      m.services.disks.insert('a', makeAtr(), 'test.atr');
      m.reset();
      m.setSpeedMultiplier(0);
      m.memory.writeByte(0x0011, 1); // BRKKEY: no BREAK pending, as the OS leaves it
      setDcb(m, { command: 0x52, buffer: 0x3000, length: 128, sector: 3 });
      m.tick();
      expect(m.memory.readByte(0x0010)).toBe(0x42);
      expect(m.memory.readByte(0x3000)).toBe(3);
      expect(m.memory.readByte(0x0303)).toBe(0x01);
    } finally {
      m.destroy();
    }
  });

  it('leaves $E459 alone when an XL has its OS ROM switched out', () => {
    // With PORTB bit 0 clear the RAM under the OS shows, and a program
    // (Turbo-BASIC XL) can keep its own code there.
    const m = new AtariMachine('atari800xl', null);
    try {
      m.services.roms.installSystemRom(new Uint8Array(ATARI_XL_OS_SIZE));
      m.services.disks.insert('a', makeAtr(), 'test.atr');
      m.reset();
      m.setSpeedMultiplier(0);
      m.memory.setPortB(0xfe);
      // $E459 (RAM): LDA #$77 ; STA $11 ; RTS
      [0xa9, 0x77, 0x85, 0x11, 0x60].forEach((b, i) => m.memory.writeByte(0xe459 + i, b));
      // $0600: JSR $E459 ; LDA #$42 ; STA $10 ; JMP $0607
      [0x20, 0x59, 0xe4, 0xa9, 0x42, 0x85, 0x10, 0x4c, 0x07, 0x06].forEach((b, i) => m.memory.writeByte(0x0600 + i, b));
      setDcb(m, { command: 0x52, buffer: 0x3000, length: 128, sector: 3 });
      m.cpu.pc = 0x0600;
      m.tick();
      expect(m.memory.readByte(0x0011)).toBe(0x77); // the RAM code ran
      expect(m.memory.readByte(0x0010)).toBe(0x42);
      expect(m.memory.readByte(0x3000)).toBe(0);    // no sector was read
    } finally {
      m.destroy();
    }
  });
});
