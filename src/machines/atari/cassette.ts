/**
 * Atari 410/1010 program recorder.
 *
 * The mounted `.cas` image is laid out on a time line, in CPU cycles: each
 * block is a gap of mark tone, then its signal. A `data` record's signal is
 * its bytes at the record's baud rate, framed 8N1 (a 0 start bit, eight data
 * bits LSB first, a 1 stop bit), which is what the recorder's FSK demodulator
 * puts on the SIO data-in line; an `fsk ` block is the raw level sequence.
 * The tape only moves while the computer holds the motor line on (PACTL
 * bit 3 low), as the 410's remote socket does.
 *
 * The tape is read two ways:
 *
 *   - Signal level. `level()` is the data-in line at the tape's position,
 *     which POKEY samples (SKSTAT bit 4, and its serial receiver into SERIN).
 *     Custom and turbo loaders that read the recorder themselves, and the
 *     OS's own bit-level SIO, see the tape exactly as it plays.
 *   - Record level. When the OS calls SIOV for device $60 (`sio.ts`), the
 *     next record the tape reaches is handed over whole and the tape moves to
 *     the end of it, so `CLOAD`, `RUN "C:"` and boot tapes load instantly.
 *
 * Both share the one position, so a loader that stops reading part way
 * through a file, then restarts the motor and waits through the leader, finds
 * the tape where a real recorder would have left it: the records it let run
 * past are gone.
 *
 * Saving (`CSAVE`, `SAVE "C:"`, `LIST "C:"`) is recorded since the last reset
 * and offered through the Save menu as a `.cas` image.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import {
  atariCasFiles, isFskBlock, parseAtariCas, sioChecksum, writeAtariCas,
  type AtariCasFile, type AtariCasRecord,
} from '@/media/tape/atari-cas.ts';

const STANDARD_BAUD = 600;
/** The gap the OS leaves between records when it writes a file. */
const SAVE_GAP_MS = 250;
/** The long leader before the first record of a saved file. */
const SAVE_LEADER_MS = 20000;
/** Bits on tape per byte: start, eight data bits, stop. */
const FRAME_BITS = 10;

/** One block on the tape's time line. Times are CPU cycles of motor time
 *  from the start of the tape. */
interface Span {
  /** The block's signal starts here, after its gap. */
  readonly start: number;
  /** The signal ends here (and the next block's gap begins). */
  readonly end: number;
  /** Index into the records for a `data` block; -1 for raw FSK. */
  readonly record: number;
  /** A record's bytes as they are on tape, checksum included. */
  readonly bytes: Uint8Array | null;
  /** Cycles per bit of a record. */
  readonly bitCycles: number;
  /** Raw FSK: the time of each level change after `start`; the level is
   *  space (0) until the first and alternates at each one. */
  readonly edges: Float64Array | null;
}

export class AtariCassette {
  name = '';
  private data: Uint8Array | null = null;
  private records: readonly AtariCasRecord[] = [];
  private files: readonly AtariCasFile[] = [];
  private spans: Span[] = [];
  /** Tape position, in CPU cycles of motor time. */
  private pos = 0;
  /** The first span that has not run past (`spans[cursor].end > pos`). */
  private cursor = 0;
  /** Span index of each record, and of the first record of its file. */
  private recordSpan = new Int32Array(0);
  private fileStart = new Int32Array(0);
  /** The last record a fast-path read took, or -1. */
  private lastRead = -1;
  private recordedRecords: AtariCasRecord[] = [];
  /** Chunks in the mounted image that cannot be played (PWM turbo). */
  unsupportedChunks = 0;

  constructor(private readonly clockHz: number) {}

  get loaded(): boolean { return this.data !== null; }

