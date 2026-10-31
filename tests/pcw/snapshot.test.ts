/**
 * Amstrad PCW snapshots: zx84's native `.pcwstate`.
 *
 * The exact-resume checks boot a synthetic system disc whose boot sector
 * keeps the machine busy the way CP/M does: it reads sectors 1-9 of track 0
 * over and over through the uPD765A (polling the main status register,
 * ending each transfer with the gate array's terminal count, collecting the
 * result phase), with the FDC routed to /NMI and the 300Hz timer serviced in
 * IM 1. The sectors land in the block that also holds the roller RAM, and
 * the timer handler scrolls the screen and toggles the beeper, so the
 * picture, the FDC, the interrupts and the RAM all move every frame — and a
 * frame boundary usually falls in the middle of a sector transfer.
 */

import { describe, expect, it } from 'vitest';
import { PcwMachine } from '@/machines/pcw/pcw-machine.ts';
import type { PcwModel } from '@/machines/pcw/models.ts';
import type { SettingsView } from '@/machines/machine.ts';
import type { DskImage, DskSector, DskTrack } from '@/media/floppy/disk-image.ts';
import { expectDamagedRefused, expectExactResume, observe } from '../machines/native-state-harness.ts';

/** A tiny assembler: bytes, labels and 8/16-bit references to labels. */
class Asm {
  readonly bytes: number[] = [];
  private readonly labels = new Map<string, number>();
  private readonly fixups: { at: number; label: string; rel: boolean }[] = [];
  constructor(readonly org: number) {}
  get pc(): number { return this.org + this.bytes.length; }
  b(...v: number[]): this { this.bytes.push(...v); return this; }
  label(name: string): this { this.labels.set(name, this.pc); return this; }
  /** opcode then a 16-bit address of `label`. */
  abs(op: number[], label: string): this {
    this.b(...op);
    this.fixups.push({ at: this.bytes.length, label, rel: false });
    return this.b(0, 0);
  }
  /** A relative jump (opcode then e). */
  rel(op: number, label: string): this {
    this.b(op);
    this.fixups.push({ at: this.bytes.length, label, rel: true });
    return this.b(0);
  }
  finish(): number[] {
    for (const f of this.fixups) {
      const target = this.labels.get(f.label);
      if (target === undefined) throw new Error(`no label ${f.label}`);
      if (f.rel) {
        const e = target - (this.org + f.at + 1);
        if (e < -128 || e > 127) throw new Error(`jr out of range to ${f.label}`);
        this.bytes[f.at] = e & 0xFF;
      } else {
        this.bytes[f.at] = target & 0xFF;
        this.bytes[f.at + 1] = target >> 8;
      }
    }
    return this.bytes;
  }
}

const JR = 0x18, JR_NZ = 0x20, JR_NC = 0x30, JR_Z = 0x28;

