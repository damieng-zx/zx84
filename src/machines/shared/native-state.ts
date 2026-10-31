/**
 * zx84's native machine snapshots, for the machines with no community
 * snapshot format worth the name (the Jupiter Ace, ZX80/81, Lynx, MTX, MSX,
 * Einstein, PCW and Enterprise). The same container as the Atari's `.a8state`
 * (`machines/atari/snapshots/atari-state.ts`), shared here so each machine
 * supplies only its sections:
 *
 *   magic (4 chars, one per machine)  u8 version  u8 flags (bit 0: deflated)
 *   u32 CRC-32 of the (inflated) body   u32 length of the (inflated) body
 *   body:   'HEAD' section: str model, bool media, u8 n, n × u32 ROM CRC-32
 *           then the machine's own sections (its `saveState`)
 *
 * The CRC and length are checked before anything touches the machine, so a
 * truncated or corrupted file is refused and leaves the running machine alone.
 * The ROMs are not in the file, only their CRCs, so a restore can say when the
 * state was saved under different firmware. A saved file is deflated and
 * carries the mounted disks ("media"); the browser-refresh copy (`saveSync`)
 * is neither, since a `beforeunload` handler cannot await a compressor and the
 * shell persists and remounts the disks itself.
 *
 * Each machine's `saveState` brings the machine to the end of the frame in
 * progress first (a debugger stop can leave one open), so a state is always
 * taken between frames and a restore carries on from the next.
 */

import type { MachineHost, SnapshotApplyResult, SnapshotService } from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import { StateReader, StateWriter, crc32 } from './state-io.ts';

const FLAG_DEFLATE = 0x01;
const HEADER_SIZE = 14;

/** What a machine tells the shared container and service about itself. */
export interface NativeStateSpec {
  /** File extension, with the dot (`.acestate`). */
  readonly ext: string;
  /** Four-character file magic. */
  readonly magic: string;
  /** Container version this build writes and reads. */
  readonly version: number;
  /** Machine family name for messages ("Jupiter Ace"). */
  readonly machineName: string;
  /** Largest inflated body accepted (RAM + disks, generously). */
  readonly maxBody: number;
  /** Display name of a model of this machine, or null for one this build does
   *  not have (or that belongs to another machine). */
  modelName(model: string): string | null;
}

/** The machine side of a native snapshot. */
export interface NativeStateMachine {
  readonly model: string;
  stop(): void;
  start(): Promise<void>;
  reset(): void;
  /** CRC-32s of the firmware the machine is running, in a fixed order. */
  stateRomCrcs(): number[];
  /** Write the machine's sections (after the HEAD). `withMedia`: include the
   *  mounted disks. Completes a frame a stop left open first. */
  saveState(w: StateWriter, withMedia: boolean): void;
  /** Read them back into this machine, which is the same model. Throws, with a
   *  message fit to show, for a state it cannot take (a configuration that
   *  differs from this machine's) — before changing anything, where it can. */
  loadState(r: StateReader): void;
}

export interface NativeStateInfo {
  readonly model: string;
  /** The file carries the disks, not just the machine. */
  readonly media: boolean;
  readonly romCrcs: readonly number[];
}

export interface DecodedNativeState {
  readonly info: NativeStateInfo;
  /** Positioned at the machine's first section. */
  readonly body: StateReader;
}

async function stream(data: Uint8Array, transform: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  writer.write(data as unknown as BufferSource).catch(() => {});
  writer.close().catch(() => {});
  return new Uint8Array(await new Response(transform.readable).arrayBuffer());
}

function buildBody(m: NativeStateMachine, media: boolean): Uint8Array {
  const w = new StateWriter();
  const crcs = m.stateRomCrcs();
  w.section('HEAD', () => {
    w.str(m.model);
    w.bool(media);
    w.u8(crcs.length);
    for (const c of crcs) w.u32(c);
  });
  m.saveState(w, media);
  return w.finish();
}

function wrap(spec: NativeStateSpec, body: Uint8Array, payload: Uint8Array, flags: number): Uint8Array {
  const out = new Uint8Array(HEADER_SIZE + payload.length);
  const view = new DataView(out.buffer);
  out.set(Uint8Array.from(spec.magic, c => c.charCodeAt(0)), 0);
  view.setUint8(4, spec.version);
  view.setUint8(5, flags);
  view.setUint32(6, crc32(body), true);
  view.setUint32(10, body.length, true);
  out.set(payload, HEADER_SIZE);
  return out;
}

/** The machine's state as a file: deflated, and with the disks. */
export async function saveNativeState(spec: NativeStateSpec, m: NativeStateMachine): Promise<Uint8Array> {
  const body = buildBody(m, true);
  return wrap(spec, body, await stream(body, new CompressionStream('deflate')), FLAG_DEFLATE);
}

/** The machine's state for the browser-refresh path: synchronous, stored as
 *  it is, and without the disks. */
export function saveNativeStateSync(spec: NativeStateSpec, m: NativeStateMachine): Uint8Array {
  const body = buildBody(m, false);
  return wrap(spec, body, body, 0);
}

/** Check a file's container and read its identity. Throws, with a message fit
 *  to show, for anything that is not an intact snapshot of this machine. */
