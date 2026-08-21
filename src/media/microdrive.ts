/**
 * ZX Interface 1 MDR cartridge directory reader.
 *
 * Microdrives have no stored directory: each 543-byte sector carries one file
 * record. This parser groups occupied records by their on-cartridge filename so
 * UI code can present the cartridge contents without emulating a read command.
 */

const SECTOR_BYTES = 543;
// Offset of the record header within a sector, and of the 512-byte data
// payload within a record — both 15 bytes on the IF1 cartridge format.
const RECORD_OFFSET = 15;
const RECORD_DATA_BYTES = 512;

const FILE_TYPES: Record<number, string> = {
  0: 'Program',
  1: 'Number array',
  2: 'Character array',
  3: 'Bytes',
};

export interface MdrBlock {
  name: string;
  type: string;
  bytes: number;
  records: number;
  /** Load address for a BYTES file, or null for other file types. */
  loadAddress: number | null;
  /** Physical MDR sectors belonging to this file, for the live-drive highlight. */
  sectors: number[];
  /** BASIC line to run after load, or null when the file does not auto-run. */
  autorunLine: number | null;
}

function readName(data: Uint8Array, offset: number): string {
  let name = '';
  for (let i = 0; i < 10; i++) {
    const byte = data[offset + i];
    if (byte === 0) break;
    name += String.fromCharCode(byte);
  }
  return name.trimEnd();
}

/**
 * Read occupied MDR records as logical files. The first record of a standard
 * Spectrum file includes a nine-byte header whose type and declared length are
 * used in preference to the raw record payload totals.
 */
export function parseMdrBlocks(data: Uint8Array): MdrBlock[] {
  const blocks = new Map<string, MdrBlock & { declaredBytes?: number }>();
  const sectors = Math.floor(data.length / SECTOR_BYTES);

  for (let sector = 0; sector < sectors; sector++) {
    const record = sector * SECTOR_BYTES + RECORD_OFFSET;
    const flags = data[record];
    const length = Math.min(data[record + 2] | (data[record + 3] << 8), RECORD_DATA_BYTES);
    // Bit 2 marks an occupied record. Empty formatted sectors have no content.
    if ((flags & 0x04) === 0 || length === 0) continue;

    const name = readName(data, record + 4) || '(unnamed)';
    let block = blocks.get(name);
    if (!block) {
      block = { name, type: 'Data', bytes: 0, records: 0, sectors: [], loadAddress: null, autorunLine: null };
      blocks.set(name, block);
    }
    block.bytes += length;
    block.records++;
    block.sectors.push(sector);

    // Record zero begins a Spectrum file with a compact type/length header.
    if (data[record + 1] === 0 && length >= 9) {
      const header = record + RECORD_OFFSET;
      const type = data[header];
      if (FILE_TYPES[type]) {
        block.type = FILE_TYPES[type];
        block.declaredBytes = data[header + 1] | (data[header + 2] << 8);
        if (type === 3) block.loadAddress = data[header + 3] | (data[header + 4] << 8);
        if (type === 0) {
          const line = data[header + 7] | (data[header + 8] << 8);
          block.autorunLine = line === 0x8000 ? null : line;
        }
      }
    }
  }

  return [...blocks.values()].map(({ declaredBytes, ...block }) => ({
    ...block,
    bytes: declaredBytes ?? block.bytes,
  }));
}
