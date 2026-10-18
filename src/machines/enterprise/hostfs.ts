/**
 * The FILE: device — loading .com/.bas programs straight from the host.
 *
 * Enterprise software in the wild is mostly bare EXOS files (a 16-byte header
 * and the program), not tapes: they were moved between machines on disk or
 * by cable. The way to load one is to give EXOS a device that can open it.
 * This file builds a tiny EXOS extension ROM declaring a device called FILE:
 * and serves its entry points from the host: the machine traps the CPU at
 * each entry, `perform()` does the work on the Z80's registers, and the ROM's
 * own code then returns to EXOS. ep128emu and Clock Signal take the same
 * approach (EXOS was designed to be extended this way); the ROM below is our
 * own, laid out per the EXOS 2.1 technical manual's ROM-extension and device
 * descriptor chapters.
 *
 * ROM layout, executed at 0xC000 (EXOS reads the descriptor through page 1,
 * so pointers EXOS follows are 0x4000-based):
 *
 *   C000  "EXOS_ROM"                     signature
 *   C008  DW  chain (page-1 address)     pointer to the device descriptor
 *   C00A  RET                            extension entry: no commands handled
 *   C00B  descriptor: XX_NEXT, XX_RAM, DD_TYPE, DD_IRQFLAG, DD_FLAGS,
 *         DD_TAB (page-1 address + segment), DD_UNIT_COUNT, DD_NAME "FILE",
 *         then XX_SIZE — the word the chain pointer points at.
 *   ....  DD_TAB: fourteen entry addresses, functions 0-13
 *   ....  the entries; each starts with a NOP the machine traps
 */

/** EXOS error codes the device returns (EXOS 2.1 manual, appendix). */
const ERR_OK = 0x00;
const ERR_ICHAN = 0xFB;     // channel illegal or does not exist
const ERR_ISPEC = 0xEA;     // invalid special function
const ERR_EOF = 0xE4;       // end of file met in read
const ERR_PROT = 0xE3;      // protection violation (file not found / read-only)
const ERR_NOFN = 0xE7;      // function not supported

/** Device functions (EXOS device descriptor dispatch table order). */
const FN_OPEN = 1, FN_CREATE = 2, FN_CLOSE = 3, FN_DESTROY = 4;
const FN_READ_CHAR = 5, FN_READ_BLOCK = 6, FN_WRITE_CHAR = 7, FN_WRITE_BLOCK = 8;
const FN_READ_STATUS = 9, FN_SET_STATUS = 10, FN_SPECIAL = 11, FN_INIT = 12;
/** Not a device function: the open/create path drops its host channel here
 *  when EXOS refuses it a buffer. */
const FN_ABANDON = 0x80;

/** A 16-byte EXOS module header: byte 0 is zero, byte 1 the module type,
 *  and the rest is the type's own (lengths, BASIC's protection flags — and
 *  in some released files, junk). */
export const EXOS_TYPE_BASIC = 4;
export const EXOS_TYPE_PROGRAM = 5;

/** The module types IS-BASIC's LOAD/RUN take: 2-3 (multi-module files and
 *  BASIC extensions), 4 (BASIC), 5 (a program), 6-7 (system extensions). */
export function isRunnableExosType(type: number): boolean { return type >= 2 && type <= 7; }

/** The module type of an EXOS file, or -1 when it does not start with a
 *  module header. */
export function exosFileType(data: Uint8Array): number {
  if (data.length < 16 || data[0] !== 0) return -1;
  return data[1];
}

/** What the ROM traps carry: the address of each function's entry. */
export interface HostFsRom {
  readonly image: Uint8Array;
  /** Trap address (0xC000-based) → function. */
  readonly traps: ReadonlyMap<number, number>;
}

