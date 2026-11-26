/**
 * Atari 8-bit title bench.
 *
 * Boots real titles headlessly through the same machine, media and autostart
 * path the app uses, then reports crashes, dead video, freezes and the text on
 * screen at each checkpoint. Screenshots are written as PNG so a run can be
 * inspected by eye.
 *
 * Usage:
 *   npx tsx tools/atari-titles.ts --manifest tools/out/atari-titles.json \
 *     --out tools/out/atari --frames 1200
 *
 * A manifest is `{ "titles": [{ "name", "file", "model"?, "tv"?, "frames"? }] }`.
 * `--model` and `--tv` are the defaults. `--real-os` uses Atari's own OS and
 * BASIC from ATARI_ROM_DIR (or the N: collection) instead of AltirraOS.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AtariMachine } from '../src/machines/atari/atari-machine.ts';
import { atariEntry } from '../src/machines/atari/descriptor.ts';
import {
  atariInfo, ATARI_OS_SIZE, ATARI_XL_OS_SIZE, type AtariModel, type AtariRegion,
} from '../src/machines/atari/models.ts';
import { fetchBootCartridge, fetchROM } from '../mcp/rom-fetch.ts';
import { encodePNG } from '../mcp/png.ts';

interface TitleSpec {
  name: string;
  file: string;
  model?: AtariModel;
  tv?: AtariRegion;
  frames?: number;
}

interface Args {
  manifest: string;
  out: string;
  model: AtariModel;
  tv: AtariRegion;
  frames: number;
  realOs: boolean;
  only: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    manifest: 'tools/out/atari-titles.json',
    out: 'tools/out/atari',
    model: 'atari800',
    tv: 'pal',
    frames: 3600,
    realOs: false,
    only: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = (): string => argv[++i];
    if (k === '--manifest') a.manifest = v();
    else if (k === '--out') a.out = v();
    else if (k === '--model') a.model = v() as AtariModel;
    else if (k === '--tv') a.tv = v() as AtariRegion;
    else if (k === '--frames') a.frames = Number(v());
    else if (k === '--real-os') a.realOs = true;
    else if (k === '--only') a.only = v();
  }
  return a;
}

const REAL_ROM_DIR = process.env.ATARI_ROM_DIR ?? 'mcp/.cache';

function realRomFor(model: AtariModel): Uint8Array | null {
  const info = atariInfo(model);
  const names = info.xl ? ['REV02.ROM', 'ATARIXL.ROM'] : ['ATARIOSB.ROM', 'REV02.ROM'];
  for (const n of names) {
    const p = path.join(REAL_ROM_DIR, n);
    if (fs.existsSync(p)) return new Uint8Array(fs.readFileSync(p));
  }
  return null;
}

function realBasic(): Uint8Array | null {
  for (const n of ['ATARIBAS.ROM', 'ataribas.rom']) {
    const p = path.join(REAL_ROM_DIR, n);
    if (fs.existsSync(p)) return new Uint8Array(fs.readFileSync(p));
  }
  return null;
}

async function bootRom(model: AtariModel, realOs: boolean): Promise<{ rom: Uint8Array; basic: Uint8Array | null }> {
  if (realOs) {
    const os = realRomFor(model);
    if (!os) throw new Error(`No real OS image in ${REAL_ROM_DIR}`);
    const expected = atariInfo(model).xl ? ATARI_XL_OS_SIZE : ATARI_OS_SIZE;
    if (os.length !== expected) throw new Error(`Real OS is ${os.length} bytes, model needs ${expected}`);
    return { rom: os, basic: realBasic() };
  }
  const rom = await fetchROM(model);
  const basic = atariInfo(model).builtinBasic
    ? null
    : await fetchBootCartridge(atariEntry.bootCartridgeSource!(model)!);
  return { rom, basic };
}

/** A cheap fingerprint of the frame, for freeze detection. */
function frameHash(m: AtariMachine): number {
  const px = new Uint32Array(m.pixels.buffer, m.pixels.byteOffset, m.pixels.byteLength >> 2);
  let h = 2166136261;
  // Sample the active picture (336x240): every 7th pixel is plenty.
  for (let i = 0; i < px.length; i += 7) {
    h ^= px[i];
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function frameColours(m: AtariMachine): number {
  const px = new Uint32Array(m.pixels.buffer, m.pixels.byteOffset, m.pixels.byteLength >> 2);
  const seen = new Set<number>();
  for (let i = 0; i < px.length; i += 11) seen.add(px[i] >>> 8);
  return seen.size;
}

function savePng(m: AtariMachine, file: string): void {
  const png = encodePNG(new Uint8Array(m.pixels.buffer, m.pixels.byteOffset, m.pixels.byteLength),
    m.frameWidth, m.frameHeight);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
}

function screenText(m: AtariMachine): string {
  try {
    return m.ocrScreenForMcp();
  } catch (e) {
    return `<ocr failed: ${(e as Error).message}>`;
  }
}

interface Result {
  name: string;
  file: string;
  model: string;
  tv: string;
  frames: number;
  ok: boolean;
  error: string | null;
  screens: string[];
  text: string;
  pc: number;
  colours: number;
  staticFor: number;
  memoPad: boolean;
  status: string;
}

async function runTitle(spec: TitleSpec, args: Args, roms: { rom: Uint8Array; basic: Uint8Array | null }): Promise<Result> {
  const model = spec.model ?? args.model;
  const tv = spec.tv ?? args.tv;
  const total = spec.frames ?? args.frames;
  const m = new AtariMachine(model, null, tv);
  const outDir = path.join(args.out, safeName(spec.name));
  const screens: string[] = [];
  const res: Result = {
    name: spec.name, file: spec.file, model, tv, frames: total, ok: true, error: null,
    screens, text: '', pc: 0, colours: 0, staticFor: 0, memoPad: false, status: '',
  };
  try {
    m.services.roms.installSystemRom(roms.rom);
    if (roms.basic) {
      if (atariInfo(model).builtinBasic) {
        // AltirraOS for an XL is just the OS; BASIC is a separate socket the
        // shell appends, so build the combined image the descriptor describes.
        m.services.roms.installSystemRom(new Uint8Array([...roms.rom, ...roms.basic]));
      } else {
        m.services.roms.cartridge!.insert(roms.basic, '');
      }
    }
    m.reset();
    m.setSpeedMultiplier(0);

    const data = new Uint8Array(fs.readFileSync(spec.file));
    const mounted = await m.services.media.mount(data, path.basename(spec.file));
    if (!mounted.ok) throw new Error(mounted.message);
    res.status = mounted.message;

    const checkpoints = [60, 300, 900, 1800, 3600, 7200].filter(f => f <= total);
    if (checkpoints.length === 0 || checkpoints[checkpoints.length - 1] !== total) checkpoints.push(total);
    let lastHash = -1;
    let sameFor = 0;
    let ran = 0;
    for (const at of checkpoints) {
      for (; ran < at; ran++) {
        m.tick();
        const h = frameHash(m);
        if (h === lastHash) sameFor++;
        else { sameFor = 0; lastHash = h; }
      }
      res.colours = frameColours(m);
      res.staticFor = sameFor;
      const shot = path.join(outDir, `${String(at).padStart(4, '0')}.png`);
      savePng(m, shot);
      screens.push(shot);
    }
    res.pc = m.cpu.pc;
    const text = screenText(m);
    res.memoPad = /memo pad/i.test(text);
    res.text = text.split('\n').slice(0, 8).join(' | ');
    // The OS's memo pad means the program fell out to the OS: it crashed, or
    // it is a boot stub whose disk is missing. Either way, not a running game.
    if (res.memoPad) res.ok = false;
  } catch (e) {
    res.ok = false;
    res.error = (e as Error).message;
    try { savePng(m, path.join(outDir, `${String(total).padStart(4, '0')}-crash.png`)); } catch { /* */ }
    res.pc = m.cpu.pc;
  } finally {
    m.destroy();
  }
  return res;
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._ -]+/g, '_').slice(0, 100);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rawManifest = fs.readFileSync(args.manifest, 'utf8').replace(/^\uFEFF/, '');
  const manifest = JSON.parse(rawManifest) as { titles: TitleSpec[] };
  const titles = args.only
    ? manifest.titles.filter(t => t.name.toLowerCase().includes(args.only!.toLowerCase()))
    : manifest.titles;
  fs.mkdirSync(args.out, { recursive: true });

  const romCache = new Map<string, Promise<{ rom: Uint8Array; basic: Uint8Array | null }>>();
  const romsFor = (model: AtariModel) => {
    let p = romCache.get(model);
    if (!p) { p = bootRom(model, args.realOs); romCache.set(model, p); }
    return p;
  };

  const results: Result[] = [];
  for (const t of titles) {
    const model = t.model ?? args.model;
    const roms = await romsFor(model);
    process.stdout.write(`\n=== ${t.name} (${model}) ===\n`);
    const r = await runTitle(t, args, roms);
    results.push(r);
    const flag = r.ok ? 'ok' : 'FAIL';
    console.log(`${flag} pc=$${r.pc.toString(16)} colours=${r.colours} static=${r.staticFor}`
      + `\n    ${r.error ?? r.text}`);
  }

  fs.writeFileSync(path.join(args.out, 'results.json'), JSON.stringify(results, null, 2));
  const bad = results.filter(r => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} ran`);
  if (bad.length > 0) {
    console.log('Failures:');
    for (const r of bad) console.log(`  ${r.name}: ${r.error ?? (r.memoPad ? 'fell back to the memo pad' : 'failed')}`);
  }
}

await main();
