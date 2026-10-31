/**
 * Machine — the common surface shared by every emulated computer.
 *
 * The machine-blind handle the shell, UI, and MCP hold. Everything chip-shaped
 * (CPU, PSG, FDC, tape deck, mixer) and everything CPU-family-shaped (register
 * layout, disassembly, tracing) lives OFF this interface: consumers reach
 * machine internals only through `services` (§3.3) and the per-family debug
 * provider (`services.debug`, backed by `debug/<family>/`).
 *
 * Deliberate exceptions kept on the interface:
 *  - `memory` — the 64KB address-space view is a fundamental machine property
 *    (a 6502 machine has one too), used pervasively by hosts and debug tools.
 *  - breakpoint/watchpoint storage — generic across CPU families, and the
 *    frame loop checks these fields on the hot path; they stay where BaseMachine
 *    declares them.
 */

import type { DskImage } from '@/media/floppy/disk-image.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type { BeamInfo, BeamLog, BeamPos } from '@/debug/beam-log.ts';
import type { StopReason } from '@/debug/stop-reason.ts';
import type { ChipSection } from '@/debug/chip-state.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';
import type { MachineModel } from '@/models.ts';
import type { OcrGridName, FontSource } from '@/ocr/ocr.ts';
import type { BasicListingLine, BasicVariable } from '@/basic/types.ts';

export type MachineKind = 'spectrum' | 'cpc' | 'einstein' | 'msx' | 'zx8x' | 'mtx' | 'lynx' | 'jupiter-ace' | 'pcw' | 'bbc' | 'electron' | 'apple2' | 'apple1' | 'enterprise' | 'atari' | 'c64';

/** Keyboard/ROM locale for international machine variants.
 *  'uk' = default (English, no locale-specific ROM/keyboard). */
export type MachineLocale = 'uk' | 'es' | 'fr' | 'us';

/** Border-size selector shared by both machines: 0=none, 1=small, 2=normal. */
export type BorderMode = 0 | 1 | 2;

/** Trace flavours supported by the debug layer. */
export type MachineTraceMode = 'full' | 'portio' | 'zxtl';

/**
 * Minimal interface for reading from the Z80 paged address space.
 * Implemented by each machine's memory class; accepted by debug and display
 * tools. Lives on the SPI so no machine folder owns the common contract.
 */
export interface ByteReader {
  readByte(addr: number): number;
  readBlock(addr: number, len: number): Uint8Array;
}

/**
 * The common memory surface. Both `SpectrumMemory` and the CPC's memory expose
 * a live flat 64KB Z80 view plus the bulk accessors used by snapshots, the
 * debug tools, and MCP. Machine-specific paging state (port7FFD, ROM overlays)
 * stays on the concrete classes.
 */
export interface IMachineMemory extends ByteReader {
  readByte(addr: number): number;
  /** Read for inspection only (debugger, MCP): never disturbs read-sensitive
   *  hardware. Machines whose IO has read side effects provide it; the rest
   *  fall back to `readByte`. */
  peekByte?(addr: number): number;
  writeByte(addr: number, val: number): void;
  readBlock(addr: number, len: number): Uint8Array;
  /** Fresh 64KB copy of the current paged address space (debug/snapshot). */
  snapshot(): Uint8Array;
  /** A specific 16KB physical RAM bank as a live view. */
  getRamBank(n: number): Uint8Array;
  /** How many physical RAM banks `getRamBank` addresses.
   *
   *  Eight on a 128K Spectrum and four on an MSX.
   *  Declared because every implementation coerces an out-of-range index to
   *  *something* — hosts that let a user name a bank (the MCP memory tools)
   *  need to know the real count so they can refuse rather than silently dump
   *  the wrong bank. */
  readonly ramBankCount: number;
  reset(): void;
}

export interface Machine {
  readonly kind: MachineKind;
  readonly model: MachineModel;

  // ── Machine-blind fundamentals ───────────────────────────────────────
  memory: IMachineMemory;
  display: IScreenRenderer | null;
  /** Live AudioContext once audio is initialised (drive-sound synth attach). */
  readonly audioContext: AudioContext | null;

  /** RGBA frame buffer the machine renders into. */
  readonly pixels: Uint8Array;
  /** Current frame-buffer dimensions (the Spectrum's shrink with the border
   *  setting; fixed-geometry machines report their descriptor size). */
  readonly frameWidth: number;
  readonly frameHeight: number;

  /** Nominal T-states per video frame (for the debugger's register readout). */
  readonly tStatesPerFrame: number;
  /** Nominal CPU clock in Hz (drives the speed readout). */
  readonly cpuClockHz: number;

  // ── Lifecycle / driver ───────────────────────────────────────────────
  start(): Promise<void>;
  stop(): void;
  destroy(): void;
  reset(): void;
  /** Initialise the audio pipeline without starting the frame loop (first user
   *  gesture unlocks the AudioContext). No-op once audio is running. */
  initAudio(): void;
  setBorderSize(mode: BorderMode): void;
  /** Run one frame (headless / test harness). */
  tick(): void;
  /** Run up to maxFrames, stopping early on a breakpoint/watchpoint hit. */
  runUntil(maxFrames: number): number;
  /** Requested wall-clock speed. `null` means run without a fixed limit. */
  speedMultiplier: number | null;
  setSpeedMultiplier(multiplier: number | null): void;
  /** Legacy max-speed flag retained for tape/debug integrations. */
  turbo: boolean;

  // ── Debug hooks (generic across CPU families; storage on BaseMachine) ─
  breakpoints: Set<number>;
  breakpointHit: number;
  portWatchpoints: Set<number>;
  portWatchHit: { port: number; value: number; dir: 'in' | 'out' } | null;
  memWatchpoints: {
    start: number; end: number; mode: 'read' | 'write' | 'rw';
    /** `'break'` (default) stops at the first access; `'log'` records every
     *  access in the beam log and carries on. */
    action?: 'break' | 'log';
    /** A log watchpoint records only accesses of these values. */
    values?: number[];
  }[];
  memWatchHit: { addr: number; value: number; dir: 'read' | 'write' } | null;
  /** Ports in `portWatchpoints` that log to the beam log instead of stopping. */
  portLogPorts: Set<number>;
  onTrap: ((pc: number, resume?: boolean) => boolean) | null;
  /** Why the last run stopped (null if it ran to its end). */
  stopReason: StopReason | null;
  /** The beam-stamped debug event ring; null until a debugger arms it. */
  beamLog: BeamLog | null;
  /** The index of the frame in progress (frames completed since reset). Only a
   *  machine that implements `beam()` keeps it honest. */
  readonly frameNumber: number;
  /** Where the beam is: the frame in progress and the cycles since it started
   *  (`t`). Null when the machine has no raster to report. */
  beam(): BeamPos | null;
  /** The raster geometry `beam().t` is measured in, or null. */
  beamInfo(): BeamInfo | null;
  /** Log interrupt entries and ends in the beam log (off by default). A
   *  machine that cannot report them ignores it ({@link supportsInterruptLog}). */
  interruptLogging: boolean;
  /** Whether {@link interruptLogging} does anything on this machine. */
  supportsInterruptLog(): boolean;
  /** Stop at the first instruction boundary at or after this beam position;
   *  honoured only where {@link supportsBeamStops} is true. */
  beamTarget: { frame: number; t: number } | null;
  /** Whether the frame loop can stop mid-frame and resume (run-to-beam). */
  supportsBeamStops(): boolean;
  /** Execute exactly one instruction inside the frame loop, when the machine
   *  can (the debugger's step); absent, the debug service steps the CPU raw. */
  stepInstruction?(): void;
  onStatus: ((msg: string) => void) | null;
  onFrame: (() => void) | null;
  /** Fired when the machine changes its frame-buffer geometry at runtime (so
   *  `descriptor.screen` differs from before); the shell republishes it. */
  onScreenChange?: (() => void) | null;

