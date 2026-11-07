/**
 * Headless boots from bitstream (HFE v1 and v3) and flux (SCP) images on the
 * BBC Micro, the Electron's Plus 3 and the Enterprise's EXDOS card, against
 * the same disc as a plain sector dump.
 *
 * Every image here is made in the test from a sector image: FM (the BBC's DFS
 * discs) or MFM (ADFS, EXDOS) HFE through the encoder, v3 by giving that file
 * the v3 signature (an FM or MFM stream at the double-density cell rate never
 * holds four adjacent transitions, so it contains no opcodes), and SCP by
 * turning the HFE cells into flux intervals at 2 µs a cell.
 *
 * The ROMs are not redistributable. They are read from mcp/.cache:
 *   BBC       bbc-os12.rom, bbc-basic2.rom, bbc-dnfs.rom (Acorn DNFS: DFS 1.20,
 *             8271), bbc-dfs-226.rom (Acorn 1770 DFS 2.26)
 *   Electron  electron-os.rom, electron-basic.rom, electron-plus1.rom,
 *             electron-plus3.rom (ADFS 1.00), electron-dfs.rom (ACP 1770 DFS)
 *   Enterprise exos21.rom, basic21.rom, exdos13.rom (or EP_ROM_DIR)
 * Suites whose ROMs are missing are skipped. The Electron ADFS test also needs
 * a 640K ADFS L disc at ZX84_ADL (default: BeebEm's L3FS-ISW.adl).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BbcMachine } from '@/machines/bbc/bbc-machine.ts';
import { ElectronMachine } from '@/machines/electron/electron-machine.ts';
import { EnterpriseMachine } from '@/machines/enterprise/enterprise-machine.ts';
import type { DskImage } from '@/media/floppy/disk-image.ts';
import { encodeHFE, parseHFE } from '@/media/floppy/hfe.ts';
import { parseSsd, SSD_TRACK_BYTES } from '@/media/floppy/ssd.ts';
import { parseAdfs } from '@/media/floppy/adfs.ts';
import { parseAcornDisc } from '@/media/floppy/acorn-disc.ts';
import { buildFatImage, serializeFatImage } from '@/media/floppy/fat-image.ts';
import { serializeDSK } from '@/media/floppy/dsk.ts';

const CACHE = resolve(__dirname, '../mcp/.cache');
const has = (dir: string, names: string[]): boolean => names.every(n => existsSync(resolve(dir, n)));
const rom = (dir: string, n: string): Uint8Array => new Uint8Array(readFileSync(resolve(dir, n)));

// ── Image conversions ─────────────────────────────────────────────────────────

/** The same HFE file under the v3 signature. */
function asV3(hfe: Uint8Array): Uint8Array {
  const v3 = hfe.slice();
  v3.set([...'HXCHFEV3'].map(c => c.charCodeAt(0)));
  return v3;
}

/** An SCP flux image of an HFE's tracks: one revolution each, 2 µs a cell
 *  (80 ticks of 25 ns). Two-sided images interleave the sides (heads = 0). */
function asScp(hfe: Uint8Array): Uint8Array {
  const img = parseHFE(hfe);
  const sides = img.numSides;
  const tracks: number[][] = [];
  for (let t = 0; t < img.numTracks; t++) {
    for (let s = 0; s < sides; s++) {
      const cells = img.bitstream!.cells[t][s];
      const flux: number[] = [];
      if (cells) {
        let prev = -1;
        for (let p = 0; p < cells.length * 8; p++) {
          if ((cells[p >> 3] >> (p & 7)) & 1) { flux.push((p - prev) * 80); prev = p; }
        }
      }
      tracks[t * sides + s] = flux;
    }
  }
  const header = 0x10 + 168 * 4;
  const size = header + tracks.reduce((n, f) => n + 16 + f.length * 2, 0);
  const d = new Uint8Array(size);
  d.set([0x53, 0x43, 0x50]);
  d[5] = 1;                                  // one revolution
  d[6] = 0; d[7] = tracks.length - 1;        // first and last track
  d[0x0A] = sides === 2 ? 0 : 1;             // 0 = both sides interleaved, 1 = side 0 only
  let at = header;
  tracks.forEach((flux, i) => {
    const scpTrack = i;                      // two-sided: cylinder × 2 + side; one-sided: the cylinder
    d[0x10 + scpTrack * 4] = at & 0xFF; d[0x11 + scpTrack * 4] = (at >> 8) & 0xFF; d[0x12 + scpTrack * 4] = at >> 16;
    d.set([0x54, 0x52, 0x4B, scpTrack], at);
    d[at + 8] = flux.length & 0xFF; d[at + 9] = (flux.length >> 8) & 0xFF; d[at + 10] = flux.length >> 16;
    d[at + 12] = 16;
    flux.forEach((v, k) => { d[at + 16 + k * 2] = v >> 8; d[at + 17 + k * 2] = v & 0xFF; });
    at += 16 + flux.length * 2;
  });
  return d;
}

// ── A DFS disc that announces itself when booted ─────────────────────────────

