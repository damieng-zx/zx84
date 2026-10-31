/**
 * uPD765A SCAN EQUAL / SCAN LOW OR EQUAL / SCAN HIGH OR EQUAL.
 *
 * Expected values come from the NEC µPD765 datasheet's SCAN description and its
 * Table 3 (SH/SN per command and comparison), and from SMSC TN6.6 ("Programming
 * the FDC765A") for the rule that 0xFF from either the drive or the processor
 * always meets the condition:
 *
 *   - the processor supplies the bytes (execution phase MSR: RQM EXM CB, DIO 0);
 *   - comparison is unsigned, 0x00 smallest and 0xFF largest;
 *   - a sector that fails moves the scan to R + STP; the scan stops on the
 *     first satisfying sector, after sector EOT, or on TC;
 *   - Table 3:  EQUAL      disk = proc → SH 1 SN 0; disk ≠ proc → SH 0 SN 1
 *               LOW OR EQ  disk = proc → SH 1 SN 0; disk < proc → SH 0 SN 0;
 *                          disk > proc → SH 0 SN 1
 *               HIGH OR EQ disk = proc → SH 1 SN 0; disk > proc → SH 0 SN 0;
 *                          disk < proc → SH 0 SN 1
 *   - a deleted-data sector with SK = 0 is treated as the last sector (CM set);
 *     with SK = 1 it is skipped and CM is still set;
 *   - STP = 2 from sector 21 with EOT 26 on a 26-sector track reads 21, 23, 25
 *     and terminates abnormally (the scan never reads sector EOT).
 */