  // ── SPI v2 ───────────────────────────────────────────────────────────
  /** Static metadata for this machine+model (also available construction-free
   *  via the registry's `descriptor(model)`). */
  readonly descriptor: MachineDescriptor;
  /** The service surface (§3.3) — the only way hosts reach machine internals. */
  readonly services: MachineServices;
  /** Attach the operator's panel (shell / MCP). */
  attachHost(host: MachineHost): void;
  /** Pull the settings this machine cares about from the generic store view. */
  applySettings(view: SettingsView): void;
  /** Configure fitted peripherals from settings (enable flags, write-protects —
   *  set synchronously) and return the peripheral-ROM loads the shell must
   *  fulfil BEFORE the system ROM is loaded and the machine is reset. */
  prepare?(view: SettingsView): AuxRomRequest[];
  /** Peripheral-ROM overlays applied AFTER reset, on machine build only (the CPC
   *  ParaDOS overlay needs the firmware ROM set already in place). */
  bootRoms?(view: SettingsView): AuxRomRequest[];
  /** Arm the software library's one-click auto-boot trap: fire the loader once
   *  the freshly-reset ROM reaches its menu/editor key-wait loop. The machine
   *  owns the trap address(es) for its own ROM family — or, for 'disk', its own
   *  equivalent of holding the boot key down. Machines without a ROM-loader
   *  auto-boot omit this (the shell keys off its presence). */
  armBootTrap?(kind: 'menu' | 'rom48k' | 'disk' | 'trdos'): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// Machine SPI v2
//
// The interfaces below are the *service* surface each machine will implement in
// Phase 3: narrow management routines the UI, shell, and MCP bind to instead of
// narrowing to a concrete machine. During the transition the accessors on
// `Machine` are optional; Phase 7 makes them required and deletes the legacy
// chip-typed fields (cpu/ay/fdc/tape/mixer) and the as*() helpers above.
//
// Everything here must stay headless-safe: types + plain functions only, no
// solid-js, no DOM beyond what `IScreenRenderer` already implies for the shell.
// ═══════════════════════════════════════════════════════════════════════════

/** CPU families the debug layer can host. Extended when a new family arrives
 *  (the first 6502 machine adds 'm6502' panels/disassembler — §3.7). */
export type CpuFamily = 'z80' | 'm6502';

/**
 * Static, construction-free metadata for one model of one machine. Everything
 * the shell needs *before* (or without) building the machine: which family it
 * is, how big its frame buffer is, how to letterbox it.
 */
export interface MachineDescriptor {
  readonly kind: MachineKind;
  readonly model: MachineModel;
  readonly locale: MachineLocale;
  readonly cpuFamily: CpuFamily;
  /** Full-border frame-buffer geometry the display is created with, plus the
   *  active (non-border) area's size and its offset within the buffer at the
   *  Normal border setting. The generic transcribe overlay (Screen.tsx) derives
   *  its position/scale from these instead of branching on machine family; the
   *  border-size crop is applied uniformly. The live machine may render less
   *  (border-size setting); that stays machine-owned. */
  readonly screen: {
    readonly width: number;
    readonly height: number;
    readonly pixelAspectX: number;
    /** Buffer lines per displayed line at scale 1 (default 1); see
     *  `IScreenRenderer.setOversample`. */
    readonly oversample?: number;
    /** Active display area (the 256×192 Spectrum window, 640×200 CPC, …). */
    readonly activeWidth: number;
    readonly activeHeight: number;
    /** Offset of the active area within the full-border buffer. */
    readonly borderLeft: number;
    readonly borderTop: number;
  };
  /** Static, per-model UI capabilities the generic panes bind to instead of
   *  branching on machine kind/model. Pure data — see MachineUiCapabilities. */
  readonly ui: MachineUiCapabilities;
}

/** A ROM/region entry offered by the Memory pane's region picker. */
export interface MemoryRegionInfo {
  /** Opaque region id passed back to `Machine.resolveMemoryRegion`. */
  readonly value: string;
  /** Human label shown in the picker. */
  readonly label: string;
}

/** A single address-range row in the memory-layout pane. */
export interface MemoryMapSlot {
  /** Address range, e.g. '0000-3FFF'. */
  readonly range: string;
  /** What the CPU reads from this range, e.g. 'RAM Bank 5', 'OS ROM'. */
  readonly read: string;
  /** What the CPU writes land in, when it differs from `read` (ROM-over-RAM
   *  machines like the CPC). Omitted when read === write. */
  readonly write?: string;
  /** Decorative markers: 'screen' (display fetches here), 'active' (the
   *  currently-paged ROM page). */
  readonly flags?: readonly MemoryMapFlag[];
}

/** A named paging register or status line shown in the layout footer. */
export interface MemoryMapReg {
  /** Register name, e.g. '7FFD', 'Lock'. */
  readonly name: string;
  /** Formatted value, e.g. '1F', 'Y'. */
  readonly value: string;
}

/** The structured memory-layout snapshot the generic BanksPane renders. */
export interface MemoryMapSnapshot {
  /** Optional column headers above read/write (CPC's 'CPU read'/'CPU write').
   *  Omitted for single-source machines. */
  readonly columns?: readonly string[];
  /** Address-range rows, ordered high→low. */
  readonly slots: readonly MemoryMapSlot[];
  /** Paging registers / status lines (footer). */
  readonly registers: readonly MemoryMapReg[];
}

/** Marker flags for a {@link MemoryMapSlot}. */
export type MemoryMapFlag = 'screen' | 'active';

/** Identifiers for the status-bar activity LEDs. The runtime catalog (labels,
 *  tips, signals) lives in `ui/components/status-leds.ts`; only the id union is
 *  declared here so machine descriptors stay headless-safe. A machine lists the
 *  ids it exposes via `MachineUiCapabilities.statusLeds`. */
export const STATUS_LED_IDS = [
  'kbd', 'kemp', 'mouse', 'ear', 'load', 'dsk', 'text', 'rainbow', 'beep', 'chip',
] as const;

export type StatusLedId = typeof STATUS_LED_IDS[number];

/**
 * Per-model UI capability flags, declared by each machine's descriptor. The
 * generic panes read these (reactively, keyed off the current model) instead of
 * calling `isCpcModel(...)` / `is128kClass(...)` etc. This keeps the UI machine-
 * blind: a new machine declares its capabilities and the existing panes adapt.
 *
 * Everything here is presentation-facing but *machine-owned*: the machine knows
 * which of its features the UI should surface. Pure data (headless-safe).
 */
/** One Color map choice — see `MachineUiCapabilities.colorMapOptions`. */
export interface ColorMapOption {
  readonly value: string;
  readonly label: string;
  /** Tooltip saying what the choice models. */
  readonly title?: string;
}

/** A Sound-pane PSG-shaping control — see `MachineUiCapabilities.psgControls`. */
/** One hardware sound device of a machine, as `MachineUiCapabilities.soundDevices` lists it. */
export interface SoundDeviceInfo {
  /** Stable id for the device (`beeper`, `psg`, `specdrum`, …). */
  readonly id: string;
  /** Slider label. */
  readonly label: string;
  /** The 0-`maxVolume` percent setting key holding this device's volume. Several
   *  machines share a key for the same kind of device (`beeper-volume`). */
  readonly volumeSetting: string;
  /** Boolean setting that must be on for the device to be present (a user-fitted
   *  peripheral). Omitted for devices the machine always has. */
  readonly enabledSetting?: string;
  /** Slider ceiling in percent (default 100). Above 100 lets a line-level device
   *  (a DAC) be pushed past the speaker. */
  readonly maxVolume?: number;
}

export type PsgControl = 'stereo' | 'sn-stereo' | 'filter' | 'sid-model';

/** One mouse interface a machine offers — see `MachineUiCapabilities.mouseTypes`.
 *  `id` is the mode string passed back through `InputService.mice`. */
export interface MouseTypeInfo {
  readonly id: string;
  readonly label: string;
}

/** One joystick interface a machine offers — see
 *  `MachineUiCapabilities.joystickTypes`. */
export interface JoystickTypeInfo {
  readonly id: string;
  readonly label: string;
}

/**
 * One entry in the Load/Save pane's Save menu. A machine lists exactly the
 * artifacts it can write and the pane renders the list verbatim, so a machine
 * that cannot produce a `.z80`/`.scr`/`.bin` simply does not name one. The
 * capability test holds each entry against the service that has to honour it.
 */
export type SaveMenuItem =
  /** Whatever the machine has written to its cassette port, in the format its
   *  own tape loader accepts back (.tap on the Ace and Lynx, .cas on the MSX
   *  and Atari, .uef on the BBC/Electron, .tzx on the Spectrum, .cdt on the
   *  CPC, .wav on the Apple I/II, .mtx on the MTX, .p/.o on the ZX81/ZX80).
   *  The menu labels it "Saved tape"; the id predates the other formats. */
  | 'tape-tap'
  | 'snapshot-szx'
  | 'snapshot-z80'
  | 'snapshot-sna-v2'
  | 'snapshot-sna-v3'
  | 'snapshot-a8state'
  /** zx84's native save states of the Z80 machines (see shared/native-state.ts). */
  | 'snapshot-acestate'
  | 'snapshot-zx8xstate'
  | 'snapshot-lynxstate'
  | 'snapshot-mtxstate'
  | 'snapshot-msxstate'
  | 'snapshot-einstate'
  | 'snapshot-pcwstate'
  | 'snapshot-epstate'
  | 'snapshot-bbcstate'
  | 'snapshot-elkstate'
  | 'snapshot-a1state'
  | 'snapshot-a2state'
  | 'snapshot-c64state'
  | 'screenshot-png'
  | 'screen-scr'
  | 'ram-bin'
  /** What the machine has sent its built-in printer, as text (`printerExport`). */
  | 'printer-txt';

export interface MachineUiCapabilities {
  /** Pane ids removed from the sidebar entirely for this machine. */
  readonly hiddenPanes: readonly string[];
  /** Memory-layout ("banks") pane applies to this model. */
  readonly memoryLayout: boolean;
  /** Execution-trace debugger control is available. */
  readonly trace: boolean;
  /** The trace modes offered, when not all three ('zxtl' is a Z80 register
   *  layout, so a 6502 machine lists 'full' and 'portio'). */
  readonly traceModes?: readonly MachineTraceMode[];
  /** Palette / colour-map family shown in the Display pane. */
  readonly colorMap: 'spectrum' | 'cpc' | 'msx' | 'einstein' | 'bbc' | 'apple2' | 'atari' | 'mono';
  /** The Color map drop-down's choices, where the machine computes them
   *  rather than the pane listing a fixed set (the Atari's depend on its
   *  region). The first is the default. */
  readonly colorMapOptions?: readonly ColorMapOption[];
  /**
   * Which Accuracy drop-down the Display pane offers, or false for none.
   *
   * 'scanline' is the Spectrum's per-t-state / per-line / per-cell renderer;
   * 'raster' is a machine that can draw per CPU cycle, per scanline or once
   * per frame (the BBC Micro and the Apple II), where the first two show what
   * a program changes mid-frame (split modes, palette changes) and the last is
   * the fastest; 'contention' is for a machine that always draws a whole line
   * at a time and whose only accuracy step is whether memory slots are
   * charged. All write the same `scanline-accuracy` setting, so the control
   * is one control.
   */
  readonly accuracy: false | 'scanline' | 'raster' | 'contention';
  /** Built-in floppy drives (A:/B:) are fitted. */
  readonly builtinDisk: boolean;
  /** Boolean Hardware-pane settings (SettingsView keys) a capability depends
   *  on, for peripherals fitted by the user: the capability only applies while
   *  its setting is on. The machine still declares the capability statically
   *  (descriptors are pure functions of the model); the generic panes consult
   *  the setting so they show nothing for hardware that isn't fitted. */
  readonly requires?: {
    readonly builtinDisk?: string;
    readonly cartridge?: string;
    /** The joystick ports belong to an add-on (the Electron's Plus 1). */
    readonly joystick?: string;
  };
  /** Built-in drives fitted, A: onward — defaults to 2 when `builtinDisk`.
   *  The Lynx's FD1793 addresses four. Peripheral drives are not counted. */
  readonly builtinDrives?: number;
  /** Labels of the built-in drives in order, where they are not A:, B:, C:,
   *  D: (the Atari's D1: to D4:). */
  readonly builtinDriveLabels?: readonly string[];
  /** Models a built-in drive can be set to, offered in each drive's Model
   *  sub-menu. A machine that lists these also adds and removes drives one at
   *  a time (the drive list, not a separate count, says how many are fitted),
   *  and implements the `DiskService` hooks for it. */
  readonly driveModels?: readonly { readonly value: string; readonly label: string; readonly title?: string }[];
  /** The drive list when the user has not set one up, one model per drive. */
  readonly defaultDriveModels?: readonly string[];
  /** Joystick pane applies. */
  readonly joystick: boolean;
  /** Joystick presents a single fixed interface (no type selector). */
  readonly fixedJoystick: boolean;
  /** Fire buttons on the machine's joystick. Defaults to 2 for a fixed
   *  interface (the CPC, MSX and MTX sticks) and 1 otherwise; the Atari's
   *  fixed ports take one-button CX40s. */
  readonly joystickFireButtons?: 1 | 2;
  /** The joystick interfaces the type selector offers when the joystick is
   *  not fixed, in order; the ids are the `joy-p1`/`joy-p2` setting values the
   *  machine reads and the `mode` its `JoystickInput` receives. Omitted, the
   *  selector offers the Spectrum's interfaces (Kempston, Cursor, Sinclair). */
  readonly joystickTypes?: readonly JoystickTypeInfo[];
  /** Joysticks the machine can take — defaults to 2. With 1 the pane shows
   *  only player 1. */
  readonly joystickPlayers?: 1 | 2;
  /**
   * Mouse interfaces this machine can drive, in the order the Mouse pane
   * offers them; empty means no mouse pane.
   *
   * The ids are the same strings the machine's `InputService.mice` switches
   * on, so declaring one it cannot drive gives a capture button that does
   * nothing — this list and that switch are two halves of one contract.
   */
  readonly mouseTypes: readonly MouseTypeInfo[];
  /** Cartridge slot present (MSX slot / ZX Interface 2). */
  readonly cartridge: boolean;
  /** Label for the system-ROM slot in the ROM pane. */
  readonly systemRomLabel: string;
  /** Whether to show the system-ROM slot at all. Defaults to true. False on
   *  machines where the cartridge IS the boot source (the Plus range), so the
   *  ROM pane doesn't show two competing "Cartridge" entries — the cartridge
   *  slot is the only path to load firmware. */
  readonly systemRomSlot?: boolean;
  /** Independently-overridable 16K system ROM pages (0 = single image). */
  readonly romPages: 0 | 2 | 4;
  /** 1-bit beeper present (the BEEP activity LED). */
  readonly beeper: boolean;
  /** Name of the machine's sound chip (`AY-3-8912`, `SN76489`, …) — the label
   *  of the status-bar sound LED. Omitted where the machine has only a beeper;
   *  such a machine must not list the 'chip' LED. */
  readonly soundChip?: string;
  /**
   * Every hardware sound device this machine can have — the speaker/beeper, the
   * PSG, a fitted DAC or speech board — in the order the Sound pane lists them.
   * The pane draws one volume slider per *present* device (see
   * `presentSoundDevices`) once there are two or more, and the machine reads the
   * same list in `applySettings` through `soundDeviceGains` to set its mixer.
   * A machine with a single device lists it (or nothing) and gets no slider.
   * Declare a device here and it gets its slider and persistence for free.
   */
  readonly soundDevices?: readonly SoundDeviceInfo[];
  /**
   * Which of the Sound pane's PSG-shaping controls apply to this machine.
   *
   * They are all AY-3-891x concepts and none of them is universal:
   *
   *   'stereo'   — the ACB/ABC channel layout. It exists because the AY's
   *                three channels are MONO, so an emulator has to choose how
   *                to pan them. A chip that is natively stereo has nothing to
   *                pan: a stereo-native chip gives each channel its own
   *                left and right amplitude, so the program decides the image.
   *   'filter'   — the ultrasonic anti-alias strategy, which the MTX's
   *                SN76489 shares even though it is not an AY.
   *
   * A machine with no PSG at all (ZX80/81) lists none of them.
   */
  readonly psgControls: readonly PsgControl[];
  /** Status-bar activity LEDs this machine exposes. Each machine lists only the
   *  indicators its hardware actually has *and* its frame probe drives, so the
   *  status bar can never show an LED for absent hardware (e.g. no AY/DISK on a
   *  ZX80/81). Rendered from the STATUS_LEDS catalog in `status-leds.ts`. */
  readonly statusLeds: readonly StatusLedId[];
  /** Keyboard read path, for the KEY LED tip. */
  readonly keyboardBus: 'ula' | 'ppi' | 'matrix';
  /** Tape transport: 'deck' (pulse-level block list) or 'instant' (logical image).
   *  Omitted when the model has no cassette hardware (e.g. the GX4000 console). */
  readonly tape?: 'deck' | 'instant';
  /** The machine traps its ROM's tape-load routine (the "Fast ROM loading"
   *  toggle does something). Omitted when there is no trap — the Tape pane
   *  then hides the toggle instead of offering a dead control. */
  readonly fastRomLoading?: boolean;
  /** Loading-sound toggle applies (AY-audible tape loading). */
  readonly tapeSound: boolean;
  /** Extensions the tape loader accepts (Load picker). */
  readonly tapeExtensions: readonly string[];
  /** Save-menu entries in the Load/Save pane, in display order. */
  readonly saveMenu: readonly SaveMenuItem[];
  /** How .zip archives are handled by the Load path: offer every entry
   *  ('all'), only entries matching accepts() ('media'), or reject ('none'). */
  readonly zipPolicy: 'all' | 'media' | 'none';
  /** Persist mounted disks/snapshots across reloads (tapes always persist). */
  readonly persistMedia: boolean;
  /** Machine offers a hidden default boot-disk profile. */
  readonly bootDisk: boolean;
  /** Machine hidden-mounts a default firmware cartridge when its cartridge slot
   *  is empty (CPC Plus / GX4000 → plus-system.cpr). */
  readonly bootCartridge?: boolean;
  /** Software-library button applies. */
  readonly library: boolean;
  /** ROM regions the Memory pane's region picker offers (besides mapped/banks). */
  readonly memoryRegions: readonly MemoryRegionInfo[];
  /** ASCII glyph table the Memory pane renders with. */
  readonly charset: 'spectrum' | 'cpc' | 'bbc' | 'apple2';
  /** Hardware is memory-mapped, so a write through the Memory pane's Mapped view
   *  can reach a device register and have side effects (BBC/Electron SHEILA, the
   *  Apple II soft switches). The pane warns when this is set. */
  readonly memoryMappedIo?: boolean;
}

/**
 * The operator's panel — how a machine reaches *out* (status line, "this media
 * needs a different model", persistence). Provided by the shell (or MCP) via
 * `attachHost`; a machine must function with no host attached.
 */
export interface MachineHost {
  setStatus(msg: string): void;
  /** Ask to be rebuilt as `model` (e.g. a 128K-only snapshot on a 48K, a CPC
   *  .sna for a different CPC). Resolves false if the host declines. The
   *  current machine instance is destroyed on success — treat as terminal. */
  requestModel(model: MachineModel, reason: string): Promise<boolean>;
  /** Persist (data) or clear (null) a piece of mounted media under a
   *  machine-chosen key, so a reload can restore it. */
  persistMedia(kind: string, data: Uint8Array | null, name: string): void;
  /** Record a boolean hardware option the machine itself changed (a snapshot
   *  that carries the board revision), so the panes and the next session agree
   *  with the running machine. Absent headless. */
  setFlagSetting?(key: string, on: boolean): void;
  /** The operator's EPROM box: persistence + rebuild ops backing RomService.
   *  Provided by the shell (rom-manager + model switch); absent headless. */
  roms?: RomHostOps;
}

/** Host-side backing for a machine's RomService: the machine owns slot layout
 *  and splice rules; the host owns override storage and the rebuild. Pages are
 *  16K indices for multi-page models; the full-image ops cover the whole ROM. */
export interface RomHostOps {
  persistFull(data: Uint8Array, label: string): Promise<void>;
  clearFull(): Promise<void>;
  persistPage(page: number, data: Uint8Array, label: string): Promise<void>;
  clearPage(page: number): Promise<void>;
  /** Cached override metadata (null = default in use). */
  cached(): { label: string; size: number; isCustom: boolean } | null;
  cachedPage(page: number): { label: string; size: number } | null;
  /** Sideways/aux ROM socket overrides (the BBC's sixteen banks). */
  persistSideways(index: number, data: Uint8Array, label: string): Promise<void>;
  clearSideways(index: number): Promise<void>;
  /** Rebuild the machine so the new ROM takes effect. Destroys this machine. */
  rebuild(): Promise<void>;
}

/** Read-only view over the generic key/value settings store. The shell snapshots
 *  the store into this and pushes it via `applySettings`; machines never import
 *  the reactive settings module. */
export interface SettingsView {
  get<T>(key: string, fallback: T): T;
}

/**
 * A peripheral-ROM load a machine wants performed. The machine owns everything
 * peripheral-specific (which cache key, which ROM source, the human status text,
 * and how the bytes are wired into its chip); the shell owns the generic
 * fetch/IndexedDB-cache/status/failure-signal mechanics. This is how the shell's
 * old per-machine peripheral-ROM cascade dissolves: the machine's `prepare()` /
 * `bootRoms()` hooks return these, and the shell fulfils them uniformly.
 */
export interface AuxRomRequest {
  /** IndexedDB cache key. */
  readonly cacheKey: string;
  /** Bare filename or explicit path/URL fetched on a cache miss. */
  readonly source: string;
  /** Status shown before a network fetch (cache miss only). */
  readonly fetchingMsg: string;
  /** Status shown once the ROM is wired in. */
  loadedMsg(bytes: number): string;
  /** Status + failure-signal text on load failure. */
  readonly failMsg: string;
  /** Which peripheral-ROM-failure signal the shell sets/clears (e.g. 'vtx5000',
   *  'multiface', 'plusd', 'betadisk', 'interface1', 'parados'). */
  readonly failId: string;
  /** Wire the fetched bytes into the peripheral's chip. */
  apply(data: Uint8Array): void;
  /** Await the load before continuing (ROM must be present before reset), or
   *  fire-and-forget (Multiface — paged only on the button press). */
  readonly awaitLoad: boolean;
}

// ── Media / device services ─────────────────────────────────────────────────

/** Identifies a mountable device inside a machine, e.g. 'tape', 'drive:0',
 *  'cartridge', 'snapshot', 'rom'. Machine-defined; opaque to the shell. */
export type MediaTargetId = string;

export interface MediaTypeDescriptor {
  /** Lower-case extension including the dot, e.g. '.tzx'. */
  readonly ext: string;
  /** Default device this extension routes to (informational for pickers). */
  readonly target: MediaTargetId;
}

export interface MountResult {
  readonly ok: boolean;
  /** Device the media actually landed in (when ok). */
  readonly target?: MediaTargetId;
  /** Human status line ("Disk A: loaded: game.dsk" / error text). */
  readonly message: string;
  /** Set when the mount triggered a host.requestModel() rebuild (e.g. a 128K
   *  snapshot on a 48K): this machine is destroyed; the shell must re-dispatch
   *  the same file to the NEW machine's MediaService. */
  readonly replay?: boolean;
  /** Set when the mount replaced drive or tape contents of its own accord (an
   *  Atari snapshot carries its disks and cassette): the shell re-reads the
   *  drives and tape into the panes and persistence. */
  readonly mediaChanged?: boolean;
  /** Set with `ok: false` when the disk needs a different drive than the one it
   *  was meant for (a .d81 with only a 1541 fitted): the shell sets drive `index`
   *  to `model` (rebuilding the machine if that needs a ROM it has not fetched),
   *  then re-dispatches the file once. `message` is what to show if that fails. */
  readonly needsDriveModel?: { readonly index: number; readonly model: string };
}

/**
 * File routing for one machine. The shell handles machine-agnostic concerns
 * (zip unwrapping, multi-entry pickers, persistence, signal updates) and hands
 * everything else here; the machine owns ALL routing logic — which extension
 * goes to which device given its fitted peripherals. After a successful mount
 * the shell re-reads the device services (tape/disks/roms) to refresh state.
 */
export interface MediaService {
  /** Extensions currently loadable (varies with enabled peripherals). */
  accepts(): MediaTypeDescriptor[];
  mount(data: Uint8Array, filename: string, target?: MediaTargetId): Promise<MountResult>;
  /**
   * Take a whole .zip at once — every file in it, unfiltered. For software
   * that ships as several files which load one another by name (the
   * Enterprise's programs, served through its FILE: device), so picking one
   * entry would strand the rest. Resolve null to decline, and the shell
   * unwraps the archive the usual way. Omitted by machines that only ever
   * mount one file.
   */
  mountArchive?(files: readonly ArchiveFile[], archiveName: string): Promise<MountResult | null>;
}

/** One file out of an archive handed to `MediaService.mountArchive`. */
export interface ArchiveFile {
  readonly name: string;
  readonly data: Uint8Array;
}

export interface TapeBlockInfo {
  readonly index: number;
  readonly label: string;
  /** Format-specific kind tag ('header', 'data', 'turbo', …) for pane styling. */
  readonly kind: string;
  /** Optional second line for instant-cassette block listings. */
  readonly detail?: string;
  /** Optional file metadata used by the instant-cassette pane. */
  readonly name?: string;
  readonly type?: string;
  readonly size?: number;
}

/** Cross-rebuild tape transport state (see TapeService.stashState). Data-shaped
 *  rather than fully opaque so the shell can reflect a restore into the right
 *  signal family without asking the machine's kind. */
export interface TapeStashState {
  /** Pulse-deck machines: parsed blocks + transport position. */
  blocks?: TapeBlock[];
  position?: number;
  paused?: boolean;
  /** Instant-load cassette machines: the raw image bytes. */
  casData?: Uint8Array;
}

/** Cassette transport. Pulse-level decks and logical instant-load cassette
 *  formats share one surface so the tape pane and state stay machine-blind. */
export interface TapeService {
  readonly loaded: boolean;
  readonly name: string;
  readonly blocks: readonly TapeBlockInfo[];
  /** The pulse-deck block list backing the tape-pane signal ([] for instant
   *  cassettes, whose block view flows through the cas signals instead). */
  readonly rawBlocks: readonly TapeBlock[];
  readonly position: number;
  readonly playing: boolean;
  readonly paused: boolean;
  /** Parse + mount persisted tape bytes (positioned at start, paused, not
   *  playing) — the reload-restore path. False when the data isn't a tape
   *  this machine understands. Async: some formats (CSW) decompress. */
  mountBytes(data: Uint8Array, name: string): Promise<boolean>;
  /** Cross-rebuild transport state (deck blocks / cassette bytes) for the
   *  shell's per-kind tape stash. null = nothing mounted. */
  stashState(): TapeStashState | null;
  /** Re-mount a stashed transport state on a fresh machine of the same kind. */
  restoreStash(state: TapeStashState, name: string): void;
  play(): void;
  pause(): void;
  /** Clear pause WITHOUT restarting the current block (play() re-begins the
   *  block at `position`; resume() picks up mid-block exactly where pause
   *  left the pulse engine). */
  resume(): void;
  /** Full stop (motor off) — distinct from pause on a real deck, and from the
   *  Spectrum loader-detector's point of view (a user stop blocks auto-play). */
  stop(): void;
  rewind(): void;
  seek(block: number): void;
  eject(): void;
  /** Bytes the machine has written to its cassette port since the last reset,
   *  for the Save menu's 'tape-tap' entry, or null when it has saved nothing.
   *  Omitted by machines that do not record what they save. */
  recordedBytes?(): { data: Uint8Array; filename: string } | null;
}

export interface DriveDescriptor {
  /** Stable id within this machine ('a', 'plusd:0', …). */
  readonly id: string;
  /** Pane label ("A:", "+D drive 1", "Drive 0"). */
  readonly label: string;
  readonly loaded: boolean;
  readonly mediaName: string;
  readonly writeProtected: boolean;
  readonly motorOn: boolean;
}

/** Media a drive accepts: a parsed floppy image, or raw cartridge bytes for
 *  byte-stream devices (IF1 microdrives take .mdr images, not DskImages). */
export type DriveMedia = DskImage | Uint8Array;

/** Hidden default disk supplied by a machine's own service. The shell fetches
 * and caches the bytes, while the service owns the format decoder. */
export interface BootDiskRequest {
  readonly source: string;
  readonly cacheKey: string;
  parse(data: Uint8Array): DriveMedia;
}

/** Every drive-bearing device the machine currently has fitted, flattened:
 *  the +3's internal uPD765A units and any enabled +D/Beta/IF1 drives appear
 *  side by side, distinguished only by their descriptors. */
export interface DiskService {
  readonly drives: readonly DriveDescriptor[];
  /** Optional hidden disk mounted in the first drive when the profile is
   * enabled and no explicit user disk occupies it. */
  readonly bootDisk?: BootDiskRequest | null;
  /** Live enable switch for profiles whose hidden boot disk is optional. */
  setBootDiskEnabled?(on: boolean): void;
  insert(id: string, media: DriveMedia, name: string): void;
  eject(id: string): void;
  /** Serialize the drive's current image for download (the name carries the
   *  format-appropriate extension), or null if the drive is empty. */
  save(id: string): { data: Uint8Array; name: string } | null;
  setWriteProtect(id: string, on: boolean): void;
  /** Live parsed image in a drive (drive-pane info signals), or null. */
  image?(id: string): DskImage | null;
  /** Force the drive-ready line on regardless of media (uPD765A drives). */
  setForceReady?(id: string, on: boolean): void;
  /** Flip a "flippy" double-sided image to its other side; returns the new
   *  side (0/1), or null when the drive's media isn't flippy. */
  flipSide?(id: string): number | null;
  /** Format a fresh blank cartridge/disk directly in the drive (IF1 microdrive
   *  FORMAT — a machine mechanism with no generic image codec) and return the
   *  serialized bytes + filename for the shell to persist, or null when the
   *  drive doesn't support in-place formatting. */
  formatBlank?(id: string, name?: string): { data: Uint8Array; name: string } | null;
  /** Machines with `ui.driveModels`: the model of each fitted drive, in order. */
  readonly driveModels?: readonly string[];
  /** Change one drive's model; its disk stays in it. Resolves once the machine
   *  has been rebuilt, when the model needed a ROM that had to be fetched. */
  setDriveModel?(index: number, model: string): void | Promise<void>;
  /** Add an empty drive below `after` (same model); the drives under it move
   *  down with their disks. False when no more fit. */
  addDrive?(after: number): boolean;
  /** Remove a drive and its disk; the drives under it move up. False for the
   *  last drive. */
  removeDrive?(index: number): boolean;
}

export interface RomSlotInfo {
  readonly index: number;
  /** Fixed socket name shown as the row title (e.g. '128K Editor ROM'). When
   *  omitted, the pane falls back to the descriptor's systemRomLabel. */
  readonly title?: string;
  readonly label: string;
  readonly size: number;
  /** True when a user-supplied image overrides the default. */
  readonly overridden: boolean;
}

/**
 * A named auxiliary ROM socket besides the system ROM — the BBC's sixteen
 * sideways banks, each independently loadable. The machine reports the socket
 * layout and any image it loads itself (the disc-interface ROM); the shell
 * layers the stored user overrides on top (see RomService.sidewaysSlots).
 */
export interface SidewaysRomSlot {
  readonly index: number;
  /** Fixed socket name shown as the row title. */
  readonly title: string;
  /** Image currently in the socket (a machine-loaded default), or ''. */
  readonly label: string;
  readonly size: number;
  /** A user-supplied image is stored for this socket (filled by the shell). */
  readonly overridden: boolean;
}

export interface CartridgeSlot {
  /** Mounted cartridge name, '' when empty. */
  readonly name: string;
  insert(data: Uint8Array, name: string): void;
  eject(): void;
}

/** System-ROM and cartridge management for the ROM pane. */
export interface RomService {
  readonly systemSlots: readonly RomSlotInfo[];
  /** Burn the system-ROM image into the machine (build-time raw install; no
   *  persistence, no rebuild — that's what setSystemRom is for). */
  installSystemRom(data: Uint8Array): void;
  setSystemRom(data: Uint8Array, label: string, page?: number): Promise<void>;
  resetSystemRom(page?: number): Promise<void>;
  /** The machine's cartridge slot (MSX slot, ZX Interface 2), or null. */
  readonly cartridge: CartridgeSlot | null;

