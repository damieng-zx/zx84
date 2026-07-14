/**
 * The shared in-memory floppy-disk model.
 *
 * `DskImage` / `DskTrack` / `DskSector` are the universal representation every
 * disk format in this folder materialises into, and that every FDC core
 * (uPD765A on the +3/CPC, WD179x on the MGT +D / Beta Disk) reads from. Keeping
 * these types in their own dependency-free module lets the many consumers import
 * the model without pulling in any one format's parser.
 */

export interface DskSector {
  c: number;           // Cylinder (track) from CHRN
  h: number;           // Head (side) from CHRN
  r: number;           // Record (sector ID) from CHRN
  n: number;           // Size code from CHRN
  st1: number;         // FDC status register 1
  st2: number;         // FDC status register 2
  data: Uint8Array;    // Primary sector data (copies[0] when multi-copy)
  /**
   * Simon Owen v5 EDSK extension: multiple stored copies of a weak
   * sector. When sibDataLen is K × (128<<N) for K ≥ 2, the SAMdisk
   * convention is that the on-disk storage contains K real reads of
   * the same sector with weak bits manifesting as byte differences.
   * On read the FDC picks one copy at random.
   *
   * Undefined for ordinary single-copy sectors.
   */
  copies?: Uint8Array[];
}

export interface DskTrack {
  sectors: DskSector[];
  /** Map from sector R value → index into sectors[] for O(1) lookup */
  sectorMap: Map<number, number>;
  gap3: number;
  filler: number;
}

/** Where one decoded sector's data field sits in a track's cell stream, so a
 *  write can be re-encoded back into the bitstream in place (see serializeHFE). */
export interface HfeSectorLayout {
  /** Bit offset in the side's cells where the data payload begins. */
  dataBit: number;
  /** Payload byte length laid on the track (128 << N, or a truncated field). */
  len: number;
  /** Data address mark: 0xFB (data) or 0xF8 (deleted-data). */
  mark: number;
}

/**
 * Raw per-track MFM bit-cell streams retained from an HFE image. When present
 * the mounted disk *is* the HFE bitstream: the FDC's decoded {@link DskTrack}s
 * are derived from `cells[cylinder][side]` (see `hfe.ts`), not from a DSK file,
 * and the flux stays attached for on-demand re-decode / write-back.
 */
export interface HfeBitstream {
  /** cells[cylinder][side] — LSB-first MFM bit-cells, or null for a blank side. */
  cells: (Uint8Array | null)[][];
  /**
   * Physical-order data-field positions per [cylinder][side], parallel to the
   * decoded `tracks[cyl][side].sectors`, used to patch writes back into `cells`.
   */
  layout: (HfeSectorLayout[] | null)[][];
}

export interface DskImage {
  format: 'standard' | 'extended';
  numTracks: number;
  numSides: number;
  /** tracks[cylinder][side] */
  tracks: (DskTrack | null)[][];
  /** Present only for HFE-sourced disks: the retained raw MFM bitstream. */
  bitstream?: HfeBitstream;
  /** Detected disk format name (e.g. "+3DOS", "CPC System") */
  diskFormat: string;
  /** Detected copy protection scheme, or empty string */
  protection: string;
  /**
   * True for a combined "flippy" disk: two independent single-sided 180K
   * +3/PCW sides packed into one DSK (Side A = image side 0, Side B = side 1).
   * The UI offers a "flip" control; the FDC presents one side at a time via
   * its per-drive flipSide offset. See {@link isFlippyDisk}.
   */
  flippy?: boolean;
}