export async function decodeNativeState(spec: NativeStateSpec, data: Uint8Array): Promise<DecodedNativeState> {
  const name = spec.machineName;
  if (data.length < HEADER_SIZE || String.fromCharCode(data[0], data[1], data[2], data[3]) !== spec.magic) {
    throw new Error(`Not a zx84 ${name} snapshot`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = view.getUint8(4);
  if (version !== spec.version) throw new Error(`Unsupported ${name} snapshot version ${version}`);
  const flags = view.getUint8(5);
  const crc = view.getUint32(6, true);
  const length = view.getUint32(10, true);
  if (length > spec.maxBody) throw new Error(`${name} snapshot is too large`);

  const payload = data.subarray(HEADER_SIZE);
  let body: Uint8Array;
  if ((flags & FLAG_DEFLATE) !== 0) {
    try {
      body = await stream(payload, new DecompressionStream('deflate'));
    } catch {
      throw new Error(`${name} snapshot is corrupt (it will not decompress)`);
    }
  } else {
    body = payload;
  }
  if (body.length !== length || crc32(body) !== crc) throw new Error(`${name} snapshot is corrupt or truncated`);

  const r = new StateReader(body);
  const head = r.section('HEAD');
  const model = head.str();
  if (spec.modelName(model) === null) throw new Error(`${name} snapshot names a machine this build does not have`);
  const media = head.bool();
  const romCrcs: number[] = [];
  for (let n = head.u8(); n > 0; n--) romCrcs.push(head.u32());
  return { info: { model, media, romCrcs }, body: r };
}

/** A note for the status line when the live ROMs are not the ones the state
 *  was saved under, else ''. */
export function nativeRomMismatch(m: NativeStateMachine, info: NativeStateInfo): string {
  const live = m.stateRomCrcs();
  const same = live.length === info.romCrcs.length && live.every((c, i) => c === info.romCrcs[i]);
  return same ? '' : ' — saved under a different ROM, so it may not run';
}

/**
 * Load a decoded state into `m`, which the caller has stopped. If the machine
 * refuses it part-way (a configuration it does not have), put back the state
 * it had: a refused snapshot leaves the machine as it was.
 */
function loadWithRollback(m: NativeStateMachine, body: StateReader): void {
  const backup = buildBody(m, true);
  try {
    m.loadState(body);
  } catch (e) {
    try {
      const r = new StateReader(backup);
      r.section('HEAD');
      m.loadState(r);
    } catch {
      m.reset();
    }
    throw e;
  }
}

/**
 * The SnapshotService of a machine with a native state. Applying one stops
 * the machine, restores it exactly and starts it again. A snapshot of another
 * model of the same machine asks the host for that model and reports
 * `needsReplay`, as the Spectrum does for a 128K snapshot on a 48K.
 */
export class NativeSnapshotService implements SnapshotService {
  constructor(
    private readonly spec: NativeStateSpec,
    private readonly m: NativeStateMachine,
    private readonly host: () => MachineHost | null,
  ) {}

  formats(): { ext: string; canSave: boolean }[] {
    return [{ ext: this.spec.ext, canSave: true }];
  }

  async apply(data: Uint8Array, filename: string): Promise<SnapshotApplyResult> {
    const { m, spec } = this;
    try {
      const { info, body } = await decodeNativeState(spec, data);
      if (info.model !== m.model) {
        const host = this.host();
        if (host && await host.requestModel(info.model as MachineModel, `${spec.machineName} snapshot: ${filename}`)) {
          return { ok: true, needsReplay: true, message: '' };
        }
        return { ok: false, message: `${filename} is for the ${spec.modelName(info.model)}; switch to it first` };
      }
      m.stop();
      try {
        loadWithRollback(m, body);
      } catch (e) {
        void m.start();
        return { ok: false, message: `Error: ${(e as Error).message}` };
      }
      void m.start();
      return { ok: true, message: `Loaded ${spec.machineName} snapshot: ${filename}${nativeRomMismatch(m, info)}` };
    } catch (e) {
      return { ok: false, message: `Error: ${(e as Error).message}` };
    }
  }

  async save(ext: string): Promise<Uint8Array> {
    if (ext.replace(/^\./, '').toLowerCase() !== this.spec.ext.slice(1)) {
      throw new Error(`Unsupported snapshot save format: ${ext}`);
    }
    return saveNativeState(this.spec, this.m);
  }

  saveSync(): Uint8Array {
    return saveNativeStateSync(this.spec, this.m);
  }

  /** Restore a `saveSync()` blob on the same model (browser-refresh resume). */
  async restoreSync(data: Uint8Array): Promise<boolean> {
    const m = this.m;
    try {
      const { info, body } = await decodeNativeState(this.spec, data);
      if (info.model !== m.model) return false;
      m.stop();
      loadWithRollback(m, body);
    } catch {
      return false;
    }
    void m.start();
    return true;
  }
}

/** The debugger's stop conditions, as far as a frame loop can see them. */
interface Stoppable {
  breakpoints: Set<number>;
  onTrap: ((pc: number, resume?: boolean) => boolean) | null;
  beamTarget: { frame: number; t: number } | null;
  memWatchpoints: unknown[];
  portWatchpoints: Set<number>;
  memWatchHit: unknown;
  portWatchHit: unknown;
}

/**
 * Run `fn` (the rest of a frame a stop left open) with every breakpoint, trap,
 * watchpoint and beam target out of the way, then put them back — so a
 * snapshot can bring the machine to the end of the frame without stopping
 * again part-way.
 */
export function withStopsDisarmed(m: Stoppable, fn: () => void): void {
  const { breakpoints, onTrap, beamTarget, memWatchpoints, portWatchpoints } = m;
  m.breakpoints = new Set();
  m.onTrap = null;
  m.beamTarget = null;
  m.memWatchpoints = [];
  m.portWatchpoints = new Set();
  m.memWatchHit = null;
  m.portWatchHit = null;
  try {
    fn();
  } finally {
    m.breakpoints = breakpoints;
    m.onTrap = onTrap;
    m.beamTarget = beamTarget;
    m.memWatchpoints = memWatchpoints;
    m.portWatchpoints = portWatchpoints;
    m.memWatchHit = null;
    m.portWatchHit = null;
  }
}