/** Assemble the FILE: device ROM. */
export function buildHostFsRom(): HostFsRom {
  const rom: number[] = [];
  const ORG = 0xC000;
  const here = (): number => ORG + rom.length;
  const db = (...bytes: number[]): void => { for (const b of bytes) rom.push(b & 0xFF); };
  const dw = (w: number): void => db(w & 0xFF, w >> 8);
  const toPage1 = (addr: number): number => 0x4000 | (addr & 0x3FFF);
  const fixups: { at: number; label: string; page1: boolean }[] = [];
  const labels = new Map<string, number>();
  const label = (name: string): void => { labels.set(name, here()); };
  const dwLabel = (name: string, page1 = false): void => { fixups.push({ at: rom.length, label: name, page1 }); dw(0); };
  const traps = new Map<number, number>();
  const trap = (fn: number): void => { traps.set(here(), fn); db(0x00); };   // NOP
  const exos = (fn: number): void => db(0xF7, fn);                            // RST 30h; DB fn

  for (const ch of 'EXOS_ROM') db(ch.charCodeAt(0));
  dwLabel('chain', true);
  db(0xC9);                                   // extension entry: RET

  dw(0x0000);                                 // XX_NEXT: no further device
  dw(0xFFFE);                                 // XX_RAM: -(0 bytes + 2)
  label('type');
  db(0x00, 0x00, 0x00);                       // DD_TYPE, DD_IRQFLAG, DD_FLAGS
  dwLabel('table', true);                     // DD_TAB
  db(0x00);                                   // DD_TAB_SEG (EXOS fills it in)
  db(0x00);                                   // DD_UNIT_COUNT
  label('name');
  db(4); for (const ch of 'FILE') db(ch.charCodeAt(0));
  label('chain');
  fixups.push({ at: rom.length, label: 'size', page1: false });
  dw(0);                                      // XX_SIZE, patched below

  label('table');
  for (let fn = 0; fn < 14; fn++) dwLabel(`fn${fn}`);

  // 0: interrupt (none requested) and 13: buffer moved (no buffer held).
  label('fn0'); label('fn13'); db(0xC9);

  // 1/2: open/create. The host opens the file and leaves the channel in B;
  // EXOS then has to be asked for the channel's buffer (EXOS 27), and if it
  // refuses, the host forgets the channel again.
  label('fn1'); trap(FN_OPEN); db(0xB7, 0xC0);          // OR A; RET NZ
  db(0x18); const jrAt = rom.length; db(0);             // JR alloc
  label('fn2'); trap(FN_CREATE); db(0xB7, 0xC0);        // OR A; RET NZ
  label('alloc');
  rom[jrAt] = (labels.get('alloc')! - (ORG + jrAt + 1)) & 0xFF;
  db(0xC5);                                   // PUSH BC
  db(0x78);                                   // LD A,B
  db(0x01, 0x00, 0x00);                       // LD BC,0
  db(0x11, 0x01, 0x00);                       // LD DE,1
  exos(27);                                   // allocate channel buffer
  db(0xC1);                                   // POP BC
  db(0xB7, 0xC8);                             // OR A; RET Z
  db(0xF5);                                   // PUSH AF
  db(0x78);                                   // LD A,B
  trap(FN_ABANDON);
  db(0xF1, 0xC9);                             // POP AF; RET

  for (const fn of [FN_CLOSE, FN_DESTROY, FN_READ_CHAR, FN_READ_BLOCK, FN_WRITE_CHAR,
    FN_WRITE_BLOCK, FN_READ_STATUS, FN_SET_STATUS, FN_SPECIAL]) {
    label(`fn${fn}`); trap(fn); db(0xC9);
  }

  // 12: initialise. Forget every channel, then make FILE: the default
  // filing device (EXOS 19, C=1), as a disk ROM does for DISK:.
  label('fn12'); trap(FN_INIT);
  db(0x11); dwLabel('name');                  // LD DE,name
  db(0x0E, 0x01);                             // LD C,1
  exos(19);
  db(0xC9);

  labels.set('size', labels.get('chain')! - labels.get('type')!);
  for (const f of fixups) {
    let v = labels.get(f.label)!;
    if (f.label !== 'size' && f.page1) v = toPage1(v);
    rom[f.at] = v & 0xFF;
    rom[f.at + 1] = (v >> 8) & 0xFF;
  }
  return { image: Uint8Array.from(rom), traps };
}

