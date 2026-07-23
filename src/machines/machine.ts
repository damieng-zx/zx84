/**
 * Machine — the common surface shared by every emulated computer.
 *
 * The machine-blind handle the shell, UI, and MCP hold. Everything chip-shaped
 * (CPU, PSG, FDC, tape deck, mixer) and everything CPU-family-shaped (register
 * layout, disassembly, tracing) lives OFF this interface: consumers reach
 * machine internals only through `services` (§3.3) and the per-family debug
 * provider (`services.debug`, backed by `debug/<family>/`).
 *
 * Deliberate exceptions kept on the interface (see docs/re-architecture.md §6):
 *  - `memory` — the 64KB address-space view is a fundamental machine property
 *    (a 6502 machine has one too), used pervasively by hosts and debug tools.
 *  - breakpoint/watchpoint storage — generic across CPU families, and the
 *    frame loop checks these fields on the hot path; they stay where BaseMachine
 *    declares them.
 */

import type { DskImage } from '@/media/floppy/disk-image.ts';
import type { IScreenRenderer } from '@/display/renderer.ts';
import type { ByteReader } from '@/machines/spectrum/memory.ts';
import type { TapeBlock } from '@/media/tape/tap.ts';
import type { MachineModel } from '@/models.ts';
import type { OcrGridName, FontSource } from '@/ocr/ocr.ts';
import type { BasicListingLine, BasicVariable } from '@/basic/types.ts';

export type MachineKind = 'spectrum' | 'cpc' | 'einstein' | 'msx' | 'zx8x' | 'mtx';

/** Keyboard/ROM locale for international machine variants.
 *  'uk' = default (English, no locale-specific ROM/keyboard). */
export type MachineLocale = 'uk' | 'es' | 'fr';

/** Border-size selector shared by both machines: 0=none, 1=small, 2=normal. */
export type BorderMode = 0 | 1 | 2;

/** Trace flavours supported by the debug layer. */
export type MachineTraceMode = 'full' | 'portio' | 'zxtl';

/**
 * The common memory surface. Both `SpectrumMemory` and the CPC's memory expose
 * a live flat 64KB Z80 view plus the bulk accessors used by snapshots, the
 * debug tools, and MCP. Machine-specific paging state (port7FFD, ROM overlays)
 * stays on the concrete classes.
 */