/** The boot-sector program, assembled at &F010 (the boot entry point). */
function program(): number[] {
  const a = new Asm(0xF010);
  a.b(0xF3)                                  // DI
    .b(0x31, 0x00, 0xF8)                     // LD SP,&F800
    .b(0xED, 0x56)                           // IM 1
    .b(0x3E, 0xC3, 0x32, 0x38, 0x00)         // LD A,&C3 ; LD (&0038),A
    .abs([0x21], 'isr').b(0x22, 0x39, 0x00)  // LD HL,isr ; LD (&0039),HL
    .b(0x32, 0x66, 0x00)                     // LD (&0066),A
    .abs([0x21], 'nmi').b(0x22, 0x67, 0x00)  // LD HL,nmi ; LD (&0067),HL
    .b(0x3E, 0x20, 0xD3, 0xF5)               // roller RAM at block 1 (&4000)
    .b(0x3E, 0x40, 0xD3, 0xF7)               // screen on
    .b(0x3E, 0x09, 0xD3, 0xF8)               // motor on
    .b(0x3E, 0x02, 0xD3, 0xF8)               // FDC interrupt → /NMI
    .b(0x21, 0x00, 0x40)                     // LD HL,&4000 (destination)
    .b(0x1E, 0x01)                           // LD E,1 (sector)
    .b(0xFB)                                 // EI
    .label('loop');
  // READ DATA (MFM): unit 0, C 0, H 0, R E, N 2, EOT 9, GPL &2A, DTL &FF.
  for (const v of [0x46, 0x00, 0x00, 0x00]) a.b(0x3E, v).abs([0xCD], 'send');
  a.b(0x7B).abs([0xCD], 'send');             // LD A,E ; CALL send
  for (const v of [0x02, 0x09, 0x2A, 0xFF]) a.b(0x3E, v).abs([0xCD], 'send');
  a.b(0x01, 0x00, 0x02)                      // LD BC,512
    .label('rd')
    .b(0xDB, 0x00, 0x87).rel(JR_NC, 'rd')    // wait for RQM
    .b(0xDB, 0x01, 0x77, 0x23)               // IN A,(1) ; LD (HL),A ; INC HL
    .b(0x7C, 0xFE, 0x80).rel(JR_NZ, 'nowrap') // LD A,H ; CP &80
    .b(0x26, 0x40)                           // LD H,&40
    .label('nowrap')
    .b(0x0B, 0x78, 0xB1).rel(JR_NZ, 'rd')    // DEC BC ; LD A,B ; OR C
    .b(0x3E, 0x05, 0xD3, 0xF8)               // terminal count on
    .b(0x3E, 0x06, 0xD3, 0xF8)               // terminal count off
    .label('res')
    .b(0xDB, 0x00, 0x87).rel(JR_NC, 'res')   // wait for RQM
    .b(0xDB, 0x00, 0xCB, 0x67).rel(JR_Z, 'done') // CB clear: result phase over
    .b(0xDB, 0x01).rel(JR, 'res')            // take a result byte
    .label('done')
    .b(0x1C, 0x7B, 0xFE, 0x0A).rel(JR_NZ, 'next') // INC E ; LD A,E ; CP 10
    .b(0x1E, 0x01)                           // LD E,1
    .label('next')
    .abs([0xC3], 'loop')
    .label('send')
    .b(0xF5)                                 // PUSH AF
    .label('s1')
    .b(0xDB, 0x00, 0x87).rel(JR_NC, 's1')    // wait for RQM
    .b(0xF1, 0xD3, 0x01, 0xC9)               // POP AF ; OUT (1),A ; RET
    .label('isr')
    .b(0xF5, 0xDB, 0xF4)                     // PUSH AF ; IN A,(&F4) clears the count
    .abs([0x3A], 'count').b(0x3C).abs([0x32], 'count') // count++
    .b(0xD3, 0xF6)                           // scroll: roller offset = count
    .b(0xE6, 0x01, 0xC6, 0x0B, 0xD3, 0xF8)   // beep on/off with bit 0
    .b(0xF1, 0xFB, 0xED, 0x4D)               // POP AF ; EI ; RETI
    .label('nmi')
    .b(0xF5).abs([0x3A], 'nmis').b(0x3C).abs([0x32], 'nmis')
    .b(0xF1, 0xED, 0x45)                     // POP AF ; RETN
    .label('count').b(0)
    .label('nmis').b(0);
  return a.finish();
}

function sector(r: number, data: Uint8Array): DskSector {
  return { c: 0, h: 0, r, n: 2, st1: 0, st2: 0, data };
}

/** A system disc: sector 1 is the boot sector (checksum &FF), sectors 2-9
 *  hold patterns the program streams into the roller-RAM block. */
