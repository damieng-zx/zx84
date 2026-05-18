/**
 * In-memory store for ZXTL trace lines captured by the emulator, plus a
 * chunked reader. Kept separate from the MCP tool layer so it can be tested
 * directly and reused (e.g. by the harness REPL).
 */

const DEFAULT_CHUNK_SIZE = 100;

let buffer: string[] = [];

export function clearZxtlBuffer(): void {
  buffer = [];
}

export function setZxtlBuffer(lines: readonly string[]): void {
  buffer = [...lines];
}

export function zxtlBufferSize(): number {
  return buffer.length;
}

export interface ZxtlChunk {
  /** Total lines stored. */
  total: number;
  /** Inclusive start of the returned slice. */
  start: number;
  /** Exclusive end of the returned slice. */
  end: number;
  /** Lines from [start, end). */
  lines: string[];
}

/**
 * Read a half-open range [from, to) from the buffer. If `to` is omitted the
 * chunk size defaults to {@link DEFAULT_CHUNK_SIZE}. Both bounds are clamped
 * to the buffer length, and `from` is clamped to be non-negative.
 */
export function readZxtlChunk(from: number, to?: number): ZxtlChunk {
  const total = buffer.length;
  const lo = Math.max(0, Math.min(from, total));
  const hi = Math.min(to ?? lo + DEFAULT_CHUNK_SIZE, total);
  return { total, start: lo, end: Math.max(lo, hi), lines: buffer.slice(lo, hi) };
}
