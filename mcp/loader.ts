import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Spectrum, SpectrumModel } from '../src/spectrum.ts';
import { loadSNA } from '../src/snapshot/sna.ts';
import { loadZ80 } from '../src/snapshot/z80format.ts';
import { loadSZX } from '../src/snapshot/szx.ts';
import { parseFloppyImage } from '../src/plus3/hfe.ts';
import { parseMgt, mgtExtFromName } from '../src/plus3/mgt-image.ts';
import { parseTrd } from '../src/plus3/trd-image.ts';
import { parseScl } from '../src/plus3/scl-image.ts';
import { parseTZX } from '../src/tape/tzx.ts';
import { h16 } from './hex.ts';
import { fetchPlusDRom, fetchInterface1Rom, fetchBetaDiskRom } from './rom-fetch.ts';
import { state, initMachine, activeSpectrum } from './state.ts';

export async function loadFileInto(spec: Spectrum, filepath: string, diskUnit: number = 0): Promise<string> {
  if (!fs.existsSync(filepath)) return `File not found: ${filepath}`;
  const data = new Uint8Array(fs.readFileSync(filepath));
  const ext = path.extname(filepath).toLowerCase();
  const filename = path.basename(filepath);

  if (ext === '.tap') {
    spec.loadTAP(data);
    spec.tape.rewind();
    spec.tape.paused = false;
    spec.reset();
    spec.tape.startPlayback();
    return `TAP loaded: ${filename} (${spec.tape.blocks.length} blocks)`;
  } else if (ext === '.tzx') {
    const blocks = parseTZX(data);
    spec.tape.blocks = blocks;
    spec.tape.rewind();
    spec.tape.paused = false;
    spec.reset();
    spec.tape.startPlayback();
    return `TZX loaded: ${filename} (${blocks.length} blocks)`;
  } else if (ext === '.dsk' || ext === '.hfe' || ext === '.scp') {
    // A .hfe/.scp flux image routes to the Beta Disk when it is the active
    // interface; otherwise to the +3/CPC uPD765A (the .dsk default).
    const image = parseFloppyImage(data);
    if (ext !== '.dsk' && spec.betaDisk.enabled) {
      spec.loadBetaDiskDisk(image, diskUnit);
      const dl = diskUnit === 0 ? 'A' : 'B';
      return `${ext.slice(1).toUpperCase()} loaded: ${filename} → Beta Disk ${dl}: (${image.numTracks} tracks, ${image.numSides} side${image.numSides > 1 ? 's' : ''})`;
    }
    spec.loadDisk(image, diskUnit);
    const driveLetter = diskUnit === 0 ? 'A' : 'B';
    const kind = ext === '.hfe' ? 'HFE' : ext === '.scp' ? 'SCP' : 'DSK';
    return `${kind} loaded: ${filename} → Drive ${driveLetter}: (${image.numTracks} tracks, ${image.numSides} side${image.numSides > 1 ? 's' : ''})`;
  } else if (ext === '.trd' || ext === '.scl') {
    // Auto-enable the Beta Disk (load TR-DOS ROM + reset) then insert. Mutually
    // exclusive with the +D / Interface 1.
    if (!spec.betaDisk.enabled || !spec.betaDisk.romLoaded) {
      spec.betaDisk.loadROM(await fetchBetaDiskRom());
      spec.betaDisk.enabled = true;
      spec.mgtPlusD.enabled = false;
      spec.interface1.enabled = false;
      spec.reset();
    }
    const image = ext === '.scl' ? parseScl(data) : parseTrd(data);
    if (!image) return `Not a recognised Beta Disk image: ${filename} (${data.length} bytes)`;
    spec.loadBetaDiskDisk(image, diskUnit);
    const dl = diskUnit === 0 ? 'A' : 'B';
    return `Beta Disk image loaded: ${filename} → Drive ${dl}: (${image.numTracks} tracks, ${image.numSides} side${image.numSides > 1 ? 's' : ''}). Enter TR-DOS: RANDOMIZE USR 15616`;
  } else if (ext === '.mgt' || ext === '.img') {
    // Auto-enable the +D (load G+DOS ROM + reset to boot it) then insert.
    if (!spec.mgtPlusD.enabled || !spec.mgtPlusD.romLoaded) {
      const rom = await fetchPlusDRom();
      spec.mgtPlusD.loadROM(rom);
      spec.mgtPlusD.enabled = true;
      spec.reset();
    }
    const image = parseMgt(data, mgtExtFromName(filename));
    if (!image) return `Not a recognised +D image: ${filename} (${data.length} bytes)`;
    spec.loadPlusDDisk(image, diskUnit);
    const dl = diskUnit === 0 ? 'C' : 'D';
    return `+D image loaded: ${filename} → Drive ${dl}: (${image.numTracks} tracks, ${image.numSides} side${image.numSides > 1 ? 's' : ''})`;
  } else if (ext === '.mdr' || ext === '.mdv') {
    // Auto-enable the Interface 1 (load its ROM + reset so the M1 traps page it
    // in) then insert the cartridge into a microdrive (diskUnit → drive 1/2…).
    if (!spec.interface1.enabled || !spec.interface1.romLoaded) {
      spec.interface1.loadROM(await fetchInterface1Rom());
      spec.interface1.enabled = true;
      spec.reset();
    }
    spec.interface1.drives[diskUnit].loadMDR(data);
    const d = spec.interface1.drives[diskUnit];
    return `MDR loaded: ${filename} → Microdrive ${diskUnit + 1} (${d.numSectors} sectors${d.writeProtected ? ', write-protected' : ''})`;
  } else if (ext === '.sna') {
    spec.reset();
    const result = loadSNA(data, spec.cpu, spec.memory);
    spec.ula.borderColor = result.borderColor;
    return `SNA loaded: ${filename} (${result.is128K ? '128K' : '48K'}) PC=${h16(spec.cpu.pc)}`;
  } else if (ext === '.z80') {
    spec.reset();
    const result = loadZ80(data, spec.cpu, spec.memory);
    spec.ula.borderColor = result.borderColor;
    return `Z80 loaded: ${filename} (${result.is128K ? '128K' : '48K'}) PC=${h16(spec.cpu.pc)}`;
  } else if (ext === '.szx') {
    // Auto-detect model from SZX header byte 6 (machine ID).
    // Must switch before loading so memory.is128K is set correctly and ROM pages are right.
    const SZX_ID_MODEL: Record<number, SpectrumModel> = {
      0: '16k', 1: '48k', 2: '128k', 3: '+2', 4: '+2A', 5: '+3', 6: '+3',
    };
    const szxModel: SpectrumModel = (data.length >= 7 ? SZX_ID_MODEL[data[6]] : undefined) ?? '48k';
    if (szxModel !== state.model) {
      await initMachine(szxModel);
      spec = activeSpectrum()!; // szxModel is always a Spectrum model
    } else {
      spec.reset();
    }
    const result = await loadSZX(data, spec.cpu, spec.memory);
    if (result.is128K) {
      // Use direct property assignment + applyBanking() — NOT bankSwitch().
      // bankSwitch() uses slot-diffing and won't re-populate fixed slots (bank5/bank2).
      spec.memory.port7FFD    = result.port7FFD;
      spec.memory.port1FFD    = result.port1FFD;
      spec.memory.currentBank = result.port7FFD & 0x07;
      spec.memory.pagingLocked  = (result.port7FFD & 0x20) !== 0;
      spec.memory.specialPaging = (result.port1FFD & 1) !== 0;
      // +2A/+3 ROM index uses bits from both ports; others use only 7FFD bit 4
      spec.memory.currentROM = (szxModel === '+2A' || szxModel === '+3')
        ? (((result.port1FFD >> 2) & 1) << 1) | ((result.port7FFD >> 4) & 1)
        : (result.port7FFD >> 4) & 1;
      spec.memory.applyBanking();
    }
    spec.ula.borderColor = result.borderColor;
    return `SZX loaded: ${filename} (${szxModel}) PC=${h16(spec.cpu.pc)}`;
  }
  return `Unsupported file type: ${ext}`;
}