/** The Z80 registers a FILE: call reads and returns. */
export interface HostFsRegs {
  a: number; b: number; c: number; d: number; e: number;
}

/** Memory as the trap sees it: the live mapping, and the caller's ("user")
 *  mapping that EXOS saved for the duration of the call. */
export interface HostFsMemory {
  read(addr: number): number;
  userRead(addr: number): number;
  userWrite(addr: number, value: number): void;
}

interface Channel {
  name: string;
  data: Uint8Array;
  pos: number;
  writable: boolean;
  /** Bytes written so far (a created file). */
  out: number[] | null;
}

/** A set of host files the FILE: device serves. */
export class HostFileBundle {
  private readonly files = new Map<string, { name: string; data: Uint8Array }>();
  /** The file an empty name opens: the program the user loaded. */
  keyFile = '';

  add(name: string, data: Uint8Array): void {
    const base = name.replace(/^.*[\\/]/, '');
    this.files.set(base.toUpperCase(), { name: base, data });
  }

  get size(): number { return this.files.size; }
  get names(): string[] { return [...this.files.values()].map(f => f.name); }
  /** Every file, as added. */
  get entries(): { name: string; data: Uint8Array }[] { return [...this.files.values()]; }

  /**
   * Find a file the way a user would expect from a name typed on an
   * Enterprise: case-blind, with or without its extension, and with any
   * directory part or drive dropped.
   */
  find(requested: string): { name: string; data: Uint8Array } | null {
    let want = requested.trim().replace(/^.*[\\/:]/, '').toUpperCase();
    if (want === '') want = this.keyFile.toUpperCase();
    const exact = this.files.get(want);
    if (exact) return exact;
    if (!want.includes('.')) {
      for (const ext of ['.COM', '.BAS', '.PRG', '.EXE', '.BIN']) {
        const hit = this.files.get(want + ext);
        if (hit) return hit;
      }
      for (const [key, file] of this.files) {
        if (key.replace(/\.[^.]*$/, '') === want) return file;
      }
    }
    return null;
  }

  set(name: string, data: Uint8Array): void { this.add(name, data); }
  remove(name: string): boolean { return this.files.delete(name.toUpperCase()); }
}

/** Serves FILE: device calls from a `HostFileBundle`. */
export class HostFsHandler {
  bundle: HostFileBundle | null = null;
  private readonly channels = new Map<number, Channel>();
  /** Calls served since the last reset, for the activity LED. */
  accesses = 0;
  /** Names asked for that the bundle does not have, for diagnosis. */
  readonly missing: string[] = [];

  reset(): void { this.channels.clear(); }

  /** Read the length-prefixed name EXOS passes in DE. */
  private readName(mem: HostFsMemory, de: number): string {
    const len = mem.read(de);
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(mem.read((de + 1 + i) & 0xFFFF));
    return s;
  }