  /** Mount a `.cas` image, rewound. False if it is not one. */
  mount(data: Uint8Array, name: string): boolean {
    const image = parseAtariCas(data);
    if (!image) return false;
    this.data = data.slice();
    this.name = name;
    this.records = image.records;
    this.files = atariCasFiles(image.records);
    this.unsupportedChunks = image.unsupportedChunks;
    const perMs = this.clockHz / 1000;
    const spans: Span[] = [];
    let t = 0;
    let record = 0;
    for (const block of image.blocks) {
      const start = t + block.gapMs * perMs;
      if (isFskBlock(block)) {
        const edges = new Float64Array(block.fsk.length);
        let at = 0;
        for (let i = 0; i < block.fsk.length; i++) {
          at += block.fsk[i] * perMs / 10;
          edges[i] = at;
        }
        t = start + at;
        spans.push({ start, end: t, record: -1, bytes: null, bitCycles: 0, edges });
      } else {
        const bitCycles = this.clockHz / (block.baud || STANDARD_BAUD);
        t = start + block.data.length * FRAME_BITS * bitCycles;
        spans.push({ start, end: t, record: record++, bytes: block.data, bitCycles, edges: null });
      }
    }
    this.spans = spans;
    this.recordSpan = new Int32Array(this.records.length);
    spans.forEach((span, i) => { if (span.record >= 0) this.recordSpan[span.record] = i; });
    this.fileStart = new Int32Array(this.records.length);
    for (const f of this.files) this.fileStart.fill(f.first, f.first, f.first + f.records);
    this.rewind();
    return true;
  }

  eject(): void {
    this.data = null;
    this.name = '';
    this.records = [];
    this.files = [];
    this.spans = [];
    this.recordSpan = new Int32Array(0);
    this.fileStart = new Int32Array(0);
    this.unsupportedChunks = 0;
    this.rewind();
  }

  rewind(): void {
    this.pos = 0;
    this.cursor = 0;
    this.lastRead = -1;
  }

  getData(): Uint8Array | null { return this.data; }

  /** Snapshot: the mounted image, where the tape is, and what has been
   *  recorded since the last reset. */
  saveState(w: StateWriter): void {
    w.bool(this.data !== null);
    if (this.data === null) return;
    w.str(this.name);
    w.bytes(this.data);
    w.f64(this.pos);
    w.u32(this.cursor);
    w.i32(this.lastRead);
    w.u32(this.recordedRecords.length);
    for (const rec of this.recordedRecords) { w.bytes(rec.data); w.f64(rec.baud); w.f64(rec.gapMs); }
  }

  /** Restore the tape a snapshot carried (or eject it, if it carried none). */
  loadState(r: StateReader): void {
    if (!r.bool()) { this.eject(); this.recordedRecords = []; return; }
    const name = r.str();
    const data = r.bytes();
    const pos = r.f64();
    const cursor = r.u32();
    const lastRead = r.i32();
    const recorded: AtariCasRecord[] = [];
    for (let n = r.u32(); n > 0; n--) recorded.push({ data: r.bytes(), baud: r.f64(), gapMs: r.f64() });
    if (!this.mount(data, name)) throw new Error('Snapshot carries a cassette image that cannot be read');
    this.pos = pos;
    this.cursor = Math.min(cursor, this.spans.length);
    this.lastRead = lastRead;
    this.recordedRecords = recorded;
  }

  /** Files on the tape, for the tape pane. */
  get fileList(): readonly AtariCasFile[] { return this.files; }

  /** Tape position in seconds of play from the start. */
  get seconds(): number { return this.pos / this.clockHz; }

  /** The tape has run past its last block (or nothing is mounted). */
  get finished(): boolean { return this.cursor >= this.spans.length; }

  /** Index of the file the next read comes from (-1 at the end of tape). */
  currentFile(): number {
    const span = this.nextSpan();
    if (span < 0) return -1;
    const next = this.spans[span].record;
    for (let i = 0; i < this.files.length; i++) {
      const f = this.files[i];
      if (next < f.first + f.records) return i;
    }
    return -1;
  }

