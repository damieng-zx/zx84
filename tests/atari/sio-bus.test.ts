/**
 * Bit-level SIO bus: the disk drives answering a program that drives POKEY's
 * serial port itself.
 *
 * Expectations come from the Atari SIO documentation, not from the code:
 *  - COMMAND asserted (PBCTL CB2 low, $34; released with $3C), then a five
 *    byte frame: device ($31 = D1:), command, AUX1, AUX2, checksum, the sum of
 *    the first four with every carry added back in;
 *  - the drive answers ACK 'A' ($41) or NAK 'N' ($4E) between 0.85 and 16 ms
 *    after COMMAND goes high; a device that is not there says nothing;
 *  - read-type commands then give COMPLETE 'C' ($43) (0.25 ms to 255 ms
 *    later) or ERROR 'E' ($45), and the data frame, data plus checksum;
 *  - a write-type command takes the computer's data frame after the ACK,
 *    acknowledges it, then completes;
 *  - bytes are 8N1 at 19200 baud, so ten bits (about 93 CPU cycles each) a
 *    byte; POKEY set up as the OS does for SIO: AUDCTL $28, AUDF3/4 $0028 (a
 *    47 cycle channel-4 period), SKCTL $13.
 */

import { describe, it, expect } from 'vitest';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';
import { ATR_HEADER_SIZE, ATR_MAGIC } from '@/media/floppy/atr.ts';

const CLOCK_HZ = 1_789_772;
const cyclesPerMs = CLOCK_HZ / 1000;

const ACK = 0x41;
const NAK = 0x4e;
const COMPLETE = 0x43;
const ERROR = 0x45;

/** SIO checksum: 8-bit sum with the carry added back in at each step. */
function checksum(bytes: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) {
    sum += bytes[i];
    if (sum > 0xff) sum = (sum & 0xff) + 1;
  }
  return sum;
}

/** A command frame for `device`, with a correct checksum. */
function frame(device: number, command: number, aux: number): number[] {
  const f = [device, command, aux & 0xff, aux >> 8];
  return [...f, checksum(f)];
}

/** A 720-sector single-density ATR; sector n holds the byte n & 0xFF. */
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

type Clocked = { clockChips(cycles: number): void };

/** The computer's side of the bus, driving the machine's POKEY directly. */
class Computer {
  /** Bytes the drive sent, with the CPU cycle each was received at. */
  readonly got: { byte: number; at: number }[] = [];
  /** Cycle at which COMMAND was last released. */
  released = 0;
  time = 0;

  constructor(readonly m: AtariMachine) {
    const p = m.pokey;
    p.writeReg(0x08, 0x28); // AUDCTL: channels 3+4 joined, channel 3 at 1.79 MHz
    p.writeReg(0x04, 0x28); // AUDF3
    p.writeReg(0x06, 0x00); // AUDF4: a 47 cycle period, 94 per bit (19040 baud)
    p.writeReg(0x0f, 0x13); // SKCTL: serial in/out clocked by channel 4
    p.writeReg(0x0a, 0x00); // SKRES
    p.writeReg(0x0e, 0x20); // IRQEN: serial input ready
  }

  /** Let `cycles` pass, collecting what arrives in SERIN. */
  step(cycles: number): void {
    const p = this.m.pokey;
    for (let left = cycles; left > 0; left -= 4) {
      const n = Math.min(4, left);
      (this.m as unknown as Clocked).clockChips(n);
      this.time += n;
      if ((p.readReg(0x0e) & 0x20) === 0) {
        this.got.push({ byte: p.readReg(0x0d), at: this.time });
        p.writeReg(0x0e, 0x00); // acknowledge by dropping and re-enabling
        p.writeReg(0x0e, 0x20);
      }
    }
  }

  ms(ms: number): void { this.step(Math.round(ms * cyclesPerMs)); }

  command(asserted: boolean): void {
    // PBCTL: CB2 output low = COMMAND asserted ($34), high = released ($3C).
    this.m.memory.writeByte(0xd303, asserted ? 0x34 : 0x3c);
    if (!asserted) this.released = this.time;
  }