/**
 * PC of the ROM key-wait loop where the app's one-shot auto-boot trap injects
 * the loader keystrokes. Mirrors emulator.ts `bootWaitPc`.
 */
export function bootWaitPc(model: SpectrumModel): number {
  if (model === '+2A' || model === '+3') return 0x1875;   // +2A/+3 menu wait loop
  if (model === '128k' || model === '+2') return 0x0E65;  // 128K/+2 menu wait loop
  return 0x15DE;                                           // 48K editor WAIT-KEY
}

/**
 * Mount a library tape/disk's inner bytes and arm the app's one-shot auto-boot
 * trap, reproducing the exact sequence of emulator.ts `autoBootLoad` +
 * media-manager mounts: put the media on the deck/drive, reset, then trap the
 * ROM's key-wait loop so it injects the loader keystrokes (menu Enter, or a 48K
 * LOAD"" jump). Snapshots are NOT handled here — they restore running state and
 * route through `loadFileInto`. Returns a status line.
 */
export function mountAndArm(
  spec: Spectrum, data: Uint8Array, innerName: string,
  boot: 'menu' | 'rom48k', model: SpectrumModel,
): string {
  const ext = path.extname(innerName).toLowerCase();
  let mounted: string;

  if (ext === '.tzx' || ext === '.tap') {
    // Mount the tape paused — deck in play with the pause button held, exactly
    // as media-manager.applyTape does. The ROM trap at 0x056C unpauses it.
    const blocks = ext === '.tzx' ? parseTZX(data) : spec.tape.parseTAP(data);
    spec.tape.blocks = blocks;
    spec.tape.position = 0;
    spec.tape.paused = true;
    spec.tape.startPlayback();
    mounted = `tape ${innerName} (${blocks.length} blocks)`;
    // A tape on a +2A/+3 must not find a disk in A: — the boot menu's Loader
    // boots the disk in preference to the cassette. Eject so it falls through
    // (mirrors play() in LibraryBrowser).
    if (spec.fdc?.getDiskImage(0)) spec.fdc.ejectDisk(0);
  } else if (ext === '.dsk' || ext === '.hfe' || ext === '.scp') {
    spec.loadDisk(parseFloppyImage(data), 0);
    mounted = `disk ${innerName} → A:`;
  } else {
    return `Unsupported library media type: ${ext}`;
  }

  // autoBootLoad: reset, then arm the one-shot trap at the ROM key-wait loop.
  // (reset() preserves the mounted tape/disk and clears bootTrap*, so the trap
  // must be armed *after* it.)
  spec.reset();
  spec.bootTrapKind = boot;
  spec.bootTrapPc = bootWaitPc(model);
  return `Mounted ${mounted}; armed '${boot}' boot trap at PC=${h16(spec.bootTrapPc)}`;
}

