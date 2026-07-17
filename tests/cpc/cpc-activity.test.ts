/**
 * CPC status-LED activity counters.
 *
 * The KEYBOARD LED lights when the firmware scans the keyboard matrix (a read of
 * the AY's I/O port A through the PPI), and the DISK LED when the FDC data port
 * is transferred. These tests drive those exact I/O paths and assert the
 * counters move — and, just as importantly, that unrelated accesses (a non-port-A
 * AY read, an FDC *status* read) do not move them.
 */

import { describe, it, expect } from 'vitest';
import { Ppi8255 } from '@/machines/cpc/cpc-io.ts';
import { CpcKeyboard } from '@/machines/cpc/cpc-keyboard.ts';
import { AY3891x } from '@/cores/ay-3-8910.ts';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';

describe('CPC keyboard-scan LED counter', () => {
  function setup() {
    const ay = new AY3891x(1_000_000, 48000, 'ABC');
    ay.writeRegister(7, 0x00); // mixer reg: bit 6 = 0 → AY port A is an input
    const kb = new CpcKeyboard();
    let scans = 0;
    // Default PPI control (0x9B) already has port A as input.
    const ppi = new Ppi8255(ay, kb, () => false, () => { scans++; });
    return { ay, kb, ppi, scans: () => scans };
  }

  it('counts a read of AY register 14 (port A) as a keyboard scan', () => {
    const { ay, kb, ppi, scans } = setup();
    kb.setKey(2, 5, true);            // a key on line 2 → that bit reads low
    ay.selectedReg = 14;
    ppi.writeC(0x42);                 // PC6=1 (read), low nibble 2 → select line 2

    const v = ppi.readA();
    expect(scans()).toBe(1);
    expect(v).toBe(0xFF & ~(1 << 5)); // the pressed key shows through
  });

  it('does not count an AY read of a non-keyboard register', () => {
    const { ay, ppi, scans } = setup();
    ay.selectedReg = 0;              // a tone register, not port A
    ppi.writeC(0x40);                // read function
    ppi.readA();
    expect(scans()).toBe(0);
  });

  it('does not count when AY port A is configured as an output', () => {
    const { ay, ppi, scans } = setup();
    ay.writeRegister(7, 0x40);       // bit 6 = 1 → port A is an output
    ay.selectedReg = 14;
    ppi.writeC(0x40);                // read function
    ppi.readA();
    expect(scans()).toBe(0);
  });
});

describe('CPC FDC LED counter', () => {
  it('counts data-port writes and reads but not status reads', () => {
    const m = new CpcMachine('cpc6128', null);
    expect(m.activity.fdcAccesses).toBe(0);

    m.cpu.portOut(0xFB7F, 0x00);     // FDC data write (A10=0, A8=1, A0=1)
    expect(m.activity.fdcAccesses).toBe(1);

    m.cpu.portIn(0xFB7F);            // FDC data read
    expect(m.activity.fdcAccesses).toBe(2);

    m.cpu.portIn(0xFB7E);            // FDC status read — not a transfer
    expect(m.activity.fdcAccesses).toBe(2);
  });

  it('resets the per-frame counters at the start of each frame', () => {
    const m = new CpcMachine('cpc6128', null);
    m.cpu.portOut(0xFB7F, 0x00);
    expect(m.activity.fdcAccesses).toBe(1);
    m.tick();                        // runs one frame, which resets the counters
    expect(m.activity.fdcAccesses).toBe(0);
  });
});