  /** The span of the record the next `readRecord` takes, or -1 when none
   *  is left (see there for the rules). */
  private nextSpan(): number {
    const next = this.lastRead + 1;
    if (next >= this.records.length) return -1;
    if (this.fileStart[next] === next) return this.recordSpan[next];
    for (let i = this.cursor; i < this.spans.length; i++) {
      if (this.spans[i].record >= 0) return i; // raw FSK is not an SIO record
    }
    return -1;
  }

  /** Run the tape for `cycles` CPU cycles (the motor is on). */
  advance(cycles: number): void {
    this.pos += cycles;
    const spans = this.spans;
    while (this.cursor < spans.length && this.pos >= spans[this.cursor].end) this.cursor++;
  }

  /** The SIO data-in line at the tape's position: 1 (mark) through gaps and
   *  past the end of the tape, else the bit being played. */
  level(): number {
    const span = this.spans[this.cursor];
    if (span === undefined || this.pos < span.start) return 1;
    const t = this.pos - span.start;
    if (span.bytes !== null) {
      const bit = Math.floor(t / span.bitCycles);
      const byte = Math.floor(bit / FRAME_BITS);
      const k = bit - byte * FRAME_BITS;
      if (k === 0) return 0;
      if (k === FRAME_BITS - 1) return 1;
      return (span.bytes[byte] >> (k - 1)) & 1;
    }
    // Raw FSK: count the level changes already passed (binary search).
    const edges = span.edges!;
    let lo = 0;
    let hi = edges.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (edges[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo & 1;
  }

  /**
   * The next record the tape reaches, as it was on tape (checksum included),
   * with the tape moved to its end; null when no record is left.
   *
   * Records the tape has run past are gone, as on a real recorder: a loader
   * that stops reading part way through a file and then lets the motor run
   * through the next leader skips the rest of that file. Two allowances keep
   * `.cas` images loading that a strict clock would lose:
   *
   *   - a record counts as passed only once the tape is past its end, not
   *     its first bit. The gaps are the original recording's, and a real 410
   *     takes a moment to bring the tape up to speed when the motor starts;
   *   - once a file has been read to its end (or before anything has been
   *     read), the next read starts the following file at its first record
   *     however far the motor has run. The OS runs the motor for several
   *     seconds before it reads, and some images carry a leader shorter than
   *     that wait, which a tape the OS itself recorded never has.
   *
   * Only these reads count as reading. A loader that boots through SIO,
   * reads the next file itself through POKEY, then goes back to SIO would be
   * given that file again from its first record. No known tape does this,
   * and telling such a loader from the OS's own pre-read wait would take a
   * guess at what the program meant.
   */
  readRecord(): Uint8Array | null {
    const spans = this.spans;
    const i = this.nextSpan();
    if (i < 0) return null;
    const span = spans[i];
    this.pos = span.end;
    this.cursor = i + 1;
    this.lastRead = span.record;
    return this.records[span.record].data;
  }

  /** Record one frame the OS wrote (its bytes without the checksum, which
   *  SIO appends on the wire). */
  writeRecord(frame: Uint8Array): void {
    const data = new Uint8Array(frame.length + 1);
    data.set(frame);
    data[frame.length] = sioChecksum(frame);
    const gapMs = this.recordedRecords.length === 0 ? SAVE_LEADER_MS : SAVE_GAP_MS;
    this.recordedRecords.push({ data, baud: STANDARD_BAUD, gapMs });
  }

  /** Everything written since the last reset, as a `.cas` image. */
  recorded(): Uint8Array | null {
    if (this.recordedRecords.length === 0) return null;
    return writeAtariCas({ description: 'Saved by zx84', records: this.recordedRecords });
  }

  /** A reset starts a fresh recording; the mounted tape stays where it is,
   *  as a real tape would. */
  reset(): void {
    this.recordedRecords = [];
  }
}