  /** Named auxiliary ROM sockets besides the system ROM (the BBC's sixteen
   *  sideways banks). Absent/empty on machines without any. */
  readonly sidewaysSlots?: readonly SidewaysRomSlot[];
  /** Build-time install of a sideways socket image (no persistence/rebuild). */
  installSidewaysRom?(index: number, data: Uint8Array): void;
  /** Persist a user image into a socket and rebuild. */
  setSidewaysRom?(index: number, data: Uint8Array, label: string): Promise<void>;
  /** Drop a socket's stored override and rebuild (back to the default). */
  resetSidewaysRom?(index: number): Promise<void>;
}

export interface SnapshotApplyResult {
  readonly ok: boolean;
  /** The apply triggered a host.requestModel() rebuild — this machine is gone;
   *  re-dispatch the same file to the new machine (see MountResult.replay). */
  readonly needsReplay?: boolean;
  readonly message: string;
}

export interface SnapshotService {
  formats(): { ext: string; canSave: boolean }[];
  apply(data: Uint8Array, filename: string): Promise<SnapshotApplyResult>;
  /** Serialize current state (async: some formats compress). */
  save(ext: string): Promise<Uint8Array>;
  /** Synchronous full-state snapshot for the browser-refresh path (must run from
   *  a `beforeunload` handler). null when the machine can't serialise
   *  synchronously; its presence also gates whether the shell attempts refresh
   *  resume at all. */
  saveSync?(): Uint8Array | null;
  /** Restore a saveSync() snapshot on the SAME model (refresh resume): no model
   *  upgrade, no persistence, no reflection. Returns true on success. */
  restoreSync?(data: Uint8Array): Promise<boolean>;
}

// ── Debug service ───────────────────────────────────────────────────────────

export interface RegisterDesc {
  readonly name: string;
  readonly width: 8 | 16;
  readonly value: number;
  /** Grouping hint for generic layouts ('main', 'alt', 'index', 'system'…). */
  readonly group?: string;
}

export interface RegisterSnapshot {
  readonly pc: number;
  readonly sp: number;
  readonly tStates: number;
  /** Interrupt mode (family-specific meaning; Z80: 0/1/2). */
  readonly im: number;
  readonly iff1: boolean;
  readonly halted: boolean;
  readonly flags: readonly { name: string; set: boolean }[];
  readonly regs: readonly RegisterDesc[];
}

export interface DisasmRow {
  readonly addr: number;
  readonly bytes: string;
  readonly text: string;
  readonly length: number;
  /** Control leaves here unconditionally (Z80 RET/JP, 6502 RTS/JMP), so the
   *  bytes after it are usually data, not the next instruction. Listings that
   *  disassemble a routine stop on it; `disasm()` itself always returns the
   *  full count asked for. */
  readonly isTerminal: boolean;
}

/** Direct access to a CPU's I/O-port space (the Z80's IN/OUT), for hosts that
 *  poke hardware without executing code. Machines whose CPU has no port space
 *  expose `DebugService.ports === null`. */
export interface CpuPorts {
  in(port: number): number;
  out(port: number, value: number): void;
}

/** A machine-specific debug panel the machine offers (sysvars, BASIC listing,
 *  banks…). Data only — the matching UI component is registered separately in
 *  the UI-side manifest (§3.5). */
export interface DebugPanelDescriptor {
  readonly id: string;
  readonly title: string;
}

/**
 * CPU-family-specific debug provider (implemented once per family in
 * `machines/debug-<family>/`, wired by each machine). Breakpoint/watchpoint
 * storage stays on the machine itself (BaseMachine fields — the frame loop
 * checks them on the hot path); this service is the *presentation and control*
 * surface over CPU state.
 */
export interface DebugService {
  readonly cpuFamily: CpuFamily;
  /** Cheap scalar reads for hosts polling between frames (no snapshot alloc). */
  readonly pc: number;
  readonly tStates: number;
  regs(): RegisterSnapshot;
  /** Read a register by family-conventional name; null = unknown register. */
  getReg(name: string): number | null;
  /** Poke a register by family-conventional name; false = unknown register. */
  setReg(name: string, value: number): boolean;
  /** Plain-text disassembly rows — `text` carries no formatting markers, so a
   *  text host can print it as-is (the pane's marked-up variant is
   *  `disasmPaneHtml`). */
  disasm(addr: number, lines: number): DisasmRow[];
  /** The debugger pane's disassembly-around-PC HTML (family formatting). */
  disasmPaneHtml(lines: number): string;
  /** Raw single instruction (host stepping — no UI wake semantics). */
  stepOne(): void;
  /** UI stepping (a halted CPU is woken into its interrupt handler first). */
  stepInto(): void;
  stepOver(): void;
  stepOut(): void;
  /** Multi-line CPU state + disassembly block (clipboard copy). */
  cpuStateText(): string;
  /** Start an execution trace ('full', 'portio' or 'zxtl'; a mode the
   *  machine does not offer is ignored). */
  startTrace(mode?: string): void;
  /** Stop the trace and return its text. */
  stopTrace(): string;
  /** The mode of the trace started and not yet stopped — it may already have
   *  stopped capturing at its line cap — or null. */
  traceSession(): MachineTraceMode | null;
  /** Screen OCR ('auto' or a machine-defined grid name). */
  ocr(mode?: string): string;
  /** Resolve a Memory-pane ROM region id (descriptor.ui.memoryRegions) to a
   *  live byte view + base address, or null when unavailable. */
  resolveMemoryRegion(value: string): { data: Uint8Array; baseAddr: number } | null;
  /** Raw screen-memory dump for the `.scr` export (machine-defined layout:
   *  Spectrum bank 5, CPC CRTC quadrant, TMS9918A VRAM), or null. */
  screenExport(): Uint8Array | null;
  /** RAM dump + suggested filename for the RAM export, or null. */
  ramExport(): { data: Uint8Array; filename: string } | null;
  /** What the machine has sent its printer, as a file + suggested filename
   *  for the Save menu's printer-output entry; null while nothing has been
   *  printed. Only machines naming 'printer-txt' implement it. */
  printerExport?(): { data: Uint8Array; filename: string } | null;
  panels(): DebugPanelDescriptor[];

