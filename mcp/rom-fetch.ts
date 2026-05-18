import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SpectrumModel } from '../src/spectrum.ts';

const ROM_URLS: Record<SpectrumModel, string> = {
  '16k':  'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum16-48/spec48.rom',
  '48k':  'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum16-48/spec48.rom',
  '128k': 'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum128-plus2/128/spec128uk.rom',
  '+2':   'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum128-plus2/plus2/plus2uk.rom',
  '+2A':  'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum-plus3/plus2a/plus2a.rom',
  '+3':   'https://raw.githubusercontent.com/spectrumforeveryone/zx-roms/main/spectrum-plus3/plus3/plus3.rom',
};

const MF_ROM_CDN = 'https://zx84files.bitsparse.com/roms/';
const VTX_ROM_URL = 'https://zx84files.bitsparse.com/roms/vtx5000-3-1.rom';

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

export function fetchROM(model: SpectrumModel): Promise<Uint8Array> {
  const url = ROM_URLS[model];
  return fetchCached(url, url.split('/').pop()!);
}

export function fetchMFRom(variant: string): Promise<Uint8Array> {
  const filename = variant === 'MF1' ? 'MF1.rom' : variant === 'MF128' ? 'MF128.rom' : 'MF3.rom';
  return fetchCached(MF_ROM_CDN + filename, filename);
}

export function fetchVTXRom(): Promise<Uint8Array> {
  return fetchCached(VTX_ROM_URL, 'vtx5000-3-1.rom');
}