import { describe, it, expect } from 'vitest';
import { UPD765A } from '@/cores/upd765a.ts';
import type { DskImage, DskSector, DskTrack } from '@/media/floppy/disk-image.ts';
import { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

const RQM = 0x80, DIO = 0x40, EXM = 0x20, CB = 0x10;
const SCAN_EQ = 0x11, SCAN_LE = 0x19, SCAN_HE = 0x1D;
const SK = 0x20, MT = 0x80;
const ST0_ABNORMAL = 0x40, ST0_NOT_READY = 0x08;
const ST1_EN = 0x80, ST1_ND = 0x04;
const ST2_CM = 0x40, ST2_SH = 0x08, ST2_SN = 0x04;
const N = 0;          // 128-byte sectors keep the byte streams short
const SIZE = 128;

function sector(r: number, data: Uint8Array | number, opts: { h?: number; st1?: number; st2?: number } = {}): DskSector {
  const bytes = typeof data === 'number' ? new Uint8Array(SIZE).fill(data) : data;
  return { c: 0, h: opts.h ?? 0, r, n: N, st1: opts.st1 ?? 0, st2: opts.st2 ?? 0, data: bytes };
}

function track(sectors: DskSector[]): DskTrack {
  const sectorMap = new Map<number, number>();
  sectors.forEach((s, i) => sectorMap.set(s.r, i));
  return { sectors, sectorMap, gap3: 0x1B, filler: 0xE5 };
}

function controller(side0: DskSector[], side1?: DskSector[]): UPD765A {
  const image: DskImage = {
    format: 'extended', numTracks: 1, numSides: side1 ? 2 : 1,
    tracks: [side1 ? [track(side0), track(side1)] : [track(side0)]],
    diskFormat: 'test', protection: 'None',
  };
  const fdc = new UPD765A();
  fdc.insertDisk(image, 0);
  return fdc;
}

/** Issue a SCAN (MT/SK in `flags`) for C0 H`h` R`r`, N 0, EOT, GPL, STP. */
function issue(fdc: UPD765A, op: number, r: number, eot: number, stp: number, flags = 0, h = 0): void {
  for (const b of [op | flags, h << 2, 0, h, r, N, eot, 0x1B, stp]) fdc.writeData(b);
}

/** Feed processor bytes while the execution phase lasts; then read the result. */
function run(fdc: UPD765A, proc: (i: number) => number, limit = 64 * SIZE): { fed: number; result: number[] } {
  let fed = 0;
  while ((fdc.readStatus() & EXM) !== 0 && fed < limit) fdc.writeData(proc(fed++) & 0xFF);
  const result: number[] = [];
  while ((fdc.readStatus() & (CB | DIO)) === (CB | DIO) && result.length < 8) result.push(fdc.readData());
  return { fed, result };
}

const fill = (v: number) => () => v;

describe('uPD765A SCAN — data direction and phases', () => {
  it('takes bytes from the processor during execution (MSR RQM EXM CB, DIO clear)', () => {
    const fdc = controller([sector(1, 0x55)]);
    issue(fdc, SCAN_EQ, 1, 1, 1);
    expect(fdc.readStatus()).toBe(RQM | EXM | CB);
  });

  it('accepts all nine command bytes and returns to idle after the 7 result bytes', () => {
    const fdc = controller([sector(1, 0x55)]);
    issue(fdc, SCAN_EQ, 1, 1, 1);
    const { result } = run(fdc, fill(0x55));
    expect(result.length).toBe(7);
    expect(fdc.readStatus()).toBe(RQM);
  });

  it('with no disk: not ready, no execution phase', () => {
    const fdc = new UPD765A();
    issue(fdc, SCAN_EQ, 1, 1, 1);
    const { fed, result } = run(fdc, fill(0));
    expect(fed).toBe(0);
    expect(result[0]).toBe(ST0_ABNORMAL | ST0_NOT_READY);
  });
});

describe('uPD765A SCAN EQUAL', () => {
  it('a sector equal throughout is a hit: SH, normal termination, CHRN of that sector', () => {
    const fdc = controller([sector(1, 0x55), sector(2, 0x66)]);
    issue(fdc, SCAN_EQ, 1, 2, 1);
    const { fed, result } = run(fdc, fill(0x55));
    expect(fed).toBe(SIZE);                      // stops after the first sector
    expect(result).toEqual([0x00, 0x00, ST2_SH, 0, 0, 1, N]);
  });

  it('one differing byte fails the sector; the scan moves on to R+1 and hits there', () => {
    const s1 = new Uint8Array(SIZE).fill(0x66); s1[SIZE - 1] = 0x67;
    const fdc = controller([sector(1, s1), sector(2, 0x66)]);
    issue(fdc, SCAN_EQ, 1, 2, 1);
    const { fed, result } = run(fdc, fill(0x66));
    expect(fed).toBe(2 * SIZE);
    expect(result[0]).toBe(0x00);
    expect(result[2]).toBe(ST2_SH);
    expect(result[5]).toBe(2);
  });

  it('no sector from R to EOT equal: SN, normal termination, R = EOT', () => {
    const fdc = controller([sector(1, 0x10), sector(2, 0x20), sector(3, 0x30)]);
    issue(fdc, SCAN_EQ, 1, 3, 1);
    const { fed, result } = run(fdc, fill(0x40));
    expect(fed).toBe(3 * SIZE);
    expect(result[0]).toBe(0x00);
    expect(result[1]).toBe(0x00);                // no End of Cylinder: EOT ends a scan
    expect(result[2]).toBe(ST2_SN);
    expect(result[5]).toBe(3);
  });

  it('0xFF from the processor matches any disk byte', () => {
    const data = Uint8Array.from({ length: SIZE }, (_, i) => i);
    const fdc = controller([sector(1, data)]);
    issue(fdc, SCAN_EQ, 1, 1, 1);
    expect(run(fdc, fill(0xFF)).result[2]).toBe(ST2_SH);
  });

  it('0xFF on the disk matches any processor byte', () => {
    const fdc = controller([sector(1, 0xFF)]);
    issue(fdc, SCAN_EQ, 1, 1, 1);
    expect(run(fdc, (i) => i & 0x7F).result[2]).toBe(ST2_SH);
  });
});

describe('uPD765A SCAN LOW OR EQUAL (disk ≤ processor)', () => {
  it('disk < processor throughout: satisfied without SH (SH 0, SN 0)', () => {
    const fdc = controller([sector(1, 0x10)]);
    issue(fdc, SCAN_LE, 1, 1, 1);
    const { result } = run(fdc, fill(0x20));
    expect(result[0]).toBe(0x00);
    expect(result[2] & (ST2_SH | ST2_SN)).toBe(0);
  });

  it('equal throughout: SH', () => {
    const fdc = controller([sector(1, 0x20)]);
    issue(fdc, SCAN_LE, 1, 1, 1);
    expect(run(fdc, fill(0x20)).result[2] & (ST2_SH | ST2_SN)).toBe(ST2_SH);
  });

  it('a single disk byte above the processor byte fails the sector (SN)', () => {
    const d = new Uint8Array(SIZE).fill(0x10); d[5] = 0x21;
    const fdc = controller([sector(1, d)]);
    issue(fdc, SCAN_LE, 1, 1, 1);
    expect(run(fdc, fill(0x20)).result[2] & (ST2_SH | ST2_SN)).toBe(ST2_SN);
  });

  it('compares unsigned: disk 0x80 is above processor 0x7F', () => {
    const fdc = controller([sector(1, 0x80)]);
    issue(fdc, SCAN_LE, 1, 1, 1);
    expect(run(fdc, fill(0x7F)).result[2] & ST2_SN).toBe(ST2_SN);
  });

  it('mixed equal and lower bytes satisfy the scan with SH clear', () => {
    const d = new Uint8Array(SIZE).fill(0x20); d[0] = 0x00;
    const fdc = controller([sector(1, d)]);
    issue(fdc, SCAN_LE, 1, 1, 1);
    expect(run(fdc, fill(0x20)).result[2] & (ST2_SH | ST2_SN)).toBe(0);
  });
});

describe('uPD765A SCAN HIGH OR EQUAL (disk ≥ processor)', () => {
  it('disk > processor throughout: satisfied without SH', () => {
    const fdc = controller([sector(1, 0x90)]);
    issue(fdc, SCAN_HE, 1, 1, 1);
    expect(run(fdc, fill(0x80)).result[2] & (ST2_SH | ST2_SN)).toBe(0);
  });

  it('a disk byte below the processor byte fails; the next sector satisfies', () => {
    const fdc = controller([sector(1, 0x7F), sector(2, 0xC0)]);
    issue(fdc, SCAN_HE, 1, 2, 1);
    const { fed, result } = run(fdc, fill(0x80));
    expect(fed).toBe(2 * SIZE);
    expect(result[2] & (ST2_SH | ST2_SN)).toBe(0);
    expect(result[5]).toBe(2);
  });

  it('compares unsigned: disk 0x00 is below processor 0x01', () => {
    const fdc = controller([sector(1, 0x00)]);
    issue(fdc, SCAN_HE, 1, 1, 1);
    expect(run(fdc, fill(0x01)).result[2] & ST2_SN).toBe(ST2_SN);
  });
});

describe('uPD765A SCAN — STP', () => {
  const sectors = (count: number) => Array.from({ length: count }, (_, i) => sector(i + 1, 0x00));

  it('STP 2 compares alternate sectors and ends normally on sector EOT', () => {
    const fdc = controller(sectors(6));
    issue(fdc, SCAN_EQ, 1, 5, 2);
    const { fed, result } = run(fdc, fill(0x01));
    expect(fed).toBe(3 * SIZE);                  // sectors 1, 3, 5
    expect(result[0]).toBe(0x00);
    expect(result[2]).toBe(ST2_SN);
    expect(result[5]).toBe(5);
  });

  it('datasheet example: STP 2 from 21 to EOT 26 on sectors 1-26 never reads 26 and ends abnormally', () => {
    const fdc = controller(sectors(26));
    issue(fdc, SCAN_EQ, 21, 26, 2);
    const { fed, result } = run(fdc, fill(0x01));
    expect(fed).toBe(3 * SIZE);                  // sectors 21, 23, 25
    expect(result[0] & 0xC0).toBe(ST0_ABNORMAL);
    expect(result[1] & ST1_ND).toBe(ST1_ND);
    expect(result[1] & ST1_EN).toBe(0);
  });

  it('...while starting at 20 completes normally', () => {
    const fdc = controller(sectors(26));
    issue(fdc, SCAN_EQ, 20, 26, 2);
    const { fed, result } = run(fdc, fill(0x01));
    expect(fed).toBe(4 * SIZE);                  // 20, 22, 24, 26
    expect(result[0]).toBe(0x00);
    expect(result[2]).toBe(ST2_SN);
    expect(result[5]).toBe(26);
  });
});

describe('uPD765A SCAN — deleted data marks, MT, TC', () => {
  it('SK = 0: a deleted sector is compared, treated as the last sector, CM set', () => {
    const fdc = controller([sector(1, 0x10), sector(2, 0x20, { st2: ST2_CM }), sector(3, 0x30)]);
    issue(fdc, SCAN_EQ, 1, 3, 1);
    const { fed, result } = run(fdc, fill(0x30));
    expect(fed).toBe(2 * SIZE);                  // sector 3 is never reached
    expect(result[0]).toBe(0x00);
    expect(result[2] & (ST2_CM | ST2_SN | ST2_SH)).toBe(ST2_CM | ST2_SN);
    expect(result[5]).toBe(2);
  });

  it('SK = 1: a deleted sector is skipped, CM still reported', () => {
    const fdc = controller([sector(1, 0x10), sector(2, 0x30, { st2: ST2_CM }), sector(3, 0x30)]);
    issue(fdc, SCAN_EQ, 1, 3, 1, SK);
    const { fed, result } = run(fdc, fill(0x30));
    expect(fed).toBe(2 * SIZE);                  // sectors 1 and 3: 2 matched but was skipped
    expect(result[2] & (ST2_CM | ST2_SN | ST2_SH)).toBe(ST2_CM | ST2_SH);
    expect(result[5]).toBe(3);
  });

  it('MT: after EOT fails on head 0 the scan continues at sector 1 of head 1', () => {
    const fdc = controller([sector(1, 0x10), sector(2, 0x10)],
      [sector(1, 0x10, { h: 1 }), sector(2, 0x42, { h: 1 })]);
    issue(fdc, SCAN_EQ, 1, 2, 1, MT);
    const { fed, result } = run(fdc, fill(0x42));
    expect(fed).toBe(4 * SIZE);
    expect(result[0]).toBe(0x04);                // HD = 1, normal termination
    expect(result[2]).toBe(ST2_SH);
    expect(result[4]).toBe(1);
    expect(result[5]).toBe(2);
  });

  it('a save state taken mid-scan resumes the same comparison (opcode, STP, running SH/SN)', () => {
    const disk = () => [sector(1, 0x10), sector(2, 0x00), sector(3, 0x20)];
    const fdc = controller(disk());
    issue(fdc, SCAN_LE, 1, 3, 2);                // sectors 1 and 3; 2 (0x00) would satisfy
    for (let i = 0; i < 3; i++) fdc.writeData(0x05);         // 3 bytes into sector 1
    const w = new StateWriter();
    fdc.saveState(w);
    const resumed = controller(disk());
    resumed.loadState(new StateReader(w.finish()));
    const { fed, result } = run(resumed, fill(0x05));
    expect(fed).toBe(2 * SIZE - 3);              // rest of sector 1, then sector 3
    expect(result[2] & (ST2_SH | ST2_SN)).toBe(ST2_SN);   // 0x10, 0x20 > 0x05: not satisfied
    expect(result[5]).toBe(3);
  });

  it('TC part-way through a sector ends the scan normally with no SH/SN verdict', () => {
    const fdc = controller([sector(1, 0x55)]);
    issue(fdc, SCAN_EQ, 1, 1, 1);
    for (let i = 0; i < 10; i++) fdc.writeData(0x00);   // unequal bytes so far
    fdc.setTerminalCount(true);
    const { fed, result } = run(fdc, fill(0));
    expect(fed).toBe(0);
    expect(result[0]).toBe(0x00);
    expect(result[2] & (ST2_SH | ST2_SN)).toBe(0);
  });
});