export interface IMachineMemory extends ByteReader {
  readByte(addr: number): number;
  writeByte(addr: number, val: number): void;
  readBlock(addr: number, len: number): Uint8Array;
  /** Fresh 64KB copy of the current paged address space (debug/snapshot). */
  snapshot(): Uint8Array;
  /** A specific 16KB physical RAM bank as a live view. */
  getRamBank(n: number): Uint8Array;
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
  memWatchpoints: { start: number; end: number; mode: 'read' | 'write' | 'rw' }[];
  memWatchHit: { addr: number; value: number; dir: 'read' | 'write' } | null;
  onTrap: ((pc: number) => boolean) | null;
  onStatus: ((msg: string) => void) | null;
  onFrame: (() => void) | null;

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
   *  owns the trap address(es) for its own ROM family. Machines without a
   *  ROM-loader auto-boot omit this (the shell keys off its presence). */
  armBootTrap?(kind: 'menu' | 'rom48k'): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// Machine SPI v2 (re-architecture Phase 2 — see docs/re-architecture.md §3.2-3.5)
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

/** Identifiers for the status-bar activity LEDs. The runtime catalog (labels,
 *  tips, signals) lives in `ui/components/status-leds.ts`; only the id union is
 *  declared here so machine descriptors stay headless-safe. A machine lists the
 *  ids it exposes via `MachineUiCapabilities.statusLeds`. */
export type StatusLedId =
  | 'kbd' | 'kemp' | 'mouse' | 'ear' | 'load' | 'dsk' | 'text' | 'rainbow' | 'beep' | 'ay' | 'psg';

/**
 * Per-model UI capability flags, declared by each machine's descriptor. The
 * generic panes read these (reactively, keyed off the current model) instead of
 * calling `isCpcModel(...)` / `is128kClass(...)` etc. This keeps the UI machine-
 * blind: a new machine declares its capabilities and the existing panes adapt.
 *
 * Everything here is presentation-facing but *machine-owned*: the machine knows
 * which of its features the UI should surface. Pure data (headless-safe).
 */
export interface MachineUiCapabilities {
  /** Pane ids removed from the sidebar entirely for this machine. */
  readonly hiddenPanes: readonly string[];
  /** Memory-layout ("banks") pane applies to this model. */
  readonly memoryLayout: boolean;
  /** Execution-trace debugger control is available. */
  readonly trace: boolean;
  /** Palette / colour-map family shown in the Display pane. */
  readonly colorMap: 'spectrum' | 'cpc' | 'msx' | 'einstein' | 'mono';
  /** Built-in floppy drives (A:/B:) are fitted. */
  readonly builtinDisk: boolean;
  /** Joystick pane applies. */
  readonly joystick: boolean;
  /** Joystick presents a single fixed interface (no type selector; F2 shown). */
  readonly fixedJoystick: boolean;
  /** Mouse pane applies. */
  readonly mouse: boolean;
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
  /** 1-bit beeper present (Sound-pane mixer + BEEP activity LED). */
  readonly beeper: boolean;
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
  /** Loading-sound toggle applies (AY-audible tape loading). */
  readonly tapeSound: boolean;
  /** Extensions the tape loader accepts (Load picker). */
  readonly tapeExtensions: readonly string[];
  /** Save / snapshot menu family in the Load/Save pane. */
  readonly saveMenu: 'spectrum' | 'cpc' | 'vdp';
  /** How .zip archives are handled by the Load path: offer every entry
   *  ('all'), only entries matching accepts() ('media'), or reject ('none'). */
  readonly zipPolicy: 'all' | 'media' | 'none';
  /** Persist mounted disks/snapshots across reloads (tapes always persist). */
  readonly persistMedia: boolean;
  /** Machine offers an auto-boot phantom boot-disk option (Einstein Xtal DOS). */
  readonly bootDisk: boolean;
  /** Machine hidden-mounts a default firmware cartridge when its cartridge slot
   *  is empty (CPC Plus / GX4000 → plus-system.cpr). */
  readonly bootCartridge?: boolean;
  /** Software-library button applies. */
  readonly library: boolean;
  /** ROM regions the Memory pane's region picker offers (besides mapped/banks). */
  readonly memoryRegions: readonly MemoryRegionInfo[];
  /** ASCII glyph table the Memory pane renders with. */
  readonly charset: 'spectrum' | 'cpc';
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

/** Every drive-bearing device the machine currently has fitted, flattened:
 *  the +3's internal uPD765A units and any enabled +D/Beta/IF1 drives appear
 *  side by side, distinguished only by their descriptors. */
export interface DiskService {
  readonly drives: readonly DriveDescriptor[];
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
}

export interface RomSlotInfo {
  readonly index: number;
  readonly label: string;
  readonly size: number;
  /** True when a user-supplied image overrides the default. */
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
  /** Poke a register by family-conventional name; false = unknown register. */
  setReg(name: string, value: number): boolean;
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
  startTrace(mode?: string): void;
  stopTrace(): string;
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
  panels(): DebugPanelDescriptor[];
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
/** Mode-aware mouse routing (machines with both a Kempston and an AMX mouse).
 *  The pane owns which mode is active and passes it per event, exactly as the
 *  old shell helpers did. */
export interface MouseInput {
  setMode(mode: 'kempston' | 'amx' | null): void;
  motion(dx: number, dy: number, mode: 'kempston' | 'amx' | null): void;
  button(index: number, pressed: boolean, mode: 'kempston' | 'amx' | null): void;
}

/** Joystick delivery: direction/fire press mapped onto the machine's own
 *  joystick hardware (Kempston port, PPI matrix row, …). */
export interface JoystickInput {
  press(dir: string, pressed: boolean, mode: string, player: number): void;
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
  /** uPD765A SCAN opcode rejected this tick, -1 = none. */
  scanUnsupported: number;

  /* Microdrive motor states, one bit per drive. mdvCount = 0 when no IF1. */
  mdvMotorMask: number;
  mdvCount: number;
  /** Physical MDR sector under each active drive's head, or -1 while idle. */
  mdvSector: Int16Array;

  /* Floppy drive-sound feed. floppySlot: A..D panel slot whose per-drive sound
   * setting gates the synth, -1 = no sound-capable drive path active.
   * floppyProfile: 0 = 3" CF2, 1 = 3.5", -1 = keep the synth's current one. */
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
    formattedSlot: -1, scanUnsupported: -1,
    mdvMotorMask: 0, mdvCount: 0, mdvSector: new Int16Array(8).fill(-1),
    floppySlot: -1, floppyMotor: false, floppyTrack: 0, floppyProfile: -1,
  };
}

/** Pull-on-demand debug-pane content. Called by the bridge only when the pane
 *  is open (and throttled as the bridge sees fit) — may allocate freely. */
export interface FramePaneProvider {
  /** Memory-layout pane HTML, or null when this model has none (16K/48K). */
  banksHtml?(): string | null;
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
  run(): { text: string; html: string; grid: OcrGridName };
}

export interface FrameProbe {
  /** Overwrite `out` in place with this frame's indicator state. PURE READ —
   *  no allocation, no machine mutation. Called every rAF. */
  sample(out: FrameIndicators): void;
  /** Once-per-UI-frame device bookkeeping: FDC frame ticks, one-shot event
   *  consumption (format/scan latches → out.formattedSlot/scanUnsupported),
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
  create(model: MachineModel, display: IScreenRenderer | null): Machine;
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
