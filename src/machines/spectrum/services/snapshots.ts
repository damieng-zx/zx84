/**
 * Spectrum SnapshotService — SNA/Z80/SZX/SP apply and Z80/SZX save.
 *
 * Ported verbatim from the MediaManager's Spectrum-typed snapshot half. The
 * one structural change: the "128K snapshot on a 48K machine" upgrade no
 * longer re-binds to a new Spectrum in place — the service asks the host via
 * requestModel('128k') and reports `needsReplay`; the shell re-dispatches the
 * same file to the machine the rebuild produced (which is 128K-class, so the
 * replayed apply cannot recurse).
 */

import type { MachineHost, SnapshotApplyResult, SnapshotService } from '@/machines/machine.ts';
import type { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { is128kClass, isPlus2AClass } from '@/models.ts';
import { loadSNA } from '@/machines/spectrum/snapshots/sna.ts';
import { loadZ80, saveZ80 } from '@/machines/spectrum/snapshots/z80format.ts';
import { loadSZX, saveSZX, saveSZXSync, applySZXPaging } from '@/machines/spectrum/snapshots/szx.ts';
import { loadSP } from '@/machines/spectrum/snapshots/sp.ts';
import type { SpectrumModel } from '@/machines/spectrum/models.ts';

export class SpectrumSnapshotService implements SnapshotService {
  constructor(private readonly s: Spectrum, private readonly host: () => MachineHost | null) {}

  formats(): { ext: string; canSave: boolean }[] {
    return [
      { ext: '.sna', canSave: false },
      { ext: '.z80', canSave: true },
      { ext: '.szx', canSave: true },
      { ext: '.sp', canSave: false },
    ];
  }

  /** Ask the host for a 128K-class rebuild. False (declined / no host) keeps
   *  the current machine in service. */
  private async upgradeTo128k(reason: string): Promise<boolean> {
    const host = this.host();
    if (!host) return false;
    return host.requestModel('128k', reason);
  }

  async apply(data: Uint8Array, filename: string): Promise<SnapshotApplyResult> {
    const s = this.s;
    const model = s.model;
    const ext = filename.toLowerCase().split('.').pop();

    try {
      if (ext === 'sna') {
        if (data.length > 49179 && !is128kClass(model)) {
          if (await this.upgradeTo128k(`128K SNA: ${filename}`)) {
            return { ok: true, needsReplay: true, message: '' };
          }
          return { ok: false, message: '128K SNA requires a 128K ROM — load one first' };
        }
        s.stop();
        s.reset();
        const result = loadSNA(data, s.cpu, s.memory);
        if (!result.is128K && is128kClass(model)) s.memory.selectSnapshot48KRom();
        s.ula.borderColor = result.borderColor;
        s.start();
        return { ok: true, message: `Loaded ${result.is128K ? '128K' : '48K'} SNA: ${filename}` };
      }

      if (ext === 'z80') {
        s.stop();
        s.reset();
        const result = loadZ80(data, s.cpu, s.memory);
        if (result.is128K && !is128kClass(model)) {
          if (await this.upgradeTo128k(`128K .z80: ${filename}`)) {
            return { ok: true, needsReplay: true, message: '' };
          }
          s.start();
          return { ok: false, message: '128K .z80 snapshot requires a 128K ROM — load one first' };
        }
        if (!result.is128K && is128kClass(model)) s.memory.selectSnapshot48KRom();
        s.ula.borderColor = result.borderColor;
        if (result.ayRegs) {
          s.ay.setRegisters(result.ayRegs);
          if (result.ayCurrentReg !== undefined) s.ay.selectedReg = result.ayCurrentReg;
        }
        s.start();
        return { ok: true, message: `Loaded ${result.is128K ? '128K' : '48K'} .z80: ${filename}` };
      }

      if (ext === 'szx') {
        s.stop();
        s.reset();
        const result = await loadSZX(data, s.cpu, s.memory);
        if (result.is128K && !is128kClass(model)) {
          if (await this.upgradeTo128k(`128K .szx: ${filename}`)) {
            return { ok: true, needsReplay: true, message: '' };
          }
          s.start();
          return { ok: false, message: '128K .szx snapshot requires a 128K ROM — load one first' };
        }
        // Apply paging state for 128K (shared with the browser-refresh resume path).
        applySZXPaging(s.memory, isPlus2AClass(model), result);
        if (!result.is128K && is128kClass(model)) s.memory.selectSnapshot48KRom();
        s.ula.borderColor = result.borderColor;
        if (result.ayRegs) {
          s.ay.setRegisters(result.ayRegs);
          if (result.ayCurrentReg !== undefined) s.ay.selectedReg = result.ayCurrentReg;
        }
        s.start();
        return { ok: true, message: `Loaded ${result.is128K ? '128K' : '48K'} .szx: ${filename}` };
      }

      if (ext === 'sp') {
        s.stop();
        s.reset();
        const result = loadSP(data, s.cpu, s.memory);
        if (result.is128K && !is128kClass(model)) {
          if (await this.upgradeTo128k(`128K .sp: ${filename}`)) {
            return { ok: true, needsReplay: true, message: '' };
          }
          s.start();
          return { ok: false, message: '128K .sp snapshot requires a 128K ROM — load one first' };
        }
        if (result.is128K) {
          s.memory.port7FFD = result.port7FFD;
          s.memory.currentBank = result.port7FFD & 0x07;
          s.memory.currentROM = (result.port7FFD >> 4) & 1;
          s.memory.pagingLocked = (result.port7FFD & 0x20) !== 0;
          s.memory.applyBanking();
        } else if (is128kClass(model)) {
          s.memory.selectSnapshot48KRom();
        }
        s.ula.borderColor = result.borderColor;
        s.ula.flashState = result.flashState;
        s.start();
        return { ok: true, message: `Loaded ${result.is128K ? '128K' : '48K'} .sp: ${filename}` };
      }

      return { ok: false, message: `Unknown format: .${ext}` };
    } catch (e) {
      return { ok: false, message: `Error: ${(e as Error).message}` };
    }
  }

  async save(ext: string): Promise<Uint8Array> {
    const s = this.s;
    if (ext === 'szx' || ext === '.szx') {
      return saveSZX(s.cpu, s.memory, s.ula.borderColor, s.model, s.contention.frameStartTStates, s.ay.getRegisters(), s.ay.selectedReg);
    }
    if (ext === 'z80' || ext === '.z80') {
      return saveZ80(s.cpu, s.memory, s.ula.borderColor, s.variant.hasBanking, s.ay.getRegisters(), s.ay.selectedReg);
    }
    throw new Error(`Unsupported snapshot save format: ${ext}`);
  }

  /** Synchronous SZX snapshot for the shell's beforeunload refresh path. */
  saveSync(): Uint8Array {
    const s = this.s;
    return saveSZXSync(
      s.cpu, s.memory, s.ula.borderColor, s.model as SpectrumModel,
      s.contention.frameStartTStates, s.ay.getRegisters(), s.ay.selectedReg,
    );
  }

  /** Restore a saveSync() SZX blob on the same model (browser-refresh resume).
   *  Mirrors the szx branch of apply() minus the model-upgrade check because a
   *  refresh never crosses models. */
  async restoreSync(data: Uint8Array): Promise<boolean> {
    const s = this.s;
    s.stop();
    s.reset();
    const result = await loadSZX(data, s.cpu, s.memory);
    applySZXPaging(s.memory, s.variant.hasSpecialPaging, result);
    s.ula.borderColor = result.borderColor;
    if (result.ayRegs) {
      s.ay.setRegisters(result.ayRegs);
      if (result.ayCurrentReg !== undefined) s.ay.selectedReg = result.ayCurrentReg;
    }
    s.start();
    return true;
  }
}