function bootDisk(): DskImage {
  const boot = new Uint8Array(512);
  boot.set(program(), 0x10);
  let sum = 0;
  for (let i = 0; i < 511; i++) sum = (sum + boot[i]) & 0xFF;
  boot[511] = (0xFF - sum) & 0xFF;
  const sectors = [sector(1, boot)];
  for (let r = 2; r <= 9; r++) {
    const data = new Uint8Array(512);
    for (let i = 0; i < 512; i++) data[i] = (i * r + (i >> 3) * 17) & 0xFF;
    sectors.push(sector(r, data));
  }
  const track: DskTrack = {
    sectors, sectorMap: new Map(sectors.map((s, i) => [s.r, i])), gap3: 82, filler: 0xE5,
  };
  return {
    format: 'standard', numTracks: 40, numSides: 1,
    tracks: [[track]], diskFormat: 'PCW', protection: '',
  };
}

const view = (values: Record<string, unknown>): SettingsView => ({
  get<T>(key: string, fallback: T): T { return (key in values ? values[key] : fallback) as T; },
});

function machine(
  model: PcwModel = 'pcw8512', drives?: number, disc = true, hz60 = false,
): PcwMachine {
  const m = new PcwMachine(model, null);
  m.start = async () => {};
  m.prepare(view({
    ...(drives === undefined ? {} : { 'drive-count:pcw': drives }),
    ...(hz60 ? { 'pcw-60hz': true } : {}),
  }));
  m.reset();
  if (disc) m.services.disks.insert('a', bootDisk(), 'boot.dsk');
  return m;
}