  /* Family-formatted text for hosts that print CPU state (the MCP server's
   * `step`/`registers`/trap log). The layout — which registers, in what order,
   * with what flag letters — is family knowledge, so it is produced here rather
   * than reassembled from `regs()` by every host. */

  /** One line: PC, the instruction there, the working registers, elapsed time. */
  stepLine(): string;
  /** Multi-line register/flag block (the MCP `registers` readout). */
  regsText(): string;
  /** Compact one-line register summary appended to trap-log entries. */
  regsSummary(): string;

  /** Return addresses currently sitting on the stack, innermost first — the
   *  RET/RTS chain a crash unwound through. Reads memory only; no side effects. */
  returnStack(depth: number): number[];
  /** Execute a synthetic return (Z80 RET, 6502 RTS): pop the return address into
   *  PC. Used by respond-mode traps that skip the real routine. */
  returnFromCall(): void;

  /** The CPU's I/O-port space, or null on machines whose CPU has none (the
   *  6502 memory-maps its hardware instead). */
  readonly ports: CpuPorts | null;

  /** The machine's custom chips, each with a dump of its registers and
   *  decoded state (read without side effects); absent where the machine does
   *  not offer them. */
  chips?(): readonly ChipSection[];
}

// ── Input service ───────────────────────────────────────────────────────────

/** A host keyboard event, pre-digested so machines don't touch DOM types. */
export interface HostKeyEvent {
  readonly code: string;
  readonly key: string;
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
}

export interface MouseSink {
  motion(dx: number, dy: number): void;
  button(index: number, down: boolean): void;
  wheel(delta: number): void;
}

/** Host input delivery. Each machine maps host events onto its own keyboard
 *  matrix / joystick / mouse hardware — replacing the shell's per-machine
 *  dispatch ladder. */
/** Mode-aware mouse routing. The pane owns which interface is captured and
 *  passes its id (one of `MachineUiCapabilities.mouseTypes`) per event; a
 *  machine with a single mouse ignores it. Host deltas arrive raw — a machine
 *  applies its own Y sign here, since that is hardware, not capture policy. */
export interface MouseInput {
  setMode(mode: string | null): void;
  motion(dx: number, dy: number, mode: string | null): void;
  button(index: number, pressed: boolean, mode: string | null): void;
}

/** Joystick delivery: direction/fire press mapped onto the machine's own
 *  joystick hardware (Kempston port, PPI matrix row, …). */
export interface JoystickInput {
  press(dir: string, pressed: boolean, mode: string, player: number): void;
  /**
   * Proportional stick position, for a machine whose joystick is analogue (a
   * BBC Micro's ADC, the Apple II's paddle timers, …). `value` runs from -1
   * (full left / full up) through 0 (centred) to +1 (full right / full down);
   * the machine converts that to its own hardware's scale and direction.
   *
   * Optional: only machines with analogue inputs implement it. When it is
   * present the input controller sends a gamepad's analogue axes here and does
   * not also send that axis's digital directions, so an axis is driven by one
   * path at a time; keys and the on-screen pad still arrive through `press`,
   * where a direction means full deflection.
   */
  analog?(axis: 'x' | 'y', value: number, player: number): void;
}

export interface InputService {
  /** Returns true when the event was consumed (shell then preventDefaults). */
  keyDown(e: HostKeyEvent): boolean;
  keyUp(e: HostKeyEvent): boolean;
  /** Release everything (window blur). */
  releaseAll(): void;
  readonly mouse: MouseSink | null;
  /** Mode-aware two-mouse routing, or null when the machine has no mice. */
  readonly mice?: MouseInput | null;
  /** Joystick press routing, or null when the machine has no joystick. */
  readonly joystick?: JoystickInput | null;
}

// ── Frame probe ─────────────────────────────────────────────────────────────

/**
 * Per-frame dashboard sample. ONE preallocated instance is reused every frame
 * (`FrameProbe.sample` must not allocate — §6). Channels are generic; each
 * machine writes only what it has and maps its own counters onto them (the
 * Spectrum maps Kempston reads → joystick, attribute-cycling → videoFx, …).
 * The bridge owns presentation policy: the 500ms LED latch, string formatting,
 * signal diffing — machines only report this frame's raw source state.
 */
export interface FrameIndicators {
  /* Raw LED source levels for this frame, 0 = idle (latched by the bridge). */
  keyboard: number;
  joystick: number;
  mouse: number;
  /** EAR-style tape input sampling (Spectrum ROM loader polls). */
  tapeIn: number;
  tapeLoad: number;
  beeper: number;
  psg: number;
  /** Attribute-cycling / palette-effect activity ("rainbow"). */
  videoFx: number;
  disk: number;
  /** Sustained tape-turbo engine state — reflected immediately, not latched. */
  tapeTurbo: boolean;

