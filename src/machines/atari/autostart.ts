/**
 * Atari auto-start: boot the medium the user just loaded and start the
 * program on it, typing whatever a person would.
 *
 * Two halves:
 *
 *   Planning (pure). `planForDisk` reads a DOS 2.x / MyDOS-style directory and
 *   `planForTape` looks at the first cassette record, and each decides how the
 *   medium is meant to be started: boot it with BASIC on or off, boot BASIC
 *   and `RUN "D:NAME.BAS"`, `CLOAD` + `RUN`, hold START for a boot tape, or
 *   (for a DOS disk whose one machine-code program is clear) boot DOS and
 *   load it from DUP's menu. A plan becomes a list of `AutostartOp`s.
 *
 *   Running. `compileAutostart` turns the ops into low-level steps for the
 *   machine it will run on (an XL with built-in BASIC is started without it by
 *   holding OPTION; a 400/800 by pulling the BASIC cartridge), and
 *   `AtariAutostart` runs them one frame at a time: hold and release keys,
 *   cold start, wait N frames, wait for the OS to beep, wait for BASIC's
 *   READY prompt or other text on screen. Every wait has a limit; a script
 *   that hits one is dropped quietly (with a status message, unless the wait
 *   was only a chance), so a program that never reaches the prompt it was
 *   expected to costs nothing.
 *
 * The runner talks to the machine through `AutostartHost`, so it is tested
 * against a fake as well as the real thing.
 */

import type { HostKeyEvent } from '@/machines/machine.ts';
import type { AtariDisk } from '@/media/floppy/atr.ts';
import { atariCasFiles, type AtariCasImage } from '@/media/tape/atari-cas.ts';
import { mapAtariKey } from './keyboard.ts';
import { parseXex } from './xex.ts';

// ── Key events ──────────────────────────────────────────────────────────────

const NO_MODS = { shift: false, ctrl: false, alt: false } as const;

export const KEY_ENTER: HostKeyEvent = { code: 'Enter', key: 'Enter', ...NO_MODS };
export const KEY_SPACE: HostKeyEvent = { code: 'Space', key: ' ', ...NO_MODS };
export const KEY_START: HostKeyEvent = { code: 'F2', key: 'F2', ...NO_MODS };
export const KEY_OPTION: HostKeyEvent = { code: 'F4', key: 'F4', ...NO_MODS };

/** The host key event that types `ch`, or null for a character the Atari
 *  keyboard cannot produce. Symbols are looked up by `key`, as the
 *  keyboard mapping does; their shift state comes from the mapping. */
export function keyEventFor(ch: string): HostKeyEvent | null {
  if (ch === '\n') return KEY_ENTER;
  if (ch === ' ') return KEY_SPACE;
  let ev: HostKeyEvent;
  if (ch >= 'A' && ch <= 'Z') ev = { code: `Key${ch}`, key: ch.toLowerCase(), ...NO_MODS };
  else if (ch >= '0' && ch <= '9') ev = { code: `Digit${ch}`, key: ch, ...NO_MODS };
  else ev = { code: 'Equal', key: ch, ...NO_MODS };
  return mapAtariKey(ev) !== null ? ev : null;
}

/** Key events that type `text` (upper case; `\n` is RETURN), or null if any
 *  character cannot be typed. */
export function keyEventsFor(text: string): HostKeyEvent[] | null {
  const out: HostKeyEvent[] = [];
  for (const ch of text) {
    const ev = keyEventFor(ch);
    if (ev === null) return null;
    out.push(ev);
  }
  return out;
}

// ── Plans ───────────────────────────────────────────────────────────────────

/** What to do, independent of which Atari it runs on. */
export type AutostartOp =
  /** Cold start with BASIC on or off. `holdStart` keeps START (and, on an XL
   *  without BASIC, OPTION) down through the reset, until a `release`. */
  | { readonly op: 'boot'; readonly basic: boolean; readonly holdStart?: boolean }
  | { readonly op: 'wait'; readonly frames: number }
  /** Wait for the OS to beep. An `optional` wait that runs out ends the
   *  script without complaint: the beep was only a possibility. */
  | { readonly op: 'beep'; readonly max: number; readonly optional?: boolean }
  | { readonly op: 'ready'; readonly max: number }
  /** Wait for `text` on screen (any case). An `optional` wait that runs out
   *  ends the script without complaint: the prompt was only a possibility. */
  | { readonly op: 'prompt'; readonly text: string; readonly max: number; readonly optional?: boolean }
  /** Type text; `\n` is RETURN. */
  | { readonly op: 'type'; readonly text: string }
  | { readonly op: 'press'; readonly key: HostKeyEvent }
  /** Let go of every key the script is holding. */
  | { readonly op: 'release' };