  /** Send one byte and wait for POKEY to finish shifting it: first for
   *  "serial output ready" (IRQST bit 4, the byte has reached the shifter),
   *  then for "transmission complete" (bit 3, the shifter is idle again).
   *  Bit 3 alone is not enough: it reads complete until the shifter loads. */
  send(byte: number): void {
    const p = this.m.pokey;
    p.writeReg(0x0e, 0x30);
    p.writeReg(0x0d, byte);
    while ((p.readReg(0x0e) & 0x10) !== 0) this.step(4);
    p.writeReg(0x0e, 0x20);
    while ((p.readReg(0x0e) & 0x08) !== 0) this.step(4);
  }

  /** A command frame with COMMAND asserted around it. */
  sendCommand(bytes: number[]): void {
    this.command(true);
    this.ms(0.7);
    for (const b of bytes) this.send(b);
    this.ms(0.7);
    this.command(false);
  }

  /** A data frame: the bytes and their checksum. */
  sendData(bytes: ArrayLike<number>): void {
    for (let i = 0; i < bytes.length; i++) this.send(bytes[i]);
    this.send(checksum(bytes));
  }

  received(): number[] { return this.got.map(g => g.byte); }
  clear(): void { this.got.length = 0; }
}

function setup(withDisk = true): Computer {
  const m = new AtariMachine('atari800', null, 'ntsc');
  if (withDisk) m.services.disks.insert('a', makeAtr(), 'test.atr');
  return new Computer(m);
}

