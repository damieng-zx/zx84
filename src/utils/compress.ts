/**
 * Deflate and inflate, in one place.
 *
 * The browser's `CompressionStream` / `DecompressionStream` is the codebase's
 * dependency-free codec, and several formats (native snapshots, SZX, CSW,
 * ZIP, the library catalogs) each used to wrap it in their own hand-written
 * stream pump. This is that pump: feed the bytes, collect the output, and
 * optionally stop an inflate once it grows past a caller's cap (a zip bomb).
 *
 * `deflate` is zlib-wrapped (RFC 1950), `deflate-raw` is the bare RFC 1951
 * stream ZIP entries carry, and `gzip` is the RFC 1952 container the catalogs
 * are served in.
 *
 * Synchronous callers (the TZX parser) cannot use this — they inflate with
 * `media/tape/inflate.ts`, a table-driven decoder with no promise in sight.
 */

export type CompressionFormat = 'deflate' | 'deflate-raw' | 'gzip';

/** Feed `data` through a transform and collect what comes out. */
async function through(
  data: Uint8Array,
  transform: CompressionStream | DecompressionStream,
  maxOutput: number,
): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  // Do not await the write before reading: a large input fills the pipe and
  // would deadlock a single-threaded caller. Errors surface through the
  // reader; the catch keeps the writer's rejection from going unhandled.
  const writing = (async () => {
    await writer.write(data as unknown as BufferSource);
    await writer.close();
  })();
  writing.catch(() => {});

  const reader = transform.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxOutput) {
      await reader.cancel().catch(() => {});
      void writer.abort().catch(() => {});
      throw new Error(`Inflated data exceeds ${maxOutput} bytes`);
    }
    chunks.push(value);
  }
  await writing;

  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Compress `data` with the requested container. */
export function deflate(data: Uint8Array, format: CompressionFormat = 'deflate'): Promise<Uint8Array> {
  return through(data, new CompressionStream(format), Infinity);
}

/**
 * Decompress a stream. `maxOutput` caps the result; once the stream produces
 * more than that many bytes it is abandoned and this throws rather than
 * buffering the expansion.
 */
export function inflate(
  data: Uint8Array,
  format: CompressionFormat = 'deflate',
  maxOutput = Infinity,
): Promise<Uint8Array> {
  return through(data, new DecompressionStream(format), maxOutput);
}

/** Inflate a bare DEFLATE stream (a ZIP entry), optionally capped. */
export function inflateRaw(data: Uint8Array, maxOutput = Infinity): Promise<Uint8Array> {
  return inflate(data, 'deflate-raw', maxOutput);
}

/** Inflate a gzip stream (the library catalogs), optionally capped. */
export function gunzip(data: Uint8Array, maxOutput = Infinity): Promise<Uint8Array> {
  return inflate(data, 'gzip', maxOutput);
}