/** A 40-track DFS disc whose !BOOT (boot option 3, *EXEC) types a line of BASIC. */
function bootingDfsDisc(): Uint8Array {
  const text = 'PRINT "DISC"+"BOOTED"\r';
  const d = new Uint8Array(40 * SSD_TRACK_BYTES).fill(0xE5);
  d.fill(0, 0, 512);
  d.set([...'BOOTTEST'].map(c => c.charCodeAt(0)), 0);
  d.set([...'!BOOT  $'].map(c => c.charCodeAt(0)), 8);
  d[0x105] = 8;                              // one file
  d[0x106] = 0x30 | (400 >> 8);              // boot option 3 (EXEC), 400 sectors
  d[0x107] = 400 & 0xFF;
  d.set([0, 0, 0, 0, text.length, 0, 0, 2], 0x108);   // load 0, exec 0, length, start sector 2
  d.set([...text].map(c => c.charCodeAt(0)), 512);
  return d;
}

// ── BBC Micro ─────────────────────────────────────────────────────────────────

const BBC_ROMS = ['bbc-os12.rom', 'bbc-basic2.rom', 'bbc-dnfs.rom', 'bbc-dfs-226.rom'];

async function bbcBoot(system: 'acorn' | '1770', data: Uint8Array, name: string): Promise<{ ok: boolean; message: string; screen: string }> {
  const os = new Uint8Array(0x8000);
  os.set(rom(CACHE, 'bbc-os12.rom'), 0);
  os.set(rom(CACHE, 'bbc-basic2.rom'), 0x4000);
  const m = new BbcMachine('bbc-b', null);
  try {
    m.loadROM(os);
    m.setDiskSystem(system);
    m.loadSidewaysRom(13, rom(CACHE, system === 'acorn' ? 'bbc-dnfs.rom' : 'bbc-dfs-226.rom'));
    m.reset();
    for (let i = 0; i < 100; i++) m.tick();
    const r = await m.services.media.mount(data, name, 'a');   // SHIFT+BREAK on drive 0
    for (let i = 0; i < 400; i++) m.tick();
    return { ok: r.ok, message: r.message, screen: m.ocrScreenForMcp() };
  } finally {
    m.destroy();
  }
}

describe.skipIf(!has(CACHE, BBC_ROMS))('BBC Micro boots a DFS disc from HFE and SCP as from .ssd', () => {
  const ssd = bootingDfsDisc();
  const hfe = encodeHFE(parseSsd(ssd, false));
  const formats: [string, Uint8Array][] = [['disc.hfe', hfe], ['disc-v3.hfe', asV3(hfe)], ['disc.scp', asScp(hfe)]];

  it.each(['acorn', '1770'] as const)('with the %s controller', async (system) => {
    const reference = await bbcBoot(system, ssd, 'disc.ssd');
    expect(reference.screen).toMatch(/^DISCBOOTED$/m);
    for (const [name, data] of formats) {
      const got = await bbcBoot(system, data, name);
      expect(got.ok, `${name}: ${got.message}`).toBe(true);
      expect(got.screen, name).toBe(reference.screen);
    }
  }, 120_000);

  it('refuses a double-density (ADFS) image', async () => {
    const adfs = encodeHFE(parseAdfs(new Uint8Array(160 * 1024)));
    const got = await bbcBoot('1770', adfs, 'adfs.hfe');
    expect(got.ok).toBe(false);
    expect(got.message).toMatch(/double-density/);
  }, 60_000);
});

// ── Acorn Electron Plus 3 ─────────────────────────────────────────────────────

const ELK_ROMS = ['electron-os.rom', 'electron-basic.rom', 'electron-plus1.rom', 'electron-plus3.rom', 'electron-dfs.rom'];
const ADL = process.env.ZX84_ADL ?? 'E:/retro/Acorn/BBC/Emulators/BeebEm/UserData/DiscIms/L3FS-ISW.adl';

function electron(dfs: boolean): ElectronMachine {
  const os = new Uint8Array(0x8000);
  os.set(rom(CACHE, 'electron-basic.rom'), 0);
  os.set(rom(CACHE, 'electron-os.rom'), 0x4000);
  const m = new ElectronMachine('electron', null);
  m.loadROM(os);
  m.setExpansions(true, true, dfs);
  m.installPlus1Rom(rom(CACHE, 'electron-plus1.rom'));
  if (dfs) m.installDfsRom(rom(CACHE, 'electron-dfs.rom'));
  else m.installPlus3Rom(rom(CACHE, 'electron-plus3.rom'));
  m.reset();
  for (let i = 0; i < 250; i++) m.tick();
  return m;
}