describe('atari SIO bus: disk drive at bit level', () => {
  it('answers READ sector 1 with ACK, COMPLETE, 128 bytes and the checksum', () => {
    const c = setup();
    try {
      c.sendCommand(frame(0x31, 0x52, 1));
      c.ms(90); // 131 bytes at 19200 baud take 69 ms
      const expected = new Array(128).fill(1);
      expect(c.received()).toEqual([ACK, COMPLETE, ...expected, checksum(expected)]);
    } finally { c.m.destroy(); }
  });

  it('times the replies as the protocol allows', () => {
    const c = setup();
    try {
      c.sendCommand(frame(0x31, 0x52, 2));
      c.ms(30);
      const [ack, complete, first, second] = c.got;
      // `at` is when the stop bit was sampled, half a bit before it ends; a
      // reply byte takes ten bits, so its start was about 0.95 byte earlier.
      const byteCycles = (10 * CLOCK_HZ) / 19200;
      const ackStart = ack.at - 0.95 * byteCycles;
      expect(ackStart - c.released).toBeGreaterThanOrEqual(0.85 * cyclesPerMs);
      expect(ackStart - c.released).toBeLessThanOrEqual(16 * cyclesPerMs);
      const gap = (complete.at - ack.at) / cyclesPerMs;
      expect(gap).toBeGreaterThanOrEqual(0.25);
      expect(gap).toBeLessThanOrEqual(255);
      // Data bytes follow at 19200 baud: ten bits, 93 cycles each.
      const spacing = second.at - first.at;
      expect(spacing).toBeGreaterThan(byteCycles - 10);
      expect(spacing).toBeLessThan(byteCycles + 10);
    } finally { c.m.destroy(); }
  });

  it('reads the right sector for an address in AUX1/AUX2', () => {
    const c = setup();
    try {
      c.sendCommand(frame(0x31, 0x52, 0x02c0)); // sector 704
      c.ms(90);
      const got = c.received();
      expect(got.slice(0, 2)).toEqual([ACK, COMPLETE]);
      expect(got[2]).toBe(704 & 0xff);
      expect(got.length).toBe(131);
    } finally { c.m.destroy(); }
  });

  it('NAKs a command frame with a bad checksum and does nothing else', () => {
    const c = setup();
    try {
      const bad = frame(0x31, 0x52, 1);
      bad[4] ^= 0x01;
      c.sendCommand(bad);
      c.ms(40);
      expect(c.received()).toEqual([NAK]);
    } finally { c.m.destroy(); }
  });

  it('NAKs a command the drive does not have', () => {
    const c = setup();
    try {
      c.sendCommand(frame(0x31, 0x99, 0));
      c.ms(40);
      expect(c.received()).toEqual([NAK]);
    } finally { c.m.destroy(); }
  });

  it('does not answer at all for an empty drive', () => {
    const c = setup(false);
    try {
      c.sendCommand(frame(0x31, 0x52, 1));
      c.ms(300);
      expect(c.received()).toEqual([]);
    } finally { c.m.destroy(); }
  });

  it('does not answer for a device that is not on the bus (D2: empty, D5:)', () => {
    const c = setup();
    try {
      c.sendCommand(frame(0x32, 0x52, 1));
      c.ms(100);
      c.sendCommand(frame(0x35, 0x53, 0));
      c.ms(100);
      expect(c.received()).toEqual([]);
    } finally { c.m.destroy(); }
  });

  it('does not answer a frame sent with COMMAND low', () => {
    const c = setup();
    try {
      for (const b of frame(0x31, 0x52, 1)) c.send(b);
      c.ms(100);
      expect(c.received()).toEqual([]);
    } finally { c.m.destroy(); }
  });

  it('returns the drive status block for STATUS', () => {
    const c = setup();
    try {
      c.sendCommand(frame(0x31, 0x53, 0));
      c.ms(30);
      // A healthy 90K single-density disk: drive status 0, FDC status $FF,
      // format timeout $E0, unused 0.
      const block = [0x00, 0xff, 0xe0, 0x00];
      expect(c.received()).toEqual([ACK, COMPLETE, ...block, checksum(block)]);
    } finally { c.m.destroy(); }
  });

  it('NAKs, with no ACK or data, a sector that does not exist', () => {
    const c = setup();
    try {
      for (const sector of [0, 721]) {
        c.sendCommand(frame(0x31, 0x52, sector));
        c.ms(40);
      }
      expect(c.received()).toEqual([NAK, NAK]);
    } finally { c.m.destroy(); }
  });

  it('round-trips a sector through WRITE then READ', () => {
    const c = setup();
    try {
      const data = Array.from({ length: 128 }, (_, i) => (i * 5 + 0x21) & 0xff);
      c.sendCommand(frame(0x31, 0x57, 6));
      c.ms(5);
      expect(c.received()).toEqual([ACK]);
      c.clear();
      c.sendData(data);
      c.ms(30);
      expect(c.received()).toEqual([ACK, COMPLETE]);
      expect(Array.from(c.m.services.disks.readSector(0x31, 6)!)).toEqual(data);

      c.clear();
      c.sendCommand(frame(0x31, 0x52, 6));
      c.ms(90);
      expect(c.received()).toEqual([ACK, COMPLETE, ...data, checksum(data)]);
    } finally { c.m.destroy(); }
  });

  it('NAKs a write data frame with a bad checksum and leaves the sector alone', () => {
    const c = setup();
    try {
      c.sendCommand(frame(0x31, 0x57, 7));
      c.ms(5);
      c.clear();
      const data = new Array(128).fill(0xaa);
      for (const b of data) c.send(b);
      c.send(checksum(data) ^ 0xff);
      c.ms(40);
      expect(c.received()).toEqual([NAK]);
      expect(c.m.services.disks.readSector(0x31, 7)![0]).toBe(7);
    } finally { c.m.destroy(); }
  });

  it('still sends a (meaningless) data frame after the ERROR of a read the drive cannot do', () => {
    const c = setup();
    try {
      c.m.services.disks.setDriveModel(0, '810');
      c.m.services.disks.insert('a', new Uint8Array(1040 * 128), 'enhanced.xfd'); // the 810 cannot read ED
      c.sendCommand(frame(0x31, 0x52, 5));
      c.ms(100);                                  // 131 bytes at 19200 baud
      expect(c.received()).toEqual([ACK, ERROR, ...new Array(128).fill(0), 0]);
    } finally { c.m.destroy(); }
  });

  it('reports ERROR for a write to a protected disk', () => {
    const c = setup();
    try {
      c.m.services.disks.setWriteProtect('a', true);
      c.sendCommand(frame(0x31, 0x57, 8));
      c.ms(5);
      c.clear();
      c.sendData(new Array(128).fill(0x55));
      c.ms(40);
      expect(c.received()).toEqual([ACK, ERROR]);
      expect(c.m.services.disks.readSector(0x31, 8)![0]).toBe(8);
    } finally { c.m.destroy(); }
  });

  it('drops a reply when COMMAND is asserted again', () => {
    const c = setup();
    try {
      c.sendCommand(frame(0x31, 0x52, 1));
      c.ms(4); // ACK and COMPLETE are on their way
      c.command(true);
      c.ms(40);
      // Whatever had been sent stands, but the data frame never completes.
      expect(c.received().length).toBeLessThan(131);
    } finally { c.m.destroy(); }
  });

  it('leaves the data-in line idle (mark) after the replies', () => {
    const c = setup();
    try {
      c.sendCommand(frame(0x31, 0x53, 0));
      c.ms(40);
      expect(c.m.pokey.readReg(0x0f) & 0x10).toBe(0x10); // SKSTAT bit 4 high
    } finally { c.m.destroy(); }
  });
});

