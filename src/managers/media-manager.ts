/**
 * Media Manager - handles tape and disk loading, routing, and persistence.
 *
 * Responsibilities:
 * - Load and route TAP, TZX, DSK, SNA, Z80, SZX, SP files
 * - Handle ZIP file unpacking and file selection
 * - Persist last-loaded file and media state
 * - Coordinate with Spectrum instance for media operations
 */

import type { Spectrum } from '@/spectrum.ts';
import type { Machine } from '@/machine.ts';
import { type SpectrumModel, is128kClass, isPlus2AClass } from '@/models.ts';
import type { TapeBlock } from '@/tape/tap.ts';
import { parseTZX } from '@/tape/tzx.ts';
import type { DskImage } from '@/floppy/disk-image.ts';
import { parseFloppyImage } from '@/floppy/hfe.ts';
import { unzip } from '@/snapshot/zip.ts';
import { showFilePicker } from '@/ui/zip-picker.ts';
import { loadSNA } from '@/snapshot/sna.ts';
import { loadZ80 } from '@/snapshot/z80format.ts';
import { loadSZX, applySZXPaging } from '@/snapshot/szx.ts';
import { loadSP } from '@/snapshot/sp.ts';
import { persistLastFile, persistTape, clearTape, persistDisk, clearDisk } from '@/store/persistence.ts';

export interface MediaLoadCallbacks {
  onStatus: (msg: string) => void;
  onTapeLoaded: (blocks: TapeBlock[], filename: string) => void;
  onDiskLoaded: (image: DskImage, filename: string, unit: number) => void;
  onSnapshotLoaded: (filename: string) => void;
  unpause: () => void;
  /** Switch to a 128K-class machine. The switch destroys the current machine
   *  and creates a new one, so the caller must re-bind to the returned
   *  instance and model. Returns null when no 128K ROM is available (the
   *  machine in service is unchanged). */
  ensure128kROM: () => Promise<{ spectrum: Spectrum; model: SpectrumModel } | null>;
  /** Re-dispatch a file extracted from a ZIP through the top-level loader, so
   *  peripheral formats (.mdr microdrive, .mgt +D) the MediaManager doesn't
   *  itself handle still reach their loaders. */
  loadExtracted?: (data: Uint8Array, filename: string, unit?: number) => Promise<void>;
}

/** Render a drive-unit number as a letter: 0→A, 1→B, 2→C, 3→D, … */
function driveLetter(unit: number): string {
  return String.fromCharCode(0x41 + unit);
}

export class MediaManager {
  /**
   * Load tape (TAP, TZX, or CPC CDT) into the machine. CDT is byte-for-byte the
   * same container as TZX, so both parse through parseTZX.
   */
  applyTape(
    machine: Machine,
    data: Uint8Array,
    filename: string,
    callbacks: Pick<MediaLoadCallbacks, 'onStatus' | 'onTapeLoaded' | 'unpause'>
  ): void {
    // Stop the machine first to prevent the frame loop from interfering
    machine.stop();

    const ext = filename.toLowerCase().split('.').pop();
    let blocks: TapeBlock[];

    try {
      if (ext === 'tzx' || ext === 'cdt') {
        blocks = parseTZX(data);
      } else {
        blocks = machine.tape.parseTAP(data);
      }
    } catch (e) {
      machine.start();
      callbacks.onStatus(`Error: ${(e as Error).message}`);
      return;
    }

    // Set tape state on the deck in play mode but paused —
    // like pressing PLAY on a real cassette deck but with the pause button held.
    machine.tape.blocks = blocks;
    machine.tape.position = 0;
    machine.tape.paused = true;
    machine.tape.startPlayback();

    // Resume without resetting — just swap the tape on the deck
    machine.start();

    // Update UI via callback
    callbacks.onTapeLoaded(blocks, filename);
    callbacks.unpause();
    callbacks.onStatus(`Tape loaded: ${filename}`);

    // Persist for next session
    persistLastFile(data, filename);
    persistTape(data, filename);
  }

  /**
   * Eject tape from the spectrum instance.
   */
  ejectTape(
    machine: Machine,
    onTapeEjected: () => void,
    onStatus: (msg: string) => void
  ): void {
    machine.tape.stopPlayback();
    machine.tape.blocks = [];
    machine.tape.position = 0;
    machine.tape.paused = true;

    onTapeEjected();
    clearTape();
    onStatus('Tape ejected');
  }