export type DiskPlan =
  /** Boot the disk; BASIC on or off. */
  | { readonly kind: 'boot'; readonly basic: boolean }
  /** Boot with BASIC and `RUN "D:file"`. */
  | { readonly kind: 'run-basic'; readonly file: string }
  /** Boot DOS and binary-load a program from DUP's menu (`L`). */
  | { readonly kind: 'dup-load'; readonly file: string };

export type TapePlan =
  | { readonly kind: 'boot' }
  /** CSAVEd (`CLOAD`) or LISTed (`ENTER "C:"`) BASIC. `chained` says more
   *  files follow on the tape, which the program is likely to open itself
   *  (a loader that reads its data file: the OS beeps and waits for RETURN). */
  | { readonly kind: 'basic'; readonly via: 'CLOAD' | 'ENTER'; readonly chained?: true }
  /** Nothing to start by itself (a binary file, turbo, unknown). */
  | { readonly kind: 'none' };

const FPS_CAP = 50;
const BOOT_BEEP_MAX = 600;
const BASIC_READY_MAX = 900;
const LOAD_READY_MAX = 60 * FPS_CAP;
const BEEP_MAX = 6 * FPS_CAP;
/** DOS and DUP loading at 19200 baud take several seconds. */
const DUP_MENU_MAX = 30 * FPS_CAP;
const DUP_PROMPT_MAX = 5 * FPS_CAP;

export function opsForDisk(plan: DiskPlan): AutostartOp[] {
  switch (plan.kind) {
    case 'boot': return [{ op: 'boot', basic: plan.basic }];
    case 'run-basic': return [
      { op: 'boot', basic: true },
      { op: 'ready', max: BASIC_READY_MAX },
      { op: 'type', text: `RUN "D:${plan.file}"\n` },
    ];
    case 'dup-load': return [
      { op: 'boot', basic: false },
      // A DOS that starts something itself (a boot manager, a start-up
      // batch) never shows the menu; then that is what runs.
      { op: 'prompt', text: 'SELECT ITEM', max: DUP_MENU_MAX, optional: true },
      { op: 'type', text: 'L\n' },
      { op: 'prompt', text: 'WHAT FILE', max: DUP_PROMPT_MAX },
      { op: 'type', text: `${plan.file}\n` },
    ];
  }
}

export function opsForTape(plan: TapePlan): AutostartOp[] | null {
  switch (plan.kind) {
    case 'none': return null;
    case 'boot': return [
      { op: 'boot', basic: false, holdStart: true },
      { op: 'beep', max: BOOT_BEEP_MAX },       // "press PLAY, then any key"
      { op: 'wait', frames: 30 },
      { op: 'release' },
      { op: 'press', key: KEY_SPACE },
    ];
    case 'basic': return [
      { op: 'boot', basic: true },
      { op: 'ready', max: BASIC_READY_MAX },
      // A CSAVEd program loads and runs in one command. A LISTed one is text
      // that ENTER types into BASIC line by line, so it needs a RUN after.
      { op: 'type', text: plan.via === 'CLOAD' ? 'RUN "C:"\n' : 'ENTER "C:"\n' },
      { op: 'beep', max: BEEP_MAX },            // "press PLAY, then RETURN"
      { op: 'wait', frames: 10 },
      { op: 'press', key: KEY_ENTER },
      ...(plan.via === 'ENTER' ? [
        { op: 'ready', max: LOAD_READY_MAX } as const,
        { op: 'type', text: 'RUN\n' } as const,
      ] : []),
      ...(plan.chained ? [
        // The program's own OPEN of the tape: "press PLAY, then RETURN".
        { op: 'beep', max: BEEP_MAX, optional: true } as const,
        { op: 'wait', frames: 10 } as const,
        { op: 'press', key: KEY_ENTER } as const,
      ] : []),
    ];
  }
}