describe('PCW .pcwstate', () => {
  it('is offered for saving and loading', () => {
    const m = machine();
    try {
      expect(m.services.snapshots.formats()).toEqual([{ ext: '.pcwstate', canSave: true }]);
      expect(m.services.media.accepts().some(t => t.ext === '.pcwstate' && t.target === 'snapshot')).toBe(true);
      expect(m.descriptor.ui.saveMenu).toContain('snapshot-pcwstate');
    } finally {
      m.destroy();
    }
  });

  it('the synthetic disc keeps the FDC, /NMI and the timer busy', () => {
    const m = machine();
    try {
      for (let f = 0; f < 10; f++) m.tick();
      // The timer handler and the NMI handler both counted (8-bit counters;
      // the level-triggered 300Hz pulse is taken more than once while it
      // lasts, as /INT is still low when the handler returns).
      const count = (label: number) => m.memory.readByte(label);
      const prog = program();
      const base = 0xF010 + prog.length;
      expect(count(base - 2)).toBeGreaterThanOrEqual(60); // 6 timer pulses a frame
      expect(count(base - 1)).toBeGreaterThan(5);         // FDC result /NMIs
      expect(m.asic.fdcRoute).toBe('nmi');
      // Frame ends fall inside sector transfers (where the exact-resume
      // checks below save), not only between commands.
      let inTransfer = 0;
      // (The controller's phase is private; 2 is its execution phase.)
      const phase = () => (m.fdc as unknown as { phase: number }).phase;
      for (let f = 0; f < 20; f++) { m.tick(); if (phase() === 2) inTransfer++; }
      expect(inTransfer).toBeGreaterThan(5);
      // Sector data has reached the roller-RAM block.
      expect(m.memory.getRamBank(1).some(b => b !== 0)).toBe(true);
    } finally {
      m.destroy();
    }
  });

  it('resumes exactly with a disc transfer in flight (8512, two drives)', async () => {
    await expectExactResume({
      make: () => machine('pcw8512'),
      ext: '.pcwstate',
      before: 41,
      after: 25,
      scramble: m => {
        for (let i = 0; i < 0x4000; i++) m.memory.getRamBank(1)[i] = i * 13;
        m.cpu.portOut(0xF7, 0xC0);
      },
    });
  });

  it('resumes exactly on a one-drive 8256', async () => {
    await expectExactResume({ make: () => machine('pcw8256'), ext: '.pcwstate', before: 17, after: 12 });
  });

  it('resumes exactly on a 60Hz machine, with its own frame length and timer lines', async () => {
    await expectExactResume({
      make: () => machine('pcw8256', undefined, true, true),
      ext: '.pcwstate', before: 19, after: 14,
    });
  });

  it('refuses a state saved at another frame rate, changing nothing', async () => {
    const src = machine('pcw8256', undefined, true, true);
    const dst = machine('pcw8256');
    try {
      for (let f = 0; f < 4; f++) src.tick();
      for (let f = 0; f < 6; f++) dst.tick();
      const before = observe(dst);
      const result = await dst.services.snapshots.apply(await src.services.snapshots.save('.pcwstate'), 'x.pcwstate');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/60Hz.*50Hz/);
      expect(observe(dst)).toEqual(before);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('carries what has been sent to the printer', async () => {
    const src = machine('pcw8256');
    const dst = machine('pcw8256', undefined, false);
    try {
      for (let f = 0; f < 3; f++) src.tick();
      for (const b of [0xA4, 0x01, 0xB8, 0x00]) src.cpu.portOut(0xFD, b);
      dst.cpu.portOut(0xFD, 0xC0);     // a stray byte the state must replace
      const file = await src.services.snapshots.save('.pcwstate');
      expect((await dst.services.media.mount(file, 'x.pcwstate')).ok).toBe(true);
      expect(new TextDecoder().decode(dst.printerExportBytes()!.data))
        .toBe(new TextDecoder().decode(src.printerExportBytes()!.data));
      expect(new TextDecoder().decode(dst.printerExportBytes()!.data)).toContain('line feed 1/360"');
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('carries the disc: a state loaded into a machine with no disc reads the same sectors', async () => {
    const src = machine('pcw8256');
    const dst = machine('pcw8256', undefined, false);
    try {
      for (let f = 0; f < 20; f++) src.tick();
      // An in-session write the disc file would not have.
      src.fdc.getDiskImage(0)!.tracks[0][0]!.sectors[4].data[7] = 0x5A;
      const file = await src.services.snapshots.save('.pcwstate');
      const result = await dst.services.media.mount(file, 'x.pcwstate');
      expect(result.ok, result.message).toBe(true);
      expect(result.mediaChanged).toBe(true);
      expect(dst.services.disks.drives[0].mediaName).toBe('boot.dsk');
      expect(dst.fdc.getDiskImage(0)!.tracks[0][0]!.sectors[4].data[7]).toBe(0x5A);
      for (let f = 0; f < 15; f++) { src.tick(); dst.tick(); }
      expect(observe(dst)).toEqual(observe(src));
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('refuses a damaged file and leaves the machine alone', async () => {
    await expectDamagedRefused(() => machine('pcw8256'), '.pcwstate');
  });

  it('refuses a state saved with another number of drives, changing nothing', async () => {
    const src = machine('pcw8512', 2);
    const dst = machine('pcw8512', 1);
    try {
      for (let f = 0; f < 4; f++) src.tick();
      for (let f = 0; f < 6; f++) dst.tick();
      const before = observe(dst);
      const result = await dst.services.snapshots.apply(await src.services.snapshots.save('.pcwstate'), 'x.pcwstate');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/2 drives.*one drive/);
      expect(observe(dst)).toEqual(before);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });

  it('asks the host for the model a state was saved on', async () => {
    const src = machine('pcw9512');
    const dst = machine('pcw8256');
    try {
      src.tick();
      const asked: string[] = [];
      dst.attachHost({
        setStatus() {}, persistMedia() {},
        requestModel: async (model: string) => { asked.push(model); return false; },
      } as never);
      const result = await dst.services.snapshots.apply(await src.services.snapshots.save('.pcwstate'), 'x.pcwstate');
      expect(asked).toEqual(['pcw9512']);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/PCW 9512/);
    } finally {
      src.destroy();
      dst.destroy();
    }
  });
});