  /**
   * Load disk image into the FDC.
   */
  loadDisk(
    spectrum: Spectrum,
    data: Uint8Array,
    filename: string,
    unit: number,
    callbacks: Pick<MediaLoadCallbacks, 'onStatus' | 'onDiskLoaded'>
  ): void {
    // Stop the frame loop before swapping the image so the FDC can't be
    // mid-operation when its disk is replaced — same pattern applyTape /
    // applySnapshot already use.
    spectrum.stop();
    try {
      const image = parseFloppyImage(data);
      callbacks.onDiskLoaded(image, filename, unit);

      spectrum.loadDisk(image, unit);
      callbacks.onStatus(`Disk ${driveLetter(unit)}: loaded: ${filename}`);

      if (unit === 0) persistLastFile(data, filename);
      persistDisk(unit, data, filename);
    } catch (e) {
      callbacks.onStatus(`DSK error: ${(e as Error).message}`);
    } finally {
      spectrum.start();
    }
  }

  /**
   * Eject disk from the FDC.
   */
  ejectDisk(
    spectrum: Spectrum,
    unit: number,
    onDiskEjected: (unit: number) => void,
    onStatus: (msg: string) => void
  ): void {
    if (spectrum.fdc) spectrum.fdc.ejectDisk(unit);
    clearDisk(unit);
    onDiskEjected(unit);
    onStatus(`Disk ${driveLetter(unit)}: ejected`);
  }

  /**
   * Load snapshot (SNA, Z80, SZX, SP).
   */
  async applySnapshot(
    spectrum: Spectrum,
    data: Uint8Array,
    filename: string,
    currentModel: SpectrumModel,
    callbacks: Pick<MediaLoadCallbacks, 'onStatus' | 'onSnapshotLoaded' | 'unpause' | 'ensure128kROM'>
  ): Promise<boolean> {
    const ext = filename.toLowerCase().split('.').pop();

    try {
      if (ext === 'sna') {
        if (data.length > 49179 && !is128kClass(currentModel)) {
          const upgraded = await callbacks.ensure128kROM();
          if (!upgraded) {
            callbacks.onStatus('128K SNA requires a 128K ROM — load one first');
            return false;
          }
          // The model switch replaced the machine — everything below must
          // target the new instance, never the destroyed one.
          ({ spectrum, model: currentModel } = upgraded);
        }

        spectrum.stop();
        spectrum.reset();
        const result = loadSNA(data, spectrum.cpu, spectrum.memory);
        spectrum.ula.borderColor = result.borderColor;
        spectrum.start();
        callbacks.onStatus(`Loaded ${result.is128K ? '128K' : '48K'} SNA: ${filename}`);

      } else if (ext === 'z80') {
        spectrum.stop();
        spectrum.reset();
        const result = loadZ80(data, spectrum.cpu, spectrum.memory);

        if (result.is128K && !is128kClass(currentModel)) {
          const upgraded = await callbacks.ensure128kROM();
          if (!upgraded) {
            spectrum.start();
            callbacks.onStatus('128K .z80 snapshot requires a 128K ROM — load one first');
            return false;
          }
          // Re-bind: the switch destroyed the old machine.
          ({ spectrum, model: currentModel } = upgraded);
          spectrum.stop();
          spectrum.reset();
          loadZ80(data, spectrum.cpu, spectrum.memory);
        }

        spectrum.ula.borderColor = result.borderColor;

        // Restore AY state if present
        if (result.ayRegs) {
          spectrum.ay.setRegisters(result.ayRegs);
          if (result.ayCurrentReg !== undefined) {
            spectrum.ay.selectedReg = result.ayCurrentReg;
          }
        }

        spectrum.start();
        callbacks.onStatus(`Loaded ${result.is128K ? '128K' : '48K'} .z80: ${filename}`);

      } else if (ext === 'szx') {
        spectrum.stop();
        spectrum.reset();
        const result = await loadSZX(data, spectrum.cpu, spectrum.memory);

        if (result.is128K && !is128kClass(currentModel)) {
          const upgraded = await callbacks.ensure128kROM();
          if (!upgraded) {
            spectrum.start();
            callbacks.onStatus('128K .szx snapshot requires a 128K ROM — load one first');
            return false;
          }
          // Re-bind: the switch destroyed the old machine. currentModel is
          // refreshed too so the +2A/+3 paging branch below matches the
          // model the upgrade actually produced.
          ({ spectrum, model: currentModel } = upgraded);
          spectrum.stop();
          spectrum.reset();
          await loadSZX(data, spectrum.cpu, spectrum.memory);
        }

        // Apply paging state for 128K (shared with the refresh/HMR resume path).
        applySZXPaging(spectrum.memory, isPlus2AClass(currentModel), result);

        spectrum.ula.borderColor = result.borderColor;

        // Restore AY state if present
        if (result.ayRegs) {
          spectrum.ay.setRegisters(result.ayRegs);
          if (result.ayCurrentReg !== undefined) {
            spectrum.ay.selectedReg = result.ayCurrentReg;
          }
        }

        spectrum.start();
        callbacks.onStatus(`Loaded ${result.is128K ? '128K' : '48K'} .szx: ${filename}`);

      } else if (ext === 'sp') {
        spectrum.stop();
        spectrum.reset();
        const result = loadSP(data, spectrum.cpu, spectrum.memory);

        if (result.is128K && !is128kClass(currentModel)) {
          const upgraded = await callbacks.ensure128kROM();
          if (!upgraded) {
            spectrum.start();
            callbacks.onStatus('128K .sp snapshot requires a 128K ROM — load one first');
            return false;
          }
          // Re-bind: the switch destroyed the old machine.
          ({ spectrum, model: currentModel } = upgraded);
          spectrum.stop();
          spectrum.reset();
          loadSP(data, spectrum.cpu, spectrum.memory);
        }

        // Apply paging state for 128K
        if (result.is128K) {
          spectrum.memory.port7FFD = result.port7FFD;
          spectrum.memory.currentBank = result.port7FFD & 0x07;
          spectrum.memory.currentROM = (result.port7FFD >> 4) & 1;
          spectrum.memory.pagingLocked = (result.port7FFD & 0x20) !== 0;
          spectrum.memory.applyBanking();
        }

        spectrum.ula.borderColor = result.borderColor;
        spectrum.ula.flashState = result.flashState;
        spectrum.start();
        callbacks.onStatus(`Loaded ${result.is128K ? '128K' : '48K'} .sp: ${filename}`);

      } else {
        callbacks.onStatus(`Unknown format: .${ext}`);
        return false;
      }
    } catch (e) {
      callbacks.onStatus(`Error: ${(e as Error).message}`);
      return false;
    }

    callbacks.unpause();
    return true;
  }