export function opsNeedBasic(ops: readonly AutostartOp[]): boolean {
  return ops.some(o => o.op === 'boot' && o.basic);
}

// ── Disk planning ───────────────────────────────────────────────────────────

export interface DirEntry {
  /** Position in the directory (0-based): the file number DOS stamps into
   *  each of the file's sectors. */
  readonly index: number;
  readonly name: string;
  readonly ext: string;
  readonly sectors: number;
  readonly start: number;
}

const VTOC_SECTOR = 360;
const DIR_FIRST = 361;
const DIR_LAST = 368;
const ENTRY_SIZE = 16;

const printable = (b: number) => b >= 0x20 && b < 0x7f;

/** The in-use files of a DOS 2.x style directory (sectors 361-368), or null
 *  when the disk has no plausible directory: not a DOS disk, so a custom
 *  boot disk. Deleted, DOS-opened and sub-directory entries are skipped. */
export function readDirectory(disk: AtariDisk): DirEntry[] | null {
  if (disk.sectorCount < DIR_LAST || disk.readSector(VTOC_SECTOR) === null) return null;
  const entries: DirEntry[] = [];
  let index = 0;
  for (let s = DIR_FIRST; s <= DIR_LAST; s++) {
    const sec = disk.readSector(s);
    if (sec === null) return entries.length > 0 ? entries : null;
    for (let at = 0; at + ENTRY_SIZE <= sec.length; at += ENTRY_SIZE, index++) {
      const flag = sec[at];
      // In use: bit 6 set, bit 7 (deleted) clear. Bit 4 marks a MyDOS
      // sub-directory and bit 0 a file still open for output.
      if ((flag & 0xc0) !== 0x40 || (flag & 0x11) !== 0) continue;
      const sectors = sec[at + 1] | (sec[at + 2] << 8);
      const start = sec[at + 3] | (sec[at + 4] << 8);
      if (sectors < 1 || start < 1 || start > disk.sectorCount) continue;
      let ok = sec[at + 5] > 0x20; // the name starts with a visible character
      for (let i = 5; i < 16 && ok; i++) ok = printable(sec[at + i]);
      if (!ok) continue;
      const text = String.fromCharCode(...sec.subarray(at + 5, at + 16));
      entries.push({
        index, name: text.slice(0, 8).trimEnd(), ext: text.slice(8).trimEnd(), sectors, start,
      });
    }
  }
  return entries.length > 0 ? entries : null;
}

/** The bytes of a DOS 2 file: follow the sector chain from its first sector.
 *  The last three bytes of each sector carry the file number (top six bits of
 *  the first), the next sector (its low two bits, then the second byte; 0 =
 *  end of file) and the count of data bytes in this sector (the third). */