export interface LoadVerdict {
  result: 'loaded' | 'failed' | 'loading';
  detail: string;
  frames: number;
}

/**
 * Run the just-armed tape loader and judge the outcome with the end-of-tape
 * oracle: once the tape has played to its end (`tape.finished`), the CPU must
 * stop hammering the ULA/EAR port. If it keeps polling port 0xFE in a tight
 * loop after the tape has run out, the loader is stranded waiting for edges that
 * will never come — the load has FAILED. If the polling stops (the loader
 * handed control to the game), it LOADED.
 *
 * `activity.ulaReads` counts every `IN (even port)` and — unlike tapePolls —
 * survives the tape going inactive, so it's the read that exposes a stuck
 * loader. The frame counter resets each frame, so we sample it per frame.
 */
export function runLoadVerdict(spec: Spectrum, budgetFrames: number): LoadVerdict {
  const POLL_BUSY = 150;  // ULA reads/frame above this ⇒ loader actively hunting edges
  const STUCK = 40;       // busy frames after end-of-tape ⇒ stranded (~0.8s)
  const QUIET = 30;       // quiet frames after end-of-tape ⇒ control handed to the game

  let stuckFrames = 0;
  let quietFrames = 0;
  let everFinished = false;
  let total = 0;

  while (total < budgetFrames) {
    spec.runUntil(1);
    total++;
    if (spec.breakpointHit >= 0 || spec.portWatchHit || spec.memWatchHit) {
      return { result: 'loading', detail: `stopped at a watch/breakpoint after ${total} frame(s)`, frames: total };
    }
    const reads = spec.activity.ulaReads;
    if (spec.tape.finished) everFinished = true;

    if (everFinished && reads > POLL_BUSY) {
      quietFrames = 0;
      if (++stuckFrames >= STUCK) {
        return {
          result: 'failed',
          detail: `end of tape reached but the CPU is still polling the EAR port (${reads} ULA reads/frame, PC=${h16(spec.cpu.pc)}) — loader stranded`,
          frames: total,
        };
      }
    } else {
      stuckFrames = 0;
      if (everFinished) {
        if (++quietFrames >= QUIET) {
          return {
            result: 'loaded',
            detail: `tape consumed and EAR polling stopped (PC=${h16(spec.cpu.pc)})`,
            frames: total,
          };
        }
      } else {
        quietFrames = 0;
      }
    }
  }
  return {
    result: 'loading',
    detail: `still loading after ${total} frame(s) (tape ${everFinished ? 'finished' : 'still playing'}, PC=${h16(spec.cpu.pc)}) — give it more frames`,
    frames: total,
  };
}
