import type { MediaService, MediaTypeDescriptor, MediaTargetId, MountResult } from '@/machines/machine.ts';
import type { Zx8xMachine } from '../zx8x-machine.ts';
import type { NativeSnapshotService } from '@/machines/shared/native-state.ts';
import { isZx8xProgramFile, splitP81, zx8xTapeBlocks } from './tape.ts';

/**
 * ZX80/ZX81 media: program images and tape recordings go into the cassette
 * deck; `.zx8xstate` snapshots restore the machine.
 *
 * A program image mounted while "Fast ROM loading" is on is also loaded
 * straight into RAM and run, as if LOAD "" had just read it; with the option
 * off it waits in the deck for the user's LOAD. A tape inserted while the
 * ROM's LOAD is already listening is played into that LOAD — and with the
 * trap on, its first program is delivered whatever name LOAD asked for, as
 * if the user had pressed PLAY on the tape they meant.
 */
export class Zx8xMediaService implements MediaService {
  constructor(private readonly machine: Zx8xMachine, private readonly snapshots: NativeSnapshotService) {}

  accepts(): MediaTypeDescriptor[] {
    const programs: MediaTypeDescriptor[] = this.machine.model === 'zx80'
      ? [{ ext: '.o', target: 'tape' }, { ext: '.80', target: 'tape' }]
      : [{ ext: '.p', target: 'tape' }, { ext: '.81', target: 'tape' }, { ext: '.p81', target: 'tape' }];
    return [
      ...programs,
      { ext: '.tzx', target: 'tape' },
      { ext: '.wav', target: 'tape' },
      { ext: '.zx8xstate', target: 'snapshot' },
    ];
  }

  async mount(data: Uint8Array, filename: string, _target?: MediaTargetId): Promise<MountResult> {
    const m = this.machine;
    if (/\.zx8xstate$/i.test(filename)) {
      // A state names its model: one for the other machine asks the host to
      // switch and is then replayed into the new machine.
      const r = await this.snapshots.apply(data, filename);
      if (r.needsReplay) return { ok: true, replay: true, message: r.message };
      return r.ok ? { ok: true, target: 'snapshot', message: r.message } : { ok: false, message: r.message };
    }
    const isRecording = /\.(tzx|wav)$/i.test(filename);
    const isProgram = isZx8xProgramFile(m.model, filename);
    if (!isRecording && !isProgram) {
      return { ok: false, message: m.model === 'zx80' ? 'ZX80 accepts .o and .80 program images, .tzx and .wav tapes and .zx8xstate snapshots' : 'ZX81 accepts .p, .81 and .p81 program images, .tzx and .wav tapes and .zx8xstate snapshots' };
    }
    const payload = /\.p81$/i.test(filename) ? (splitP81(data)?.payload ?? data) : data;
    const address = m.model === 'zx80' ? 0x4000 : 0x4009;
    if (isProgram && payload.length > m.memory.ramSize - (address - 0x4000)) {
      return { ok: false, message: `${filename} needs 16KB RAM` };
    }
    let tape: ReturnType<typeof zx8xTapeBlocks>;
    try {
      tape = zx8xTapeBlocks(m.model, data, filename);
    } catch (e) {
      return { ok: false, message: `Error: ${(e as Error).message}` };
    }
    const awaiting = m.awaitingTapeLoad;
    m.cassette.mount(tape.blocks, filename, 0, tape.program ? [tape.program] : undefined);
    if (awaiting) {
      // The user is pressing PLAY for the LOAD that is waiting.
      if (m.tapeFastRom) m.cassette.cueFirst();
      return { ok: true, target: 'tape', message: `Tape playing: ${filename}` };
    }
    const first = m.cassette.programs[0];
    if (isProgram && m.tapeFastRom && first) {
      m.loadProgram(first.data, address);
      m.cassette.markPlayed(first);
      return { ok: true, target: 'tape', message: `Program loaded: ${filename}` };
    }
    const load = m.model === 'zx80' ? 'LOAD' : 'LOAD ""';
    return { ok: true, target: 'tape', message: `Tape inserted: ${filename} — type ${load} to load it` };
  }
}