export function readDosFile(disk: AtariDisk, entry: DirEntry): Uint8Array | null {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let sector = entry.start;
  for (let hops = 0; sector !== 0; hops++) {
    if (hops > disk.sectorCount) return null; // a loop
    const data = disk.readSector(sector);
    if (data === null || data.length < 4) return null;
    const n = data.length;
    const count = data[n - 1];
    if (count > n - 3) return null;
    chunks.push(data.subarray(0, count));
    total += count;
    sector = ((data[n - 3] & 0x03) << 8) | data[n - 2];
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

const BINARY_EXTS = new Set(['EXE', 'COM', 'OBJ', 'XEX', 'BIN']);
const DOS_FILES = new Set(['DOS.SYS', 'DUP.SYS']);
const PREFERRED_NAMES = ['AUTORUN', 'MENU', 'START', 'LOADER', 'GAME', 'MAIN'];

const fullName = (e: DirEntry) => (e.ext ? `${e.name}.${e.ext}` : e.name);

/** The entry that is clearly the main program among several: a conventional
 *  name, else the one that shares the disk's name. */
function primary(entries: DirEntry[], diskName: string): DirEntry | null {
  if (entries.length === 1) return entries[0];
  // "Kong (1983)(Atari)[a].atr" -> KONG
  const base = diskName.replace(/\.[^.]*$/, '').split(/[([]/)[0].replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  for (const want of [...PREFERRED_NAMES, base]) {
    if (!want) continue;
    const hit = entries.find(e => e.name === want || e.name === want.slice(0, 8));
    if (hit) return hit;
  }
  return null;
}

/**
 * Whether file bytes are a tokenised BASIC program as `SAVE` writes it: a
 * 14-byte header of seven little-endian words (LOMEM, which is 0 in the file,
 * then the offsets of the variable name table, its end, the variable value
 * table, the statement table, the current statement and the array area,
 * which never fall) followed by the memory from the name table on, at least
 * as far as the array area (a program with arrays or strings saves more). A
 * program with no `.BAS` extension is often one of these.
 */
export function isBasicProgram(bytes: Uint8Array): boolean {
  if (bytes.length < 14) return false;
  const w = (i: number) => bytes[2 * i] | (bytes[2 * i + 1] << 8);
  if (w(0) !== 0) return false;
  for (let i = 2; i < 7; i++) if (w(i) < w(i - 1)) return false;
  return w(6) > w(1) && bytes.length >= w(6) - w(1) + 14;
}

const SYSTEM_FILES = new Set(['DOS.SYS', 'DUP.SYS', 'AUTORUN.SYS']);

/** A file name tagged (TOSEC style) as needing BASIC: `[BASIC]`, or
 *  `[bas2boot]` for a BASIC program turned into a boot disk. Nothing on a
 *  disk without a directory says so; the name is the only hint. */
const BASIC_TAG = /\[(BASIC|bas2boot)\]/i;

export function planForDisk(disk: AtariDisk, diskName = ''): DiskPlan {
  const files = readDirectory(disk);
  // A custom boot disk.
  if (files === null) return { kind: 'boot', basic: BASIC_TAG.test(diskName) };

  // BASIC programs: a `.BAS` file, or a file without a known binary/system
  // extension, whose contents are a SAVEd program. (Looking inside keeps out
  // the placeholder entries some cracked disks carry, and data files that
  // happen to start with zeros.)
  const bas = files.filter(e => {
    if (e.ext !== 'BAS' && (SYSTEM_FILES.has(fullName(e)) || BINARY_EXTS.has(e.ext))) return false;
    const first = disk.readSector(e.start);
    if (first === null || first[0] !== 0 || first[1] !== 0 || first[first.length - 1] < 14) return false;
    const bytes = readDosFile(disk, e);
    return bytes !== null && isBasicProgram(bytes);
  });
  if (files.some(e => e.name === 'AUTORUN' && e.ext === 'SYS')) {
    return { kind: 'boot', basic: bas.length > 0 };
  }
  if (bas.length > 0) {
    const pick = primary(bas, diskName) ?? bas[0];
    const file = fullName(pick);
    // A name with a character the keyboard cannot type: boot and leave it.
    if (keyEventsFor(`RUN "D:${file}"
`) === null) return { kind: 'boot', basic: true };
    return { kind: 'run-basic', file };
  }

  // Machine-code programs, loaded the way a user would: boot DOS, then `L`
  // from DUP's menu, so the program finds DOS (and its D: files) in place.
  // Only on a disk that really is DOS-booted, with DUP to give the menu:
  // without a readable DOS.SYS the boot sectors are the program's own loader
  // (or the directory is a placeholder, as cracked disks carry), and without
  // DUP.SYS the DOS is one that starts things itself (or has no menu), so
  // the disk's own boot is the faithful way to run it.
  const readable = (name: string) => {
    const e = files.find(f => fullName(f) === name);
    return e !== undefined && readDosFile(disk, e) !== null;
  };
  if (!readable('DOS.SYS') || !readable('DUP.SYS')) return { kind: 'boot', basic: false };
  const programs = files.filter(entry => {
    if (!BINARY_EXTS.has(entry.ext) || DOS_FILES.has(fullName(entry))) return false;
    const bytes = readDosFile(disk, entry);
    return bytes !== null && parseXex(bytes) !== null;
  });
  const chosen = programs.length > 0 ? primary(programs, diskName) : null;
  if (chosen && keyEventsFor(`${fullName(chosen)}\n`) !== null) {
    return { kind: 'dup-load', file: fullName(chosen) };
  }
  return { kind: 'boot', basic: false }; // DOS's own menu
}

// ── Tape planning ───────────────────────────────────────────────────────────

/** Decide how to start a cassette from its first record. The record's
 *  frame is $55 $55, a control byte, then 128 data bytes; a boot tape's
 *  first data bytes are the boot header (a flags byte the OS ignores and
 *  tapes fill with anything: 0, 1, $20 ..., then the record count and load
 *  address); a CSAVEd program's are zero (flags, count) and a LISTed one's is
 *  the first digit of a line number, followed by more text. */
export function planForTape(image: AtariCasImage): TapePlan {
  const first = image.records[0]?.data;
  if (!first || first.length < 9 || first[0] !== 0x55 || first[1] !== 0x55) return { kind: 'none' };
  const flags = first[3];
  const count = first[4];
  const loadAddress = first[5] | (first[6] << 8);
  const chained = atariCasFiles(image.records).length > 1;
  if (flags === 0 && count === 0) return { kind: 'basic', via: 'CLOAD', ...(chained ? { chained } : {}) };
  // A listing: a digit, then more text (a boot header's count and address
  // bytes are not all printable).
  const text = first.subarray(4, 9).every(b => (b >= 0x20 && b < 0x7f) || b === 0x9b);
  if (flags >= 0x30 && flags <= 0x39 && text) {
    return { kind: 'basic', via: 'ENTER', ...(chained ? { chained } : {}) };
  }
  // $FF $FF opens a DOS binary load file, which is not a boot header.
  if (flags === 0xff && count === 0xff) return { kind: 'none' };
  if (count >= 1 && loadAddress >= 0x0100 && loadAddress < 0xc000) return { kind: 'boot' };
  return { kind: 'none' };
}

// ── Compiled steps and the runner ───────────────────────────────────────────

export type AutostartStep =
  | { readonly op: 'down'; readonly key: HostKeyEvent }
  | { readonly op: 'up'; readonly key: HostKeyEvent }
  | { readonly op: 'release' }
  | { readonly op: 'reset'; readonly basic: boolean }
  | { readonly op: 'wait'; readonly frames: number }
  | { readonly op: 'beep'; readonly max: number; readonly optional?: boolean }
  | { readonly op: 'ready'; readonly max: number }
  | { readonly op: 'prompt'; readonly text: string; readonly max: number; readonly optional?: boolean };

/** Frames a key is held and then released, per typed character. */
const KEY_HOLD = 3;
const KEY_GAP = 3;
/** Frames OPTION is held through an XL's boot to keep BASIC out. */
const OPTION_HOLD = 120;

export interface AutostartCaps {
  /** BASIC is in the machine (600XL/800XL): off means holding OPTION. */
  readonly builtinBasic: boolean;
}

function pressSteps(key: HostKeyEvent, out: AutostartStep[]): void {
  out.push({ op: 'down', key }, { op: 'wait', frames: KEY_HOLD }, { op: 'up', key }, { op: 'wait', frames: KEY_GAP });
}

/** Expand ops into the steps the runner executes on a given machine. Text
 *  that cannot be typed makes the whole script null. */
export function compileAutostart(ops: readonly AutostartOp[], caps: AutostartCaps): AutostartStep[] | null {
  const out: AutostartStep[] = [];
  for (const o of ops) {
    switch (o.op) {
      case 'boot': {
        const option = caps.builtinBasic && !o.basic;
        if (option) out.push({ op: 'down', key: KEY_OPTION });
        if (o.holdStart) out.push({ op: 'down', key: KEY_START });
        out.push({ op: 'reset', basic: o.basic });
        if (option && !o.holdStart) {
          out.push({ op: 'wait', frames: OPTION_HOLD }, { op: 'release' });
        }
        break;
      }
      case 'type': {
        const events = keyEventsFor(o.text);
        if (events === null) return null;
        for (const ev of events) pressSteps(ev, out);
        break;
      }
      case 'press': pressSteps(o.key, out); break;
      case 'wait': case 'beep': case 'ready': case 'prompt': case 'release': out.push(o); break;
    }
  }
  return out;
}

/** What the runner needs from the machine. */
export interface AutostartHost {
  keyDown(e: HostKeyEvent): void;
  keyUp(e: HostKeyEvent): void;
  /** Power-cycle the machine, with BASIC switched on or off. */
  coldStart(basic: boolean): void;
  /** Speaker toggles during the last frame (non-zero = a beep or click). */
  speakerToggles(): number;
  /** The text on screen, lines joined by `\n`. */
  screenText(): string;
  notify(message: string): void;
}

/** True when the last non-empty line of the screen is BASIC's prompt:
 *  Atari BASIC's `READY`, or Altirra BASIC's `Ready`. */
export function screenIsReady(text: string): boolean {
  let end = text.length;
  while (end > 0 && (text.charCodeAt(end - 1) <= 0x20)) end--;
  if (end === 0) return false;
  let start = text.lastIndexOf('\n', end - 1) + 1;
  while (start < end && text.charCodeAt(start) <= 0x20) start++;
  return end - start === 5 && text.slice(start, end).toUpperCase() === 'READY';
}

/** True when `want` is on screen, ignoring case and line breaks. */
export function screenShows(text: string, want: string): boolean {
  return text.replace(/\s+/g, ' ').toUpperCase().includes(want.toUpperCase());
}

const READY_POLL = 10;

export class AtariAutostart {
  /** The script has run out, been abandoned or been cancelled. */
  finished = false;
  private pc = 0;
  /** Frames spent in the blocking step now at `pc`. */
  private waited = 0;
  private readonly held: HostKeyEvent[] = [];

  constructor(
    private readonly host: AutostartHost,
    private readonly steps: readonly AutostartStep[],
  ) {}

  /** Run the opening steps (up to the first wait). */
  start(): void { this.advance(); }

  /** Called once per emulated frame, after the frame has run. */
  frame(): void {
    if (this.finished) return;
    const step = this.steps[this.pc];
    this.waited++;
    switch (step.op) {
      case 'wait':
        if (this.waited >= step.frames) this.next();
        break;
      case 'beep':
        if (this.host.speakerToggles() > 0) this.next();
        else if (this.waited >= step.max) {
          if (step.optional) this.finish();
          else this.abandon('the OS never beeped');
        }
        break;
      case 'ready':
        if (this.waited % READY_POLL === 0 && screenIsReady(this.host.screenText())) this.next();
        else if (this.waited >= step.max) this.abandon('BASIC never reached READY');
        break;
      case 'prompt':
        if (this.waited % READY_POLL === 0 && screenShows(this.host.screenText(), step.text)) this.next();
        else if (this.waited >= step.max) {
          if (step.optional) this.finish();
          else this.abandon(`"${step.text}" never appeared`);
        }
        break;
      default: break; // instant steps never block
    }
  }

  /** Stop, letting go of any key the script holds. */
  cancel(): void {
    if (this.finished) return;
    this.finished = true;
    this.releaseHeld();
  }

  private next(): void {
    this.pc++;
    this.waited = 0;
    this.advance();
  }

  private abandon(why: string): void {
    this.finish();
    this.host.notify(`Auto-start gave up: ${why}`);
  }

  private finish(): void {
    this.finished = true;
    this.releaseHeld();
  }

  /** Execute instant steps until one has to wait. */
  private advance(): void {
    while (!this.finished && this.pc < this.steps.length) {
      const step = this.steps[this.pc];
      switch (step.op) {
        case 'down':
          this.held.push(step.key);
          this.host.keyDown(step.key);
          break;
        case 'up': {
          const i = this.held.indexOf(step.key);
          if (i >= 0) this.held.splice(i, 1);
          this.host.keyUp(step.key);
          break;
        }
        case 'release': this.releaseHeld(); break;
        case 'reset': this.host.coldStart(step.basic); break;
        case 'wait':
          if (step.frames > 0) return;
          break;
        case 'beep': case 'ready': case 'prompt': return;
      }
      this.pc++;
    }
    if (this.pc >= this.steps.length) this.finish();
  }

  private releaseHeld(): void {
    while (this.held.length > 0) this.host.keyUp(this.held.pop()!);
  }
}
