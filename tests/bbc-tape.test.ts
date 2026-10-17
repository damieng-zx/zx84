/**
 * BBC Micro cassette tests.
 *
 * The first block drives the serial ULA / ACIA / tape deck directly with a tiny
 * synthetic OS (no copyrighted ROMs). The second boots the real MOS 1.20 and
 * BASIC 2 (cached under mcp/.cache as bbc-os12.rom / bbc-basic2.rom, skipped
 * when absent) and round-trips a program through SAVE and LOAD on a UEF.
 *
 * Expectations come from the BBC Microcomputer User Guide / Advanced User Guide:
 * serial ULA at &FE10 (bit 7 motor, bit 6 RS423 select), ACIA status/data at
 * &FE08/&FE09, cassette at 1200 baud 8N1 (the MOS uses ACIA divide-by-16 with
 * the ULA at 300 baud), carrier detect = ACIA status bit 2.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BbcMachine } from '@/machines/bbc/bbc-machine.ts';
import { buildUef, type UefChunk } from '@/media/tape/uef.ts';

const chunk = (id: number, ...data: number[]): UefChunk => ({ id, data: Uint8Array.from(data) });

/** Minimal OS: reset vector to a NOP/JMP spin so the CPU just burns cycles. */
function spinRom(): Uint8Array {
  const rom = new Uint8Array(0x8000);
  rom.set([0xEA, 0x4C, 0x00, 0xC0], 0);          // $C000: NOP ; JMP $C000
  rom[0x3FFC] = 0x00; rom[0x3FFD] = 0xC0;
  return rom;
}

function spinning(): BbcMachine {
  const m = new BbcMachine('bbc-b', null);
  m.loadROM(spinRom());
  m.reset();
  return m;
}

const ACIA_STATUS = 0xFE08, ACIA_DATA = 0xFE09, SERIAL_ULA = 0xFE10;
const DCD = 0x04;

/** Select cassette at 1200 baud with the motor running, as the MOS does (&85 with ACIA ÷16). */
function startTape(m: BbcMachine): void {
  m.memory.writeByte(ACIA_STATUS, 0x03);           // master reset
  m.memory.writeByte(ACIA_STATUS, 0x15);           // ÷16, 8N1, no interrupts
  m.memory.writeByte(SERIAL_ULA, 0x85);            // motor on, cassette, TX 300 baud
}

describe('BBC cassette hardware', () => {
  it('moves the tape only while the serial ULA motor bit is set', async () => {
    const m = spinning();
    await m.services.tape.mountBytes(buildUef([chunk(0x0110, 0xE8, 0x03)]), 't.uef');
    for (let i = 0; i < 5; i++) m.tick();
    expect(m.cassette.deck.position).toBe(0);
    expect(m.cassette.running).toBe(false);
    m.memory.writeByte(SERIAL_ULA, 0x85);
    expect(m.cassette.running).toBe(true);
    m.memory.writeByte(SERIAL_ULA, 0x05);
    expect(m.cassette.running).toBe(false);
    m.destroy();
  });

  it('raises ACIA carrier detect (status bit 2) during the leader and drops it for data', async () => {
    const m = spinning();
    await m.services.tape.mountBytes(buildUef([
      chunk(0x0110, 0xB0, 0x04),                   // 0.5 s leader
      chunk(0x0100, 0x55, 0x55, 0x55, 0x55),
      chunk(0x0110, 0x60, 0x00),
    ]), 't.uef');
    startTape(m);
    const states: boolean[] = [];
    for (let f = 0; f < 60; f++) {
      m.tick();
      // Read status then data, the sequence that releases a latched DCD.
      states.push((m.memory.readByte(ACIA_STATUS) & DCD) !== 0);
      m.memory.readByte(ACIA_DATA);
    }
    expect(states.slice(0, 20).some(Boolean)).toBe(true);        // leader
    expect(states.slice(30, 40).every(s => !s)).toBe(true);       // 0x55 data: no carrier
    m.destroy();
  });

  it('delivers every byte to a polling 6502 routine, in order, at 1200 baud', async () => {
    const rom = spinRom();
    // LDX #0 ; loop: LDA $FE08 ; AND #1 ; BEQ loop ; LDA $FE09 ; STA $0200,X ; INX ; JMP loop
    rom.set([0xA2, 0x00, 0xAD, 0x08, 0xFE, 0x29, 0x01, 0xF0, 0xF9,
      0xAD, 0x09, 0xFE, 0x9D, 0x00, 0x02, 0xE8, 0x4C, 0x02, 0xC0], 0);
    const m = new BbcMachine('bbc-b', null);
    m.loadROM(rom);
    m.reset();
    const payload = [0x2A, 0x48, 0x49, 0x00, 0xFF, 0x80, 0x01, 0x55];
    await m.services.tape.mountBytes(buildUef([
      chunk(0x0110, 0xB0, 0x04), chunk(0x0100, ...payload), chunk(0x0110, 0x60, 0x00),
    ]), 't.uef');
    startTape(m);
    for (let f = 0; f < 60; f++) m.tick();           // 1.2 s: 0.5 s leader + 8 bytes (67 ms) + tail
    expect(Array.from(m.memory.ram.subarray(0x200, 0x200 + payload.length))).toEqual(payload);
    expect(m.memory.ram[0x200 + payload.length]).toBe(0);   // and nothing spurious after
    m.destroy();
  });

  it('records bytes the OS writes to the ACIA as UEF data after the motor-on leader', () => {
    const m = spinning();
    m.memory.writeByte(ACIA_STATUS, 0x03);
    m.memory.writeByte(ACIA_STATUS, 0x15);
    m.memory.writeByte(SERIAL_ULA, 0x85);
    for (let i = 0; i < 25; i++) m.tick();           // 0.5 s of leader
    m.memory.writeByte(ACIA_DATA, 0x41);
    for (let i = 0; i < 2; i++) m.tick();
    for (const b of [0x42, 0x43]) {
      while (!(m.memory.readByte(ACIA_STATUS) & 0x02)) m.tick();
      m.memory.writeByte(ACIA_DATA, b);
    }
    for (let i = 0; i < 5; i++) m.tick();
    const rec = m.services.tape.recordedBytes();
    expect(rec).not.toBeNull();
    expect(rec!.filename).toBe('bbc-tape.uef');
    // Header signature, then a carrier chunk (0110) before the data chunk (0100).
    expect(Array.from(rec!.data.subarray(0, 9))).toEqual(Array.from('UEF File!', c => c.charCodeAt(0)));
    m.destroy();
  });

  it('ignores ACIA output when RS423 (not cassette) is selected', () => {
    const m = spinning();
    m.memory.writeByte(ACIA_STATUS, 0x03);
    m.memory.writeByte(ACIA_STATUS, 0x15);
    m.memory.writeByte(SERIAL_ULA, 0xC5);            // motor on but RS423 selected
    m.tick();
    m.memory.writeByte(ACIA_DATA, 0x41);
    for (let i = 0; i < 5; i++) m.tick();
    expect(m.services.tape.recordedBytes()).toBeNull();
    m.destroy();
  });
});

