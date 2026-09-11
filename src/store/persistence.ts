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

export async function dbDelete(key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
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

/**
 * Factory reset: wipe every trace of persisted state for this origin — the
 * whole localStorage and the entire IndexedDB database (cached ROMs, disks,
 * tapes, snapshots, last-file). Used by the "Reset settings ▸ All" action so
 * that ANY stale or corrupt entry is cleared, not just the setting keys we know
 * how to enumerate. A bad cached ROM in particular can only be cleared here (and
 * re-fetched from the CDN on the next load), which is why the caller reloads
 * afterwards.
 */
export async function factoryReset(): Promise<void> {
  try { localStorage.clear(); } catch { /* private mode / disabled */ }
  await new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB_NAME);
      // Resolve on any terminal outcome. `onblocked` fires when another tab
      // still holds the DB open; our own helpers close after each op, so this
      // is only defensive — we resolve regardless rather than hang the reset.
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch { resolve(); }
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

// Tapes are keyed by platform (`key` = the machine kind: spectrum / cpc /
// einstein / msx) so each system restores its own tape across a reload — a
// Spectrum .tzx never turns up on the MSX and vice-versa.
export async function persistTape(key: string, data: Uint8Array, filename: string): Promise<void> {
  try {
    await dbSave(`tape-${key}-file`, data);
    localStorage.setItem(`zx84-tape-${key}-file`, filename);
  } catch { /* quota or write error */ }
}

export async function restoreTape(key: string): Promise<{ data: Uint8Array; name: string } | null> {
  try {
    const name = localStorage.getItem(`zx84-tape-${key}-file`);
    if (!name) return null;
    const data = await dbLoad(`tape-${key}-file`);
    // Empty-array sentinel is how clearTape soft-deletes the blob — treat it
    // the same as a missing entry, matching restoreDisk's contract.
    if (!data || data.length === 0) return null;
    return { data, name };
  } catch { return null; }
}

export function clearTape(key: string): void {
  try {
    localStorage.removeItem(`zx84-tape-${key}-file`);
    dbSave(`tape-${key}-file`, new Uint8Array(0)).catch(() => {});
  } catch { /* */ }
}

// Cartridges are keyed by platform kind (only the CPC Plus / GX4000 has a slot),
// so a user-mounted .CPR survives a reload. The hidden plus-system.cpr firmware
// cartridge is NOT persisted here — an empty entry restores to the phantom.
export async function persistCartridge(key: string, data: Uint8Array, filename: string): Promise<void> {
  try {
    await dbSave(`cart-${key}-file`, data);
    localStorage.setItem(`zx84-cart-${key}-file`, filename);
  } catch { /* quota or write error */ }
}

export async function restoreCartridge(key: string): Promise<{ data: Uint8Array; name: string } | null> {
  try {
    const name = localStorage.getItem(`zx84-cart-${key}-file`);
    if (!name) return null;
    const data = await dbLoad(`cart-${key}-file`);
    if (!data || data.length === 0) return null;
    return { data, name };
  } catch { return null; }
}

export function clearCartridge(key: string): void {
  try {
    localStorage.removeItem(`zx84-cart-${key}-file`);
    dbSave(`cart-${key}-file`, new Uint8Array(0)).catch(() => {});
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

/** The Spectrum's original A/B keys remain its own; other motherboards have
 *  separate built-in drives, including the Lynx's C/D (never the +D's C/D). */
function diskSuffix(unit: number, kind: string): string {
  const letter = 'abcd'[unit] ?? 'a';
  return kind === 'spectrum' && unit < 2 ? letter : `${kind}-builtin-${letter}`;
}

export async function persistDisk(unit: number, data: Uint8Array, filename: string, kind = 'spectrum'): Promise<void> {
  return persistDiskSuffix(diskSuffix(unit, kind), data, filename);
}

export async function restoreDisk(unit: number, kind = 'spectrum'): Promise<{ data: Uint8Array; name: string } | null> {
  return restoreDiskSuffix(diskSuffix(unit, kind));
}

export function clearDisk(unit: number, kind = 'spectrum'): void {
  clearDiskSuffix(diskSuffix(unit, kind));
}

/** Move pre-isolation SAM/Lynx images out of the Spectrum's historical keys.
 *  Run at startup before any mounts. LDF and raw MGT/IMG identify their owner;
 *  ambiguous DSK/HFE/SCP images use the last saved model (Spectrum by default).
 *  Legacy records have no owner metadata, so earlier overwritten images cannot
 *  be recovered. A failed migration keeps the original available for retry. */
export async function migrateDiskStorage(): Promise<void> {
  if (getSaved('disk-storage-version', '') === '2') return;
  const lastModel = getSaved('model', '128k');
  let complete = true;
  for (let unit = 0; unit < 4; unit++) {
    const legacy = 'abcd'[unit];
    const name = getSaved(`disk-${legacy}-file`, '');
    if (!name) continue;
    let data: Uint8Array | null;
    try { data = await dbLoad(`disk-${legacy}-file`); }
    catch { complete = false; continue; }
    if (!data?.length) continue;
    const saved = { name, data };
    const kind = /\.ldf$/i.test(saved.name) ? 'lynx'
      : unit < 2 && (/\.(mgt|img)$/i.test(saved.name)
        || (saved.data[0] === 0x1F && saved.data[1] === 0x8B)
        || /^sam(256|512)$/.test(lastModel)) ? 'sam' : null;
    if (!kind) continue;
    const suffix = diskSuffix(unit, kind);
    try {
      // Never replace an image already saved by this version.
      if (localStorage.getItem(`zx84-disk-${suffix}-file`) === null) {
        await dbSave(`disk-${suffix}-file`, saved.data);
        localStorage.setItem(`zx84-disk-${suffix}-file`, saved.name);
      }
      localStorage.removeItem(`zx84-disk-${legacy}-file`);
    } catch { complete = false; /* retain the legacy record until migration succeeds */ }
  }
  // A/B remain live Spectrum keys: never reclassify future Spectrum mounts
  // just because the last-used machine later changes to a SAM.
  if (complete) setSaved('disk-storage-version', '2');
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

// Beta Disk drives (WD1793 units 0/1) — separate keys again, since the Beta
// Disk and the +D are mutually exclusive but persist independently.

export async function persistBetaDiskDisk(unit: number, data: Uint8Array, filename: string): Promise<void> {
  return persistDiskSuffix(unit === 0 ? 'betac' : 'betad', data, filename);
}

export async function restoreBetaDiskDisk(unit: number): Promise<{ data: Uint8Array; name: string } | null> {
  return restoreDiskSuffix(unit === 0 ? 'betac' : 'betad');
}

export function clearBetaDiskDisk(unit: number): void {
  clearDiskSuffix(unit === 0 ? 'betac' : 'betad');
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
