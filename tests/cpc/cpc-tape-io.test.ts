/**
 * CPC cassette I/O: PPI Port B bit 7 (read) and Port C bit 4 (motor).
 *
 * The firmware reads the cassette level on Port B bit 7 and switches the motor
 * via Port C bit 4 (bit 5 is cassette write data). The tape only advances while
 * the motor is on, matching real hardware (the firmware spins it up to load and
 * stops it otherwise).
 */

import { describe, it, expect } from 'vitest';
import { Ppi8255 } from '@/machines/cpc/cpc-io.ts';
import { CpcKeyboard } from '@/machines/cpc/cpc-keyboard.ts';
import { AY3891x } from '@/cores/ay-3-8910.ts';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';

describe('CPC PPI cassette bits', () => {
  function setup() {
    const ay = new AY3891x(1_000_000, 48000, 'ABC');
    const kb = new CpcKeyboard();
    let ear = 0;
    let motor = false;
    const ppi = new Ppi8255(ay, kb, () => false, () => {},
      () => ear, (on) => { motor = on; });
    return { ppi, setEar: (v: number) => { ear = v; }, motor: () => motor };
  }

  it('reflects the cassette read level on Port B bit 7', () => {
    const { ppi, setEar } = setup();
    setEar(1);
    expect(ppi.readB() & 0x80).toBe(0x80);
    setEar(0);
    expect(ppi.readB() & 0x80).toBe(0);
    // The other Port B bits (manufacturer=7, 50Hz, and the pulled-up
    // /EXP + printer /BUSY bits 5-6) are unaffected by the tape bit.
    expect(ppi.readB() & 0x7F).toBe((7 << 1) | 0x10 | 0x60);
  });

  it('Port B bits 5-6 (/EXP present, printer /BUSY) read pulled-up (1)', () => {
    // Nothing here models a connected expansion device or printer to pull
    // either line low, so both read as pulled up regardless of other state.
    const { ppi, setEar } = setup();
    setEar(0);
    expect(ppi.readB() & 0x60).toBe(0x60);
    setEar(1);
    expect(ppi.readB() & 0x60).toBe(0x60);
  });

  it('drives the motor from Port C bit 4 via writeC', () => {
    const { ppi, motor } = setup();
    ppi.writeC(0x10);            // bit 4 set
    expect(motor()).toBe(true);
    ppi.writeC(0x00);            // bit 4 clear
    expect(motor()).toBe(false);
  });

  it('drives the motor from a Port C bit set/reset control word', () => {
    const { ppi, motor } = setup();
    ppi.writeControl((4 << 1) | 1); // set bit 4
    expect(motor()).toBe(true);
    ppi.writeControl((4 << 1) | 0); // reset bit 4
    expect(motor()).toBe(false);
  });

  it('turns the motor off on a PPI mode-set (latches cleared)', () => {
    const { ppi, motor } = setup();
    ppi.writeC(0x10);
    expect(motor()).toBe(true);
    ppi.writeControl(0x9B);      // mode-set clears the output latches
    expect(motor()).toBe(false);
  });
});

describe('CPC tape advance is cadence-gated', () => {
  // The 6128 firmware reads tape edges in a tight Port-B polling loop without
  // ever spinning the motor relay, so advance is gated on read cadence: tight
  // reads (small T-state gaps) = active loading → advance; long gaps = idle →
  // freeze. A long tone makes one edge land at the scaled half-cycle boundary.
  function armedTape(m: CpcMachine) {
    m.tape.blocks = [{ kind: 'tone', pulseLen: 100, count: 100000 }];
    m.tape.position = 0;
    m.tape.paused = true;            // mounted paused, like a real load
    m.tape.startPlayback();
    m.cpu.tStates = 0;
    m.tapeLastAdvanceT = 0;
  }
  // round(100 × 4/3.5) = 114 — one scaled tone half-cycle on the CPC.
  const SCALED = 114;

  it('advances and auto-unpauses on a tight read cadence', () => {
    const m = new CpcMachine('cpc6128', null);
    armedTape(m);
    // Tight reads 50 T-states apart (< the 500T enter threshold).
    for (let t = 50; t <= SCALED + 50; t += 50) { m.cpu.tStates = t; m.advanceTapeTo(); }
    expect(m.tapeLoadingActive).toBe(true);
    expect(m.tape.paused).toBe(false);   // auto-unpaused by the loading cadence
    expect(m.tape.earBit).toBe(1);       // edge emitted (≥114T elapsed in steps)
  });

  it('does not advance on idle (long-gap) reads', () => {
    const m = new CpcMachine('cpc6128', null);
    armedTape(m);
    // Idle VSYNC-style polls thousands of T-states apart (> the 5000T exit gap).
    m.cpu.tStates = 10_000; m.advanceTapeTo();
    m.cpu.tStates = 20_000; m.advanceTapeTo();
    expect(m.tapeLoadingActive).toBe(false);
    expect(m.tape.earBit).toBe(0);       // frozen — not consumed while idle
  });

  it('tracks the motor bit but does not gate playback on it', () => {
    const m = new CpcMachine('cpc6128', null);
    armedTape(m);
    m.setTapeMotor(true);
    expect(m.tapeMotorOn).toBe(true);
    // Motor on but only idle reads → still frozen (cadence, not motor, gates).
    m.cpu.tStates = 10_000; m.advanceTapeTo();
    m.cpu.tStates = 20_000; m.advanceTapeTo();
    expect(m.tape.earBit).toBe(0);
  });
});