const CACHE = resolve(__dirname, '../mcp/.cache');
const haveRoms = ['bbc-os12.rom', 'bbc-basic2.rom'].every(r => existsSync(resolve(CACHE, r)));

describe.skipIf(!haveRoms)('BBC Micro cassette filing system (MOS 1.20 + BASIC 2)', () => {
  function boot(): BbcMachine {
    const rom = new Uint8Array(0x8000);
    rom.set(readFileSync(resolve(CACHE, 'bbc-os12.rom')), 0);
    rom.set(readFileSync(resolve(CACHE, 'bbc-basic2.rom')), 0x4000);
    const m = new BbcMachine('bbc-b', null);
    m.loadROM(rom);
    m.reset();
    for (let i = 0; i < 150; i++) m.tick();
    return m;
  }
  function typist(m: BbcMachine): (s: string) => void {
    return (s) => {
      for (const ch of s) {
        const ev = {
          code: ch === '\n' ? 'Enter' : /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : '',
          key: ch === '\n' ? 'Enter' : ch, shift: false, ctrl: false, alt: false,
        };
        m.services.input.keyDown(ev);
        for (let i = 0; i < 3; i++) m.tick();
        m.services.input.keyUp(ev);
        for (let i = 0; i < 3; i++) m.tick();
      }
    };
  }
  const run = (m: BbcMachine, frames: number): void => { for (let i = 0; i < frames; i++) m.tick(); };

  it('SAVEs a BASIC program to tape, then LOADs, LISTs and RUNs it back from the recording', async () => {
    const a = boot();
    const typeA = typist(a);
    typeA('10 PRINT "HELLO TAPE"\n*TAPE\nSAVE "HI"\n');
    run(a, 20);
    typeA('\n');                                    // "RECORD then RETURN"
    run(a, 3000);
    expect(a.ocrScreenForMcp()).toMatch(/HI\s+00 0015/);
    const rec = a.services.tape.recordedBytes();
    expect(rec).not.toBeNull();
    a.destroy();

    const b = boot();
    const typeB = typist(b);
    expect(await b.services.tape.mountBytes(rec!.data, 'rec.uef')).toBe(true);
    typeB('*TAPE\nLOAD "HI"\n');
    run(b, 6000);
    typeB('LIST\n');
    run(b, 20);
    typeB('RUN\n');
    run(b, 20);
    const screen = b.ocrScreenForMcp();
    expect(screen).toContain('10 PRINT "HELLO TAPE"');
    expect(screen).toMatch(/^HELLO TAPE$/m);
    b.destroy();
  }, 120_000);

  it('keeps the 50 Hz VSYNC interrupt running in Mode 7 (interlaced CRTC)', () => {
    const m = boot();
    let vsyncs = 0;
    const advance = m.crtc.advanceLine.bind(m.crtc);
    m.crtc.advanceLine = () => { advance(); if (m.crtc.vsyncStart) vsyncs++; };
    run(m, 50);
    expect(vsyncs).toBe(50);
    m.destroy();
  });
});
