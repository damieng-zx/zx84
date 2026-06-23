/**
 * IndexedDB + localStorage helpers for ROM/file persistence.
 */

const DB_NAME = 'zx84';
const DB_VERSION = 1;
const STORE_NAME = 'roms';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbSave(key: string, data: Uint8Array): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(data, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function dbLoad(key: string): Promise<Uint8Array | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

export function getSaved(key: string, fallback: string): string {
  try { return localStorage.getItem(`zx84-${key}`) ?? fallback; } catch { return fallback; }
}

export function setSaved(key: string, value: string): void {
  try { localStorage.setItem(`zx84-${key}`, value); } catch { /* */ }
}

export async function persistLastFile(data: Uint8Array, filename: string): Promise<void> {
  try {
    await dbSave('last-file', data);
    localStorage.setItem('zx84-last-file', filename);
  } catch { /* quota or write error */ }
}

export async function restoreLastFile(): Promise<{ data: Uint8Array; name: string } | null> {
  try {
    const name = localStorage.getItem('zx84-last-file');
    if (!name) return null;
    const data = await dbLoad('last-file');
    if (!data) return null;
    return { data, name };
  } catch { return null; }
}

export function clearLastFile(): void {
  try {
    localStorage.removeItem('zx84-last-file');
  } catch { /* */ }
}

// ── Per-media persistence (tape, disk A, disk B) ─────────────────────

export async function persistTape(data: Uint8Array, filename: string): Promise<void> {
  try {
    await dbSave('tape-file', data);
    localStorage.setItem('zx84-tape-file', filename);
  } catch { /* quota or write error */ }
}

export async function restoreTape(): Promise<{ data: Uint8Array; name: string } | null> {
  try {
    const name = localStorage.getItem('zx84-tape-file');
    if (!name) return null;
    const data = await dbLoad('tape-file');
    // Empty-array sentinel is how clearTape soft-deletes the blob — treat it
    // the same as a missing entry, matching restoreDisk's contract.
    if (!data || data.length === 0) return null;
    return { data, name };
  } catch { return null; }
}

export function clearTape(): void {
  try {
    localStorage.removeItem('zx84-tape-file');
    dbSave('tape-file', new Uint8Array(0)).catch(() => {});
  } catch { /* */ }
}

// Disks are keyed by a single-letter suffix so each drive gets its own LS
// filename + IDB blob: the main uPD765A drives are 'a'/'b' (+3 / CPC A:/B:),
// the MGT +D's WD1772 drives are 'c'/'d' (C:/D:). Both FDCs number their units
// 0/1, so the +D helpers map onto a distinct suffix pair.

async function persistDiskSuffix(suffix: string, data: Uint8Array, filename: string): Promise<void> {
  try {
    await dbSave(`disk-${suffix}-file`, data);
    localStorage.setItem(`zx84-disk-${suffix}-file`, filename);
  } catch { /* quota or write error */ }
}

async function restoreDiskSuffix(suffix: string): Promise<{ data: Uint8Array; name: string } | null> {
  try {
    const name = localStorage.getItem(`zx84-disk-${suffix}-file`);
    if (!name) return null;
    const data = await dbLoad(`disk-${suffix}-file`);
    if (!data || data.length === 0) return null;
    return { data, name };
  } catch { return null; }
}

function clearDiskSuffix(suffix: string): void {
  try {
    localStorage.removeItem(`zx84-disk-${suffix}-file`);
    dbSave(`disk-${suffix}-file`, new Uint8Array(0)).catch(() => {});
  } catch { /* */ }
}

export async function persistDisk(unit: number, data: Uint8Array, filename: string): Promise<void> {
  return persistDiskSuffix(unit === 0 ? 'a' : 'b', data, filename);
}

export async function restoreDisk(unit: number): Promise<{ data: Uint8Array; name: string } | null> {
  return restoreDiskSuffix(unit === 0 ? 'a' : 'b');
}

export function clearDisk(unit: number): void {
  clearDiskSuffix(unit === 0 ? 'a' : 'b');
}

// MGT +D drives C:/D: (WD1772 units 0/1) — separate keys from the main FDC.

export async function persistPlusDDisk(unit: number, data: Uint8Array, filename: string): Promise<void> {
  return persistDiskSuffix(unit === 0 ? 'c' : 'd', data, filename);
}

export async function restorePlusDDisk(unit: number): Promise<{ data: Uint8Array; name: string } | null> {
  return restoreDiskSuffix(unit === 0 ? 'c' : 'd');
}

export function clearPlusDDisk(unit: number): void {
  clearDiskSuffix(unit === 0 ? 'c' : 'd');
}

// ZX Interface 1 microdrives (8 drives) — one persisted MDR image per drive.

export async function persistMicrodrive(unit: number, data: Uint8Array, filename: string): Promise<void> {
  return persistDiskSuffix(`mdr${unit}`, data, filename);
}

export async function restoreMicrodrive(unit: number): Promise<{ data: Uint8Array; name: string } | null> {
  return restoreDiskSuffix(`mdr${unit}`);
}

export function clearMicrodrive(unit: number): void {
  clearDiskSuffix(`mdr${unit}`);
}