  /* Cassette transport (deck machines; tapeLoaded=false ⇒ bridge leaves the
   * tape signals alone). */
  tapeLoaded: boolean;
  tapePlaying: boolean;
  tapePaused: boolean;
  tapeFinished: boolean;
  tapePosition: number;
  /** Instant-load cassette block being read this frame, -1 = no update. */
  casBlock: number;
  /** ROM fast-loader engaged (drives the one-shot status announcement). */
  fastRomLoading: boolean;

  /** Machine trace engine currently capturing (bridge auto-stop edge detect). */
  tracingActive: boolean;

  /* Drive panel slots A..D (fixed 4). led -1 = slot absent (signal untouched);
   * 0 off, 1 motor, 2 read, 3 write. sector -1 renders as '--'. */
  driveLed: Int8Array;
  driveTrack: Int16Array;
  driveSector: Int16Array;
  driveDirty: Uint8Array;
  /** Slot (0..3) whose media a FORMAT just rewrote this tick, -1 = none. */
  formattedSlot: number;

  /* Microdrive motor states, one bit per drive. mdvCount = 0 when no IF1. */
  mdvMotorMask: number;
  mdvCount: number;
  /** Physical MDR sector under each active drive's head, or -1 while idle. */
  mdvSector: Int16Array;

  /* Floppy drive-sound feed. floppySlot: A..D panel slot whose per-drive sound
   * setting gates the synth, -1 = no sound-capable drive path active.
   * floppyProfile: 0 = 3" CF2, 1 = 3.5", 2 = 5.25", -1 = keep the synth's
   * current one (DRIVE_PROFILE in media/floppy/floppy-sound.ts). */
  floppySlot: number;
  floppyMotor: boolean;
  floppyTrack: number;
  floppyProfile: number;
}

export function createFrameIndicators(): FrameIndicators {
  return {
    keyboard: 0, joystick: 0, mouse: 0, tapeIn: 0, tapeLoad: 0,
    beeper: 0, psg: 0, videoFx: 0, disk: 0, tapeTurbo: false,
    tapeLoaded: false, tapePlaying: false, tapePaused: true, tapeFinished: false,
    tapePosition: 0, casBlock: -1, fastRomLoading: false,
    tracingActive: false,
    driveLed: new Int8Array([-1, -1, -1, -1]),
    driveTrack: new Int16Array(4),
    driveSector: new Int16Array([-1, -1, -1, -1]),
    driveDirty: new Uint8Array(4),
    formattedSlot: -1,
    mdvMotorMask: 0, mdvCount: 0, mdvSector: new Int16Array(8).fill(-1),
    floppySlot: -1, floppyMotor: false, floppyTrack: 0, floppyProfile: -1,
  };
}

/** Pull-on-demand debug-pane content. Called by the bridge only when the pane
 *  is open (and throttled as the bridge sees fit) — may allocate freely. */
export interface FramePaneProvider {
  /** Structured memory-layout snapshot, or null when this model has none. */
  memoryMap?(): MemoryMapSnapshot | null;
  /** Detokenised BASIC program listing, as structured plain-text lines. */
  basicListing?(): BasicListingLine[];
  /** BASIC variables area, as structured plain-text entries. */
  basicVars?(): BasicVariable[];
  /** Machine has a sysvars pane (the bridge bumps its refresh signal). */
  readonly hasSysvars?: boolean;
  /** Candidate in-memory character font for the Font pane's ROM-capture path
   *  (Spectrum CHARS heuristic): the 768-byte font's start address within the
   *  returned address-space snapshot, or null when no valid font is resident.
   *  Hash-caching and slicing stay bridge-side. */
  romFontCandidate?(): { fontStart: number; snap: Uint8Array } | null;
}

/** OCR text-overlay driver. `run()` performs the OCR, blanks the matched cells
 *  in the machine's framebuffer, re-uploads the display, and returns the
 *  overlay strings. Only called while transcribe mode is on — may allocate. */
export interface TranscribeDriver {
  readonly active: boolean;
  /** extraFonts: host-supplied user fonts (Spectrum font store); others ignore. */
  activate(extraFonts?: readonly FontSource[]): void;
  deactivate(): void;
  run(): {
    text: string;
    html: string;
    grid: OcrGridName;
    /**
     * Where the transcribed text sits in the framebuffer, in buffer pixels.
     * Omitted when the grid simply fills the descriptor's active area, which
     * is the usual case; supplied when it does not — the Einstein 256 centres
     * a 192-line GRAPHIC 2 field in its 212-line window, so an overlay
     * stretched over the whole active area lands progressively lower than the
     * text it is covering.
     */
    field?: { x: number; y: number; width: number; height: number };
  };
}

export interface FrameProbe {
  /** Overwrite `out` in place with this frame's indicator state. PURE READ —
   *  no allocation, no machine mutation. Called every rAF. */
  sample(out: FrameIndicators): void;
  /** Once-per-UI-frame device bookkeeping: FDC frame ticks, one-shot event
   *  consumption (format latch → out.formattedSlot),
   *  tape auto-rewind. Runs at the bridge's signal-batch cadence (throttled
   *  under turbo), exactly like the pre-probe per-machine bodies. */
  frameTick?(out: FrameIndicators): void;
  /** Live disk image in panel slot 0..3 (post-format metadata refresh). */
  diskImageForSlot?(slot: number): DskImage | null;
  readonly panes?: FramePaneProvider;
  readonly transcribe?: TranscribeDriver;
}

// ── Service bundle + registry entry ─────────────────────────────────────────

/**
 * The full service surface of a machine. Grouped under one property (rather
 * than flat on `Machine`) because the legacy field `tape: TapeDeck` collides
 * with the `TapeService` accessor during the transition — and because it makes
 * the Phase 7 slimming a single-property swap.
 */
export interface MachineServices {
  readonly media: MediaService;
  readonly roms: RomService;
  readonly tape: TapeService | null;
  readonly disks: DiskService | null;
  readonly snapshots: SnapshotService | null;
  readonly debug: DebugService;
  readonly input: InputService;
  readonly probe: FrameProbe;
}

/**
 * One machine family's registry entry: the parts catalog line. `registry.ts`
 * and `src/models.ts` are the ONLY files that may name every machine (§3.5).
 */
export interface MachineEntry {
  readonly kind: MachineKind;
  readonly models: readonly MachineModel[];
  descriptor(model: MachineModel, locale?: MachineLocale): MachineDescriptor;
  /** Build the machine. `locale` matters only to machines whose hardware
   *  differs by region (the Atari's NTSC/PAL timing); others ignore it. */
  create(model: MachineModel, display: IScreenRenderer | null, locale?: MachineLocale): Machine;
  /** Default system-ROM image sources, fetched and concatenated in order by the
   *  shared rom-manager machinery. */
  romSources(model: MachineModel, locale?: MachineLocale): readonly string[];
  /** Source (ROM-host name or URL) of the hidden default cartridge to mount when
   *  this model's cartridge slot is empty, or undefined if it has none. Fetched
   *  generically by the rom-manager; keeps the image identity in the machine
   *  that owns it (CPC Plus → plus-system.cpr). Paired with `ui.bootCartridge`. */
  bootCartridgeSource?(model: MachineModel, locale?: MachineLocale): string | undefined;
  /** Classify a raw system-ROM image dropped on the ROM pane to the model that
   *  should host it (inferred from its size + the current model), or null when
   *  this machine family can't accept the image. Keeps ROM-size→model knowledge
   *  in the machine that owns it; the shell iterates entries. */
  detectModelForRom?(data: Uint8Array, current: MachineModel): MachineModel | null;
}

/** The devices that are actually fitted: those with no `enabledSetting` (always
 *  there) plus those whose setting `isOn` reports on. */
export function presentSoundDevices(
  devices: readonly SoundDeviceInfo[] | undefined,
  isOn: (setting: string) => boolean,
): readonly SoundDeviceInfo[] {
  return (devices ?? []).filter((d) => !d.enabledSetting || isOn(d.enabledSetting));
}

/** Slider ceiling of a sound device in percent. */
export function soundDeviceMaxVolume(device: SoundDeviceInfo): number {
  return device.maxVolume ?? 100;
}

/**
 * The mixer gain (1 = unity) for each sound-device id, from the persisted volumes
 * in `view`. Volumes are percent, clamped to 0..the device's ceiling. With fewer
 * than two devices present every gain is 1: a lone device has no slider, so a
 * volume left over from another configuration must not silently quieten it.
 */
export function soundDeviceGains(
  devices: readonly SoundDeviceInfo[] | undefined,
  view: SettingsView,
): Record<string, number> {
  const gains: Record<string, number> = {};
  const mixing = presentSoundDevices(devices, (key) => Boolean(view.get(key, false))).length > 1;
  for (const d of devices ?? []) {
    if (!mixing) { gains[d.id] = 1; continue; }
    const pct = Number(view.get(d.volumeSetting, 100));
    const clamped = Number.isFinite(pct) ? Math.min(soundDeviceMaxVolume(d), Math.max(0, pct)) : 100;
    gains[d.id] = clamped / 100;
  }
  return gains;
}