  perform(fn: number, r: HostFsRegs, mem: HostFsMemory): void {
    this.accesses++;
    const de = (r.d << 8) | r.e;
    const setBC = (v: number): void => { r.b = (v >> 8) & 0xFF; r.c = v & 0xFF; };
    const setDE = (v: number): void => { r.d = (v >> 8) & 0xFF; r.e = v & 0xFF; };
    switch (fn) {
      case FN_INIT:
        this.channels.clear();
        r.a = ERR_OK;
        return;
      case FN_ABANDON:
        this.channels.delete(r.a);
        return;
      case FN_OPEN: {
        const ch = r.a;
        r.b = ch;
        const name = this.readName(mem, de);
        const file = this.bundle?.find(name) ?? null;
        if (!file) {
          this.missing.push(name);
          r.a = ERR_PROT;
          return;
        }
        this.channels.set(ch, { name: file.name, data: file.data, pos: 0, writable: false, out: null });
        r.a = ERR_OK;
        return;
      }
      case FN_CREATE: {
        const ch = r.a;
        r.b = ch;
        if (!this.bundle) { r.a = ERR_PROT; return; }
        const name = this.readName(mem, de).replace(/^.*[\\/:]/, '') || 'NONAME';
        this.channels.set(ch, { name, data: new Uint8Array(0), pos: 0, writable: true, out: [] });
        r.a = ERR_OK;
        return;
      }
      case FN_SPECIAL:
        r.a = ERR_ISPEC;
        return;
    }

    const chan = this.channels.get(r.a);
    if (!chan) { r.a = ERR_ICHAN; return; }
    switch (fn) {
      case FN_CLOSE:
        if (chan.out && this.bundle) this.bundle.set(chan.name, Uint8Array.from(chan.out));
        this.channels.delete(r.a);
        r.a = ERR_OK;
        return;
      case FN_DESTROY:
        this.channels.delete(r.a);
        this.bundle?.remove(chan.name);
        r.a = ERR_OK;
        return;
      case FN_READ_CHAR:
        if (chan.pos >= chan.data.length) { r.a = ERR_EOF; return; }
        r.b = chan.data[chan.pos++];
        r.a = ERR_OK;
        return;
      case FN_READ_BLOCK: {
        let bc = (r.b << 8) | r.c;
        let addr = de;
        r.a = ERR_OK;
        while (bc > 0) {
          if (chan.pos >= chan.data.length) { r.a = ERR_EOF; break; }
          mem.userWrite(addr, chan.data[chan.pos++]);
          addr = (addr + 1) & 0xFFFF;
          bc--;
        }
        setBC(bc);
        setDE(addr);
        return;
      }
      case FN_WRITE_CHAR:
        if (!chan.out) { r.a = ERR_PROT; return; }
        chan.out.push(r.b);
        r.a = ERR_OK;
        return;
      case FN_WRITE_BLOCK: {
        if (!chan.out) { r.a = ERR_PROT; return; }
        let bc = (r.b << 8) | r.c;
        let addr = de;
        while (bc > 0) {
          chan.out.push(mem.userRead(addr));
          addr = (addr + 1) & 0xFFFF;
          bc--;
        }
        setBC(0);
        setDE(addr);
        r.a = ERR_OK;
        return;
      }
      case FN_READ_STATUS:
        // C: 0 = a character is ready, 0xFF = end of file.
        r.c = chan.out || chan.pos < chan.data.length ? 0x00 : 0xFF;
        r.a = ERR_OK;
        return;
      case FN_SET_STATUS: {
        // C bit 0: move the file pointer to the 32-bit value at DE. The
        // reply fills in the pointer and length and says both are valid.
        if (r.c & 0x04) { r.a = ERR_NOFN; return; }
        const length = chan.out ? chan.out.length : chan.data.length;
        if (r.c & 0x01) {
          const p = mem.userRead(de) | (mem.userRead((de + 1) & 0xFFFF) << 8)
            | (mem.userRead((de + 2) & 0xFFFF) << 16) | (mem.userRead((de + 3) & 0xFFFF) << 24);
          if (p > length) { r.a = ERR_EOF; return; }
          chan.pos = p;
        }
        const put = (at: number, v: number): void => {
          for (let i = 0; i < 4; i++) mem.userWrite((de + at + i) & 0xFFFF, (v >>> (i * 8)) & 0xFF);
        };
        put(0, chan.pos);
        put(4, length);
        r.c = 0x03;
        r.a = ERR_OK;
        return;
      }
    }
    r.a = ERR_NOFN;
  }
}