describe('atari SIO bus: a program driving POKEY itself', () => {
  /** SEI, then a loader written as a custom loader would: AUDCTL/AUDF/SKCTL
   *  set up as the OS does, COMMAND low, five frame bytes out through SEROUT
   *  (waiting on IRQST bit 4, then bit 3, after each), COMMAND high, then 131 reply
   *  bytes in through SERIN (polling IRQST bit 5) to $3000. The frame is at
   *  $0680. */
  const code = [
    0x78,                                           // SEI
    0xa9, 0x00, 0x8d, 0x0e, 0xd4, 0x8d, 0x00, 0xd4, // NMIEN = DMACTL = 0
    0xa9, 0x28, 0x8d, 0x08, 0xd2,                   // AUDCTL = $28
    0x8d, 0x04, 0xd2,                               // AUDF3 = $28
    0xa9, 0x00, 0x8d, 0x06, 0xd2,                   // AUDF4 = 0
    0xa9, 0x13, 0x8d, 0x0f, 0xd2,                   // SKCTL = $13
    0x8d, 0x0a, 0xd2,                               // SKRES
    0xa9, 0x30, 0x8d, 0x0e, 0xd2,                   // IRQEN = input ready, output ready
    0xa9, 0x34, 0x8d, 0x03, 0xd3,                   // PBCTL = $34: COMMAND low
    0xa2, 0x00,                                     // LDX #0
    0xbd, 0x80, 0x06,                               // send: LDA $0680,X
    0x8d, 0x0d, 0xd2,                               // STA SEROUT
    0xad, 0x0e, 0xd2, 0x29, 0x10, 0xd0, 0xf9,       // ready: LDA IRQST; AND #$10; BNE ready
    0xa9, 0x20, 0x8d, 0x0e, 0xd2,                   // acknowledge: IRQEN = $20
    0xa9, 0x30, 0x8d, 0x0e, 0xd2,                   //              IRQEN = $30
    0xad, 0x0e, 0xd2, 0x29, 0x08, 0xd0, 0xf9,       // done: LDA IRQST; AND #8; BNE done
    0xe8, 0xe0, 0x05, 0xd0, 0xdd,                   // INX; CPX #5; BNE send
    0xa9, 0x3c, 0x8d, 0x03, 0xd3,                   // PBCTL = $3C: COMMAND high
    0xa2, 0x00,                                     // LDX #0
    0xad, 0x0e, 0xd2, 0x29, 0x20, 0xd0, 0xf9,       // recv: wait for IRQST bit 5 low
    0xad, 0x0d, 0xd2, 0x9d, 0x00, 0x30,             // LDA SERIN; STA $3000,X
    0xa9, 0x00, 0x8d, 0x0e, 0xd2,                   // acknowledge: IRQEN = 0
    0xa9, 0x20, 0x8d, 0x0e, 0xd2,                   //              IRQEN = $20
    0xe8, 0xe0, 0x83, 0xd0, 0xe4,                   // INX; CPX #131; BNE recv
    0x4c, 0x00, 0x00,                               // done: JMP done (patched)
  ];

  it('reads sector 3 through SEROUT and SERIN', () => {
    const m = new AtariMachine('atari800', null, 'ntsc');
    try {
      m.services.disks.insert('a', makeAtr(), 'test.atr');
      m.setSpeedMultiplier(0);
      m.reset();
      const done = 0x0600 + code.length - 3;
      const prog = code.slice();
      prog[prog.length - 2] = done & 0xff;
      prog[prog.length - 1] = done >> 8;
      for (let i = 0; i < prog.length; i++) m.memory.writeByte(0x0600 + i, prog[i]);
      const cmd = frame(0x31, 0x52, 3);
      for (let i = 0; i < cmd.length; i++) m.memory.writeByte(0x0680 + i, cmd[i]);
      m.cpu.pc = 0x0600;
      for (let f = 0; f < 20 && m.cpu.pc !== done; f++) m.tick();
      expect(m.cpu.pc).toBe(done);
      const got = Array.from({ length: 131 }, (_, i) => m.memory.readByte(0x3000 + i));
      const sector = new Array(128).fill(3);
      expect(got).toEqual([ACK, COMPLETE, ...sector, checksum(sector)]);
    } finally { m.destroy(); }
  });
});
