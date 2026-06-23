import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SpectrumModel } from '../src/spectrum.ts';
import { type MachineModel, type CpcModel, isCpcModel } from '../src/models.ts';

const ROM_URLS: Record<SpectrumModel, string> = {
  '16k':  'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum16-48/spec48.rom',
  '48k':  'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum16-48/spec48.rom',
  '128k': 'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum128-plus2/128/spec128uk.rom',
  '+2':   'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum128-plus2/plus2/plus2uk.rom',
  '+2A':  'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum-plus3/plus2a/plus2a.rom',
  '+3':   'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum-plus3/plus3/plus3.rom',
};

const CPC_ROM_BASE = 'https://zx84files.bitsparse.com/roms/';
// CPC ROM sets, concatenated to OS(16K)+BASIC(16K)[+AMSDOS(16K)] for
// CpcMemory.loadROM() to split.
const CPC_ROM_FILES: Record<CpcModel, string[]> = {
  cpc6128: ['os6128.rom', 'basic1-1.rom', 'amsdos.rom'],
  cpc664:  ['os664.rom', 'basic664.rom', 'amsdos.rom'],
  cpc464:  ['os464.rom', 'basic1-0.rom'],
};

const MF_ROM_CDN = 'https://zx84files.bitsparse.com/roms/';
const VTX_ROM_URL = 'https://zx84files.bitsparse.com/roms/vtx5000-3-1.rom';
const PLUSD_ROM_URL = 'https://zx84files.bitsparse.com/roms/plusd.rom';
const IF1_ROM_URL = 'https://zx84files.bitsparse.com/roms/if1-2.rom';

export const CACHE_DIR = path.join(import.meta.dirname!, '.cache');

async function fetchCached(url: string, filename: string): Promise<Uint8Array> {
  const cachePath = path.join(CACHE_DIR, filename);
  if (fs.existsSync(cachePath)) return new Uint8Array(fs.readFileSync(cachePath));
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${filename}`);
  const data = new Uint8Array(await resp.arrayBuffer());
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath, data);
  return data;
}

export async function fetchROM(model: MachineModel): Promise<Uint8Array> {
  if (isCpcModel(model)) {
    const files = CPC_ROM_FILES[model];
    const parts = await Promise.all(files.map(f => fetchCached(CPC_ROM_BASE + f, f)));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }
  const url = ROM_URLS[model as SpectrumModel];
  return fetchCached(url, url.split('/').pop()!);
}

export function fetchMFRom(variant: string): Promise<Uint8Array> {
  const filename = variant === 'MF1' ? 'MF1.rom' : variant === 'MF128' ? 'MF128.rom' : 'MF3.rom';
  return fetchCached(MF_ROM_CDN + filename, filename);
}

export function fetchVTXRom(): Promise<Uint8Array> {
  return fetchCached(VTX_ROM_URL, 'vtx5000-3-1.rom');
}

export function fetchPlusDRom(): Promise<Uint8Array> {
  return fetchCached(PLUSD_ROM_URL, 'plusd.rom');
}

export function fetchInterface1Rom(): Promise<Uint8Array> {
  return fetchCached(IF1_ROM_URL, 'if1-2.rom');
}
