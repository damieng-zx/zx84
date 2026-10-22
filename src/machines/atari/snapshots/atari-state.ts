/**
 * zx84's native Atari snapshot (`.a8state`).
 *
 * The machine's own state, written by `AtariMachine.saveState` and read back
 * by `loadState`, so a restore is exact: the same CPU cycle, the same ANTIC
 * walk, the same POKEY counters. It is not a format other emulators read;
 * Altirra's save states carry its cycle-exact internals (scheduler offsets,
 * the DMA pipeline, mid-instruction CPU phase) that have no counterpart here.
 *
 * File layout:
 *
 *   'ZXA8'  u8 version  u8 flags (bit 0: body is zlib-deflated)
 *   u32 CRC-32 of the (inflated) body   u32 length of the (inflated) body
 *   body:   'HEAD' section (model, region, what is inside, ROM checksums)
 *           then the machine's sections (see AtariMachine.saveState)
 *
 * The CRC and length are checked before anything touches the machine, so a
 * truncated or corrupted file is refused and leaves the running machine alone.
 * The OS and BASIC ROMs are not in the file, only their CRCs, so a restore can
 * say when the state was saved under different firmware (RAM then holds
 * pointers into a ROM that is no longer there).
 */

import { StateReader, StateWriter, crc32 } from '@/machines/shared/state-io.ts';
import type { AtariMachine } from '../atari-machine.ts';
import { isAtariModel, type AtariModel, type AtariRegion } from '../models.ts';

const MAGIC = 'ZXA8';
const VERSION = 1;
const FLAG_DEFLATE = 0x01;
const HEADER_SIZE = 14;
/** Largest body accepted: a 128K machine with four 360K disks, generously. */
const MAX_BODY = 8 << 20;

export interface AtariStateInfo {
  readonly model: AtariModel;
  readonly region: AtariRegion;
  /** The file carries the disks and tape, not just the machine. */
  readonly media: boolean;
  /** CRC-32 of the OS ROM and of the internal BASIC ROM (0 when there is none). */
  readonly osCrc: number;
  readonly basicCrc: number;
}

export interface DecodedAtariState {
  readonly info: AtariStateInfo;
  /** Positioned at the machine's first section. */
  readonly body: StateReader;
}

async function stream(data: Uint8Array, transform: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  writer.write(data as unknown as BufferSource).catch(() => {});
  writer.close().catch(() => {});
  return new Uint8Array(await new Response(transform.readable).arrayBuffer());
}

function romCrcs(m: AtariMachine): { os: number; basic: number } {
  return { os: crc32(m.memory.osRom), basic: m.memory.basicRom ? crc32(m.memory.basicRom) : 0 };
}

function buildBody(m: AtariMachine, media: boolean): Uint8Array {
  const w = new StateWriter();
  const crcs = romCrcs(m);
  w.section('HEAD', () => {
    w.str(m.model);
    w.str(m.region);
    w.bool(media);
    w.u32(crcs.os);
    w.u32(crcs.basic);
  });
  m.saveState(w, media);
  return w.finish();
}

function wrap(body: Uint8Array, payload: Uint8Array, flags: number): Uint8Array {
  const out = new Uint8Array(HEADER_SIZE + payload.length);
  const view = new DataView(out.buffer);
  out.set(Uint8Array.from(MAGIC, c => c.charCodeAt(0)), 0);
  view.setUint8(4, VERSION);
  view.setUint8(5, flags);
  view.setUint32(6, crc32(body), true);
  view.setUint32(10, body.length, true);
  out.set(payload, HEADER_SIZE);
  return out;
}

/** The machine's state as a file: deflated, and with the disks and tape. */
export async function saveAtariState(m: AtariMachine): Promise<Uint8Array> {
  const body = buildBody(m, true);
  return wrap(body, await stream(body, new CompressionStream('deflate')), FLAG_DEFLATE);
}

/** The machine's state for the browser-refresh path: synchronous (a
 *  `beforeunload` handler cannot await a compressor), so stored as it is, and
 *  without the media, which the shell persists and remounts itself. */
export function saveAtariStateSync(m: AtariMachine): Uint8Array {
  const body = buildBody(m, false);
  return wrap(body, body, 0);
}

/** Check a file's container and read its identity. Throws, with a message
 *  fit to show, for anything that is not an intact `.a8state`. */
export async function decodeAtariState(data: Uint8Array): Promise<DecodedAtariState> {
  if (data.length < HEADER_SIZE || String.fromCharCode(data[0], data[1], data[2], data[3]) !== MAGIC) {
    throw new Error('Not a zx84 Atari snapshot');
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = view.getUint8(4);
  if (version !== VERSION) throw new Error(`Unsupported Atari snapshot version ${version}`);
  const flags = view.getUint8(5);
  const crc = view.getUint32(6, true);
  const length = view.getUint32(10, true);
  if (length > MAX_BODY) throw new Error('Atari snapshot is too large');

  const payload = data.subarray(HEADER_SIZE);
  let body: Uint8Array;
  if ((flags & FLAG_DEFLATE) !== 0) {
    try {
      body = await stream(payload, new DecompressionStream('deflate'));
    } catch {
      throw new Error('Atari snapshot is corrupt (it will not decompress)');
    }
  } else {
    body = payload;
  }
  if (body.length !== length || crc32(body) !== crc) throw new Error('Atari snapshot is corrupt or truncated');

  const r = new StateReader(body);
  const head = r.section('HEAD');
  const model = head.str();
  const region = head.str();
  if (!isAtariModel(model as never) || (region !== 'ntsc' && region !== 'pal')) {
    throw new Error('Atari snapshot names a machine this build does not have');
  }
  return {
    info: {
      model: model as AtariModel,
      region,
      media: head.bool(),
      osCrc: head.u32(),
      basicCrc: head.u32(),
    },
    body: r,
  };
}

/** A note for the status line when the live ROMs are not the ones the state
 *  was saved under, else ''. */
export function romMismatch(m: AtariMachine, info: AtariStateInfo): string {
  const crcs = romCrcs(m);
  const osDiffers = crcs.os !== info.osCrc;
  const basicDiffers = m.memory.basicRom !== null && crcs.basic !== info.basicCrc;
  if (!osDiffers && !basicDiffers) return '';
  return ` — saved under a different ${osDiffers ? 'OS' : 'BASIC'} ROM, so it may not run`;
}
