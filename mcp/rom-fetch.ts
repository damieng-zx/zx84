import * as fs from 'node:fs';
import * as path from 'node:path';
import { entryForModel } from '../src/machines/registry.ts';
import type { MachineModel } from '../src/models.ts';
import { resolveRomSource, unwrapRomArchive } from '../src/managers/rom-manager.ts';
import {
  BETADISK_ROM, IF1_ROM, PLUSD_ROM, VTX5000_ROM,
} from '../src/machines/spectrum/aux-roms.ts';
import { romFilename, type MultifaceVariant } from '../src/machines/spectrum/peripherals/multiface.ts';

export const CACHE_DIR = path.join(import.meta.dirname!, '.cache');

async function fetchCached(source: string): Promise<Uint8Array> {
  const url = resolveRomSource(source);
  const filename = path.basename(new URL(url).pathname);
  const cachePath = path.join(CACHE_DIR, filename);
  if (fs.existsSync(cachePath)) return unwrapRomArchive(new Uint8Array(fs.readFileSync(cachePath)), filename);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${filename}`);
  const data = new Uint8Array(await resp.arrayBuffer());
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath, data);
  return unwrapRomArchive(data, filename);
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

export function fetchInterface1Rom(): Promise<Uint8Array> {
  return fetchCached(IF1_ROM);
}

export function fetchBetaDiskRom(): Promise<Uint8Array> {
  return fetchCached(BETADISK_ROM);
}