  /**
   * Route file load based on extension.
   */
  async loadFile(
    spectrum: Spectrum | null,
    data: Uint8Array,
    filename: string,
    currentModel: SpectrumModel,
    callbacks: MediaLoadCallbacks,
    unit?: number
  ): Promise<void> {
    if (!spectrum) {
      callbacks.onStatus('Load a ROM first');
      return;
    }

    const ext = filename.toLowerCase().split('.').pop();

    if (ext === 'zip') {
      await this.handleZipFile(spectrum, data, currentModel, callbacks, unit);
      return;
    }

    if (ext === 'tap' || ext === 'tzx' || ext === 'cdt') {
      this.applyTape(spectrum, data, filename, callbacks);
      return;
    }

    if (ext === 'dsk' || ext === 'hfe' || ext === 'scp') {
      const diskUnit = unit ?? 0;
      this.loadDisk(spectrum, data, filename, diskUnit, callbacks);
      return;
    }

    if (ext === 'sna' || ext === 'z80' || ext === 'szx' || ext === 'sp') {
      if (await this.applySnapshot(spectrum, data, filename, currentModel, callbacks)) {
        persistLastFile(data, filename);
      }
      return;
    }

    callbacks.onStatus(`Unknown file type: .${ext}`);
  }

  /**
   * Handle ZIP file unpacking and file selection.
   */
  private async handleZipFile(
    spectrum: Spectrum,
    data: Uint8Array,
    currentModel: SpectrumModel,
    callbacks: MediaLoadCallbacks,
    unit?: number
  ): Promise<void> {
    let entries;
    try {
      entries = await unzip(data);
    } catch (e) {
      callbacks.onStatus(`ZIP error: ${(e as Error).message}`);
      return;
    }

    if (entries.length === 0) {
      callbacks.onStatus('ZIP is empty');
      return;
    }

    // Re-dispatch through the top-level loader when available so peripheral
    // formats (.mdr/.mgt) inside the archive reach their handlers; otherwise
    // fall back to handling it here.
    const dispatch = (fileData: Uint8Array, name: string): Promise<void> =>
      callbacks.loadExtracted
        ? callbacks.loadExtracted(fileData, name, unit)
        : this.loadFile(spectrum, fileData, name, currentModel, callbacks, unit);

    if (entries.length === 1) {
      await dispatch(entries[0].data, entries[0].name);
      return;
    }

    // Multiple files: show picker
    const names = entries.map(e => e.name);
    const pickedName = await showFilePicker(names);
    if (!pickedName) {
      callbacks.onStatus('No file selected');
      return;
    }

    const picked = entries.find(e => e.name === pickedName)!;
    await dispatch(picked.data, picked.name);
  }
}
