import * as fs from 'node:fs';
import * as path from 'node:path';
import { entryForModel } from '../src/machines/registry.ts';
import type { MachineModel } from '../src/models.ts';
import { resolveRomSource, unwrapRomArchive } from '../src/managers/rom-manager.ts';
import {
  BETADISK_ROM, IF1_ROM, PLUSD_ROM, PLUSD_SYSTEM, VTX5000_ROM, USPEECH_ROM, SP0256_AL2_ROM,
} from '../src/machines/spectrum/aux-roms.ts';
import { MSX_DISK_ROM } from '../src/machines/msx/aux-roms.ts';
import { romFilename, type MultifaceVariant } from '../src/machines/spectrum/peripherals/multiface.ts';

export const CACHE_DIR = path.join(import.meta.dirname!, '.cache');

/**
 * Cache file for a ROM source. The cache key is the source's own path — a
 * relative source (`electron/basic.rom`) keeps it as written, a full URL keeps
 * its pathname — because the basename alone is not unique: `electron/basic.rom`
 * and `memotech/basic.rom` are different chips. Nodes are checked individually
 * so a source can never escape the cache directory.
 */
export function cacheFileFor(source: string): string {
  const raw = source.includes('://') ? new URL(source).pathname : source;
  const segments = raw.split(/[\\/]+/).filter((s) => s !== '' && s !== '.' && s !== '..');
  // Keep at least the basename for a source given with no directory at all.
  if (segments.length === 0) segments.push(path.basename(raw) || 'rom');
  return path.join(CACHE_DIR, ...segments);
}

async function fetchCached(source: string): Promise<Uint8Array> {
  const filename = path.basename(source);
  const cachePath = cacheFileFor(source);
  if (fs.existsSync(cachePath)) return unwrapRomArchive(new Uint8Array(fs.readFileSync(cachePath)), filename);
  const resp = await fetch(resolveRomSource(source));
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${filename}`);
  const data = new Uint8Array(await resp.arrayBuffer());
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, data);
  return unwrapRomArchive(data, filename);
}

/** Fetch a machine-requested ROM source (a relative ROM-host path or a full URL)
 *  through the same resolve + on-disk cache as the system ROMs. */
export function fetchRomSource(source: string): Promise<Uint8Array> {
  return fetchCached(source);
}

export async function fetchROM(model: MachineModel): Promise<Uint8Array> {
  const sources = entryForModel(model).romSources(model);
  const parts = await Promise.all(sources.map(fetchCached));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

export function fetchMFRom(variant: MultifaceVariant): Promise<Uint8Array> {
  return fetchCached(romFilename(variant));
}

/** Fetch a machine's hidden default boot cartridge (CPC Plus → plus-system.cpr).
 *  The source string comes from the machine entry's `bootCartridgeSource` hook,
 *  keeping the image identity in the machine that owns it. */
export function fetchBootCartridge(source: string): Promise<Uint8Array> {
  return fetchCached(source);
}

export function fetchVTXRom(): Promise<Uint8Array> {
  return fetchCached(VTX5000_ROM);
}

export function fetchPlusDRom(): Promise<Uint8Array> {
  return fetchCached(PLUSD_ROM);
}

/** The G+DOS system file the +D boots disks without one from (optional). */
export function fetchPlusDSystemFile(): Promise<Uint8Array> {
  return fetchCached(PLUSD_SYSTEM);
}

export function fetchUspeechRom(): Promise<Uint8Array> {
  return fetchCached(USPEECH_ROM);
}

export function fetchSp0256Rom(): Promise<Uint8Array> {
  return fetchCached(SP0256_AL2_ROM);
}

export function fetchInterface1Rom(): Promise<Uint8Array> {
  return fetchCached(IF1_ROM);
}

export function fetchBetaDiskRom(): Promise<Uint8Array> {
  return fetchCached(BETADISK_ROM);
}

export function fetchMsxDiskRom(): Promise<Uint8Array> {
  return fetchCached(MSX_DISK_ROM);
}
