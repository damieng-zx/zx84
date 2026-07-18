/**
 * emulator.ts — thin façade over the shell.
 *
 * The former ~2,400-line god-module has been split into src/shell/* (lifecycle,
 * media, settings, rom, and the shared context). This file re-exports the shell
 * action surface — plus the reactive state signals the UI binds to — so existing
 * `@/emulator.ts` import sites keep working while the internals live behind the
 * §3.1 shell boundary. New code should import shell actions from `@/shell/*` and
 * state signals from `@/state/*` directly.
 */

// ── Shell actions + machine handles ──────────────────────────────────────
export * from '@/shell/context.ts';
export * from '@/shell/lifecycle.ts';
export * from '@/shell/media.ts';
export * from '@/shell/settings.ts';
export * from '@/shell/rom.ts';

// ── Reactive state signals (shared stores; see src/state/*) ───────────────
export {
  statusText, romStatusText, currentModel, emulationPaused, turboMode, clockSpeedText, saveModel,
  systemRomLabel, systemRomSize, systemRomIsCustom,
  systemRomPageLabels, systemRomPageSizes, systemRomPageOverridden, cartridgeName,
  setStatusText, setRomStatusText, setCurrentModel, setEmulationPaused, setTurboMode, setClockSpeedText,
  multifaceRomFailed, vtx5000RomFailed, paradosRomFailed, plusDRomFailed, interface1RomFailed, betaDiskRomFailed,
} from '@/state/machine-state.ts';

export {
  tapeLoaded, tapeBlocks, tapePosition, tapePaused, tapePlaying, tapeName, casBlocks, casPosition,
  setTapeLoaded, setTapeName, setTapeBlocks, setTapePosition, setTapePaused, setTapePlaying, setCasPosition,
} from '@/state/tape-state.ts';

export {
  currentDiskInfo, currentDiskName, currentDiskInfoB, currentDiskNameB, driveAStatus, driveBStatus, diskInfoHtml, driveHtml,
  currentDiskInfoC, currentDiskNameC, currentDiskInfoD, currentDiskNameD, driveCStatus, driveDStatus,
  diskSideA, diskSideB,
  setCurrentDiskInfo, setCurrentDiskName, setCurrentDiskInfoB, setCurrentDiskNameB, setDriveAStatus, setDriveBStatus, setDiskInfoHtml, setDriveHtml,
  setCurrentDiskInfoC, setCurrentDiskNameC, setCurrentDiskInfoD, setCurrentDiskNameD, setDriveCStatus, setDriveDStatus,
} from '@/state/disk-state.ts';

export {
  regsHtml, regsRev, sysvarHtml, sysvarRev, basicHtml, basicVarsHtml, banksHtml, disasmText, tracing, trapLogHtml, showTrapLog,
  setRegsHtml, setRegsRev, setSysvarHtml, setSysvarRev, setBasicHtml, setBasicVarsHtml, setBanksHtml, setDisasmText, setTracing, setTrapLogHtml, setShowTrapLog,
} from '@/state/debug-state.ts';

export {
  ledKbd, ledKemp, ledMouse, ledEar, ledLoad, ledTapeTurbo, ledDsk, ledBeep, ledAy, ledRainbow, ledText,
  transcribeMode, transcribeText, transcribeHtml, transcribeGrid,
  setLedKbd, setLedKemp, setLedMouse, setLedEar, setLedLoad, setLedTapeTurbo, setLedDsk, setLedBeep, setLedAy, setLedRainbow, setLedText,
  setTranscribeMode, setTranscribeText, setTranscribeHtml, setTranscribeGrid,
} from '@/state/activity-state.ts';