function typist(m: ElectronMachine): (s: string) => void {
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
const run = (m: { tick(): void }, frames: number): void => { for (let i = 0; i < frames; i++) m.tick(); };

describe.skipIf(!has(CACHE, ELK_ROMS))('Electron Plus 3 with HFE and SCP discs', () => {
  it.skipIf(!existsSync(ADL))('ADFS reads a file across tracks from an MFM HFE and SCP as from the .adl', () => {
    const adl = new Uint8Array(readFileSync(ADL));
    const hfe = encodeHFE(parseAdfs(adl, true));
    expect(parseHFE(hfe).tracks[0][0]!.encoding).toBe('mfm');
    for (const [name, data] of [['l3fs.hfe', hfe], ['l3fs.scp', asScp(hfe)]] as const) {
      const m = electron(false);
      // Into the drive without the SHIFT+BREAK a drop gives (this disc's boot
      // leaves ADFS elsewhere), as the .adl test in electron-boot does.
      m.services.disks.insert('a', parseAcornDisc(data, name, 'adfs').image, name);
      const type = typist(m);
      type('*DIR $\n');
      run(m, 600);
      type('*LOAD !ReadMe 3000\n');
      run(m, 4000);
      // !ReadMe runs from logical sector 7 over three tracks of side 0; the .adl
      // stores the cylinders side 0 then side 1, so logical sector n (< 1280)
      // is image sector (n >> 4) × 32 + n mod 16.
      const len = 0x2BC1;
      const want = new Uint8Array(len);
      for (let at = 0; at < len; at += 256) {
        const n = 7 + at / 256;
        const src = ((n >> 4) * 32 + (n & 15)) * 256;
        want.set(adl.subarray(src, src + Math.min(256, len - at)), at);
      }
      expect(Array.from(m.memory.ram.subarray(0x3000, 0x3000 + len)), name).toEqual(Array.from(want));
      m.destroy();
    }
  }, 240_000);

  it('refuses a DFS HFE while the Plus 3 runs ADFS', async () => {
    const m = electron(false);
    const r = await m.services.media.mount(encodeHFE(parseSsd(bootingDfsDisc(), false)), 'dfs.hfe', 'a');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/set to DFS/);
    m.destroy();
  }, 60_000);

  it('the 1770 DFS boots an FM HFE, and a program saved to it comes back from the saved .hfe', async () => {
    const a = electron(true);
    const hfe = encodeHFE(parseSsd(bootingDfsDisc(), false));
    expect((await a.services.media.mount(hfe, 'disc.hfe', 'a')).ok).toBe(true);
    run(a, 600);
    expect(a.ocrScreenForMcp()).toMatch(/^DISCBOOTED$/m);
    const typeA = typist(a);
    typeA('NEW\n10 PRINT "SAVED ON HFE"\nSAVE "PROG"\n');
    run(a, 2500);
    const saved = a.services.disks.save('a')!;
    expect(saved.name).toBe('disc.hfe');
    a.destroy();

    const b = electron(true);
    b.services.disks.insert('a', parseHFE(saved.data), saved.name);
    const typeB = typist(b);
    typeB('*DISC\n');
    run(b, 60);
    typeB('CHAIN "PROG"\n');
    run(b, 1500);
    expect(b.ocrScreenForMcp()).toMatch(/^SAVED ON HFE$/m);
    b.destroy();
  }, 240_000);
});

// ── Enterprise EXDOS ──────────────────────────────────────────────────────────

const EP_DIR = process.env.EP_ROM_DIR ?? CACHE;
const EP_ROMS = ['exos21.rom', 'basic21.rom', 'exdos13.rom'];

function enterprise(): EnterpriseMachine {
  const m = new EnterpriseMachine('ep128', null);
  const view = { get: <T>(key: string, fallback: T): T => (key === 'enterprise-exdos' ? true as unknown as T : fallback) };
  for (const req of m.prepare(view)) req.apply(rom(EP_DIR, 'exdos13.rom'));
  m.loadROM(new Uint8Array([...rom(EP_DIR, 'exos21.rom'), ...rom(EP_DIR, 'basic21.rom')]));
  m.applySettings({ get: <T>(_k: string, d: T): T => d });
  m.reset();
  m.setSpeedMultiplier(2);
  return m;
}

/** An EXOS program that sets Nick's border to 0x55 and stops. */
function borderProgram(): Uint8Array {
  const code = [0x3E, 0x55, 0xD3, 0x81, 0x18, 0xFE];
  return Uint8Array.from([0x00, 0x05, code.length, 0x00, ...new Array(12).fill(0), ...code]);
}

describe.skipIf(!has(EP_DIR, EP_ROMS))('Enterprise EXDOS boots HFE, SCP and DSK disks as from .img', () => {
  const disk: DskImage = buildFatImage([{ name: 'BORDER.COM', data: borderProgram() }])!.image;
  const hfe = encodeHFE(disk);
  const cases: [string, Uint8Array][] = [
    ['border.img', serializeFatImage(disk)],
    ['border.hfe', hfe],
    ['border-v3.hfe', asV3(hfe)],
    ['border.scp', asScp(hfe)],
    ['border.dsk', serializeDSK(disk)],
  ];

  it.each(cases)('%s', async (name, data) => {
    const m = enterprise();
    const res = await m.services.media.mount(data, name);
    expect(res.ok, res.message).toBe(true);
    let ok = false;
    for (let f = 0; f < 4000 && !ok; f++) { m.tick(); ok = m.nick.border === 0x55; }
    expect(ok).toBe(true);
    m.destroy();
  }, 120_000);
});
