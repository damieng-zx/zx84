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
import { isTimex2068Class, timex2068IsNtsc } from '@/machines/spectrum/models.ts';
import { loadSNA } from '@/machines/spectrum/snapshots/sna.ts';
import { loadZ80, saveZ80 } from '@/machines/spectrum/snapshots/z80format.ts';
import { loadSZX, saveSZX, saveSZXSync, applySZXPaging } from '@/machines/spectrum/snapshots/szx.ts';
import { loadSP } from '@/machines/spectrum/snapshots/sp.ts';
import { hasBoardIssueOption, type SpectrumModel } from '@/machines/spectrum/models.ts';

/** What a Timex snapshot's machine is called in the prompt that offers to switch to it. */
const TIMEX_NAMES: Partial<Record<SpectrumModel, string>> = { tc2048: 'TC2048', ts2068: 'Timex 2068' };

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
    return host.requestModel('zx128k', reason);
  }

  /** A Timex snapshot belongs on the Timex it came from (its hi-res screens mean
   *  nothing to a 48K, and its ROM is not another Timex family's): ask the host for
   *  one. False (declined / no host) loads it as it is. `target` is the model the
   *  file names; a 2068 file (TS2068 or TC2068) is happy on a 2068 in either TV
   *  standard, a TC2048 file only on a TC2048. */
  private async switchToTimex(target: SpectrumModel, reason: string): Promise<boolean> {
    const host = this.host();
    if (!host) return false;
    return host.requestModel(target, reason);
  }

  /** Whether a snapshot of `target` needs the machine changed to run. */
  private needsTimexSwitch(target: SpectrumModel | null): target is SpectrumModel {
    if (target === null) return false;
    const model = this.s.model;
    return isTimex2068Class(target) ? !isTimex2068Class(model) : model !== target;
  }

  /** The Timex model an SZX machine id names, or null for any other machine. */
  private static timexModelOfSzx(machineId: number | undefined): SpectrumModel | null {
    return machineId === 8 ? 'tc2048' : machineId === 9 || machineId === 12 ? 'ts2068' : null;
  }

  /** Put the Timex screen mode a snapshot recorded back on port 0xFF, and on a 2068
   *  the dock / EXROM chunks back on ports 0xF4 and 0xFF bit 7. The cartridge itself
   *  is not in a snapshot, so a DOCK chunk is only paged in while one is fitted:
   *  swapping an empty dock over RAM would blank the program. */
  private applyTimexDec(dec: number | undefined, f4?: number): void {
    const s = this.s;
    if (s.timex === null || dec === undefined) return;
    s.timex.write(dec);
    s.ula.setTimexVideo(dec);
    const mmu = s.memory.timexMmu;
    if (mmu !== null) {
      const dockEmpty = !s.timex.exRom && mmu.cart === null;
      mmu.select(dockEmpty ? 0 : (f4 ?? 0), s.timex.exRom);
    }
  }

  /**
   * Fit the board revision a 16K/48K snapshot records (SZX KEYB ZXSTKF_ISSUE2,
   * .z80 byte 29 bit 2), and have the host record it as the Hardware-pane
   * option so the pane and the next session agree with the running machine.
   * A file that says nothing (no KEYB block) leaves the board alone.
   */
  private applyBoardIssue(issue2: boolean | undefined): void {
    const s = this.s;
    if (issue2 === undefined || !hasBoardIssueOption(s.model) || issue2 === s.boardIssue2) return;
    s.setBoardIssue2(issue2);
    this.host()?.setFlagSetting?.('spectrum-issue2', issue2);
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
        if (this.needsTimexSwitch(result.sourceModel ?? null)) {
          if (await this.switchToTimex(result.sourceModel!, `${TIMEX_NAMES[result.sourceModel!]} .z80: ${filename}`)) {
            return { ok: true, needsReplay: true, message: '' };
          }
        }
        if (result.is128K && !is128kClass(model)) {
          if (await this.upgradeTo128k(`128K .z80: ${filename}`)) {
            return { ok: true, needsReplay: true, message: '' };
          }
          s.start();
          return { ok: false, message: '128K .z80 snapshot requires a 128K ROM — load one first' };
        }
        if (!result.is128K && is128kClass(model)) s.memory.selectSnapshot48KRom();
        s.ula.borderColor = result.borderColor;
        this.applyTimexDec(result.timexDec);
        if (!result.is128K) this.applyBoardIssue(result.issue2);
        if (result.ayRegs) {
          s.ay.setRegisters(result.ayRegs);
          if (result.ayCurrentReg !== undefined) s.ay.selectedReg = result.ayCurrentReg;
        }
        if (result.frameTStates !== undefined) s.resumeAtFrameOffset(result.frameTStates);
        s.start();
        return { ok: true, message: `Loaded ${result.is128K ? '128K' : '48K'} .z80: ${filename}` };
      }

      if (ext === 'szx') {
        s.stop();
        s.reset();
        const result = await loadSZX(data, s.cpu, s.memory);
        const szxTimex = SpectrumSnapshotService.timexModelOfSzx(result.machineId);
        if (this.needsTimexSwitch(szxTimex)) {
          if (await this.switchToTimex(szxTimex, `${TIMEX_NAMES[szxTimex]} .szx: ${filename}`)) {
            return { ok: true, needsReplay: true, message: '' };
          }
        }
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
        if (result.portFE !== undefined) s.ula.writePort(result.portFE);
        s.ula.borderColor = result.borderColor;
        this.applyTimexDec(result.timexDec, result.timexF4);
        if (!result.is128K) this.applyBoardIssue(result.issue2);
        if (result.ayRegs) {
          s.ay.setRegisters(result.ayRegs);
          if (result.ayCurrentReg !== undefined) s.ay.selectedReg = result.ayCurrentReg;
        }
        s.resumeAtFrameOffset(s.cpu.tStates); // dwCyclesStart
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
          // .sp carries no 1FFD (128K/+2 paging only): map for +2A/+3.
          s.memory.selectSnapshot128KRom();
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

  /** T-state at which the current frame's INT fired. Saves normally happen
   *  between runFrame calls, when cpu.tStates has already passed the frame end
   *  and the next frame (INT) starts at frameStart + tpf. */
  private currentFrameStart(): number {
    const s = this.s;
    const fs = s.contention.frameStartTStates;
    const tpf = s.contention.timing.tStatesPerFrame;
    return s.cpu.tStates - fs >= tpf ? fs + tpf : fs;
  }

  async save(ext: string): Promise<Uint8Array> {
    const s = this.s;
    if (ext === 'szx' || ext === '.szx') {
      return saveSZX(s.cpu, s.memory, s.ula.borderColor, s.model, this.currentFrameStart(), s.ay.getRegisters(), s.ay.selectedReg,
        { portFE: s.ula.lastOut, issue2: s.boardIssue2, timexDec: s.timex?.dec, timexF4: s.memory.timexMmu?.f4, ntsc: timex2068IsNtsc(s.locale) });
    }
    if (ext === 'z80' || ext === '.z80') {
      // The format has no place for the 2068's port 0xF4 or its dock: SZX is its snapshot.
      if (isTimex2068Class(s.model)) throw new Error('A Timex 2068 saves snapshots as .szx');
      return saveZ80(s.cpu, s.memory, s.ula.borderColor, s.variant.hasBanking, s.ay.getRegisters(), s.ay.selectedReg,
        s.cpu.tStates - this.currentFrameStart(), s.model as SpectrumModel, s.boardIssue2, s.timex?.dec);
    }
    throw new Error(`Unsupported snapshot save format: ${ext}`);
  }

  /** Synchronous SZX snapshot for the shell's beforeunload refresh path. */
  saveSync(): Uint8Array {
    const s = this.s;
    return saveSZXSync(
      s.cpu, s.memory, s.ula.borderColor, s.model as SpectrumModel,
      this.currentFrameStart(), s.ay.getRegisters(), s.ay.selectedReg,
      { portFE: s.ula.lastOut, issue2: s.boardIssue2, timexDec: s.timex?.dec, timexF4: s.memory.timexMmu?.f4, ntsc: timex2068IsNtsc(s.locale) },
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
    if (result.portFE !== undefined) s.ula.writePort(result.portFE);
    s.ula.borderColor = result.borderColor;
    this.applyTimexDec(result.timexDec, result.timexF4);
    if (!result.is128K) this.applyBoardIssue(result.issue2);
    if (result.ayRegs) {
      s.ay.setRegisters(result.ayRegs);
      if (result.ayCurrentReg !== undefined) s.ay.selectedReg = result.ayCurrentReg;
    }
    s.resumeAtFrameOffset(s.cpu.tStates); // dwCyclesStart
    s.start();
    return true;
  }
}
