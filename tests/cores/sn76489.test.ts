import { describe, expect, it } from 'vitest';
import { Sn76489, SN76489_VOLUME_TABLE } from '@/cores/sn76489.ts';

describe('SN76489', () => {
  it('combines the four-bit latch and six-bit data writes into a 10-bit tone period', () => {
    const psg = new Sn76489(4_000_000, 48_000);

    psg.write(0x85); // tone 0 low nibble = 5
    psg.write(0x2A); // tone 0 high six bits = 0x2A

    expect(psg.tonePeriod[0]).toBe(0x2A5);
    expect(psg.tonePeriod[1]).toBe(0);
  });

  it('data-only writes continue to update the most recently latched tone register', () => {
    const psg = new Sn76489(4_000_000, 48_000);

    psg.write(0xA3); // tone 1 low nibble
    psg.write(0x01);
    psg.write(0x3F);

    expect(psg.tonePeriod[1]).toBe(0x3F3);
  });

  it('applies data-only writes to an attenuation register after it is latched', () => {
    const psg = new Sn76489(4_000_000, 48_000);
    psg.write(0x8A);
    psg.write(0x01);
    expect(psg.tonePeriod[0]).toBe(0x01A);

    psg.write(0x95); // channel 0 attenuation
    psg.write(0x3F);

    expect(psg.attenuation[0]).toBe(15);
    expect(psg.tonePeriod[0]).toBe(0x01A);
  });

  it('provides distinct TI and 16-bit MTX noise-generator variants', () => {
    const ti = new Sn76489(4_000_000, 250_000, 'ti-15bit');
    const mtx = new Sn76489(4_000_000, 250_000, 'mtx');
    ti.setDcBlocking(false);
    mtx.setDcBlocking(false);
    for (const psg of [ti, mtx]) {
      psg.write(0xF0);
      psg.write(0xE4);
    }

    const tiSequence = Array.from({ length: 2048 }, () => ti.generateSample());
    const mtxSequence = Array.from({ length: 2048 }, () => mtx.generateSample());

    expect(tiSequence).not.toEqual(mtxSequence);
  });

  it('resets the noise LFSR whenever the noise-control register is written', () => {
    const psg = new Sn76489(4_000_000, 250_000);
    psg.setDcBlocking(false);
    psg.write(0xF0); // audible noise
    psg.write(0xE4); // white noise, fastest divider

    const first = Array.from({ length: 40 }, () => psg.generateSample());
    psg.write(0xE4);
    const second = Array.from({ length: 40 }, () => psg.generateSample());

    expect(second).toEqual(first);
  });

  it('uses 2 dB attenuation steps and mutes attenuation code 15', () => {
    expect(SN76489_VOLUME_TABLE[0]).toBe(1);
    expect(SN76489_VOLUME_TABLE[1]).toBeCloseTo(10 ** (-2 / 20), 6);
    expect(SN76489_VOLUME_TABLE[14]).toBeGreaterThan(0);
    expect(SN76489_VOLUME_TABLE[15]).toBe(0);
  });

  it('duplicates the mono hardware output into both stereo channels', () => {
    const psg = new Sn76489(4_000_000, 48_000);
    psg.write(0x90);
    const sample = psg.generateSampleStereo();
    expect(sample.left).toBe(sample.right);
  });
});
