/**
 * PcwPrinterLog — what the BIOS sends the PCW's printer controller.
 *
 * Neither printer is emulated (the status ports report an idle, ready printer;
 * see `pcw-io.ts`). Instead every byte written to the controller's ports is
 * kept, so the Save menu can hand it back as a readable listing.
 *
 * The listing cannot simply be the text that was printed, because that is not
 * what crosses these ports. The dot-matrix PCWs build every character out of
 * pin columns on the CPU side, from the BIOS's own printer fonts, and send the
 * controller head movements and 9-pin column bitmaps; the 9512 sends daisywheel
 * petal numbers, whose characters depend on the wheel fitted. So the listing
 * decodes the command stream, and draws each dot-matrix pass as a 9-row picture
 * of the pins it fired, which is where the printed text shows up.
 *
 * Command formats are John Elliott's PCW hardware guide, §6.1.2 (dot matrix)
 * and §6.2 (PCW9512 daisywheel). Where the guide marks a meaning as a guess, the
 * listing says "unknown" rather than inventing one.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';

/** One logged write: which port it went to. */
const enum PrinterPort {
  /** &FC, or the 9512's &00FC data byte. */
  Data = 0,
  /** &FD: dot-matrix commands. */
  Command = 1,
  /** The 9512's &01FC command byte (A8 set). */
  DaisyCommand = 2,
  /** Not a write: the machine was reset here, so a command in progress ended. */
  Reset = 3,
}

/** Log capacity in writes. A page of NLQ graphics is a few tens of KB. */
const MAX_ENTRIES = 1 << 21;

/** Ticks per character cell in the pin pictures (one draft column is 6-12). */
const TICKS_PER_CELL = 6;

export class PcwPrinterLog {
  private ports = new Uint8Array(4096);
  private values = new Uint8Array(4096);
  private count = 0;
  /** Writes dropped once the log was full. */
  private dropped = 0;

  /** Writes logged so far (excluding reset marks). */
  get length(): number { return this.count; }

  /** Log one OUT to &FC/&FD (`port` is the full 16-bit port). */
  write(port: number, value: number): void {
    const low = port & 0xFF;
    const kind = low === 0xFD ? PrinterPort.Command
      : (port & 0x0100) !== 0 ? PrinterPort.DaisyCommand : PrinterPort.Data;
    this.push(kind, value & 0xFF);
  }

  /** The machine was reset: whatever command was half-sent is over. */
  markReset(): void {
    if (this.count > 0 && this.ports[this.count - 1] !== PrinterPort.Reset) this.push(PrinterPort.Reset, 0);
  }

  private push(kind: PrinterPort, value: number): void {
    if (this.count >= MAX_ENTRIES) { this.dropped++; return; }
    if (this.count === this.ports.length) {
      const grow = (a: Uint8Array) => { const b = new Uint8Array(a.length * 2); b.set(a); return b; };
      this.ports = grow(this.ports);
      this.values = grow(this.values);
    }
    this.ports[this.count] = kind;
    this.values[this.count] = value;
    this.count++;
  }

  /** Empty the log (a state that carries none). */
  clear(): void {
    this.count = 0;
    this.dropped = 0;
  }

  /** Snapshot: the log exactly as it stands, so a resumed machine's printer
   *  output carries on where the saved one's left off. */
  saveState(w: StateWriter): void {
    w.u32(this.count);
    w.u32(this.dropped);
    w.raw(this.ports.subarray(0, this.count));
    w.raw(this.values.subarray(0, this.count));
  }

  loadState(r: StateReader): void {
    const count = r.u32();
    const dropped = r.u32();
    if (count > MAX_ENTRIES) throw new Error('Snapshot is corrupt');
    let size = 4096;
    while (size < count) size *= 2;
    this.ports = new Uint8Array(size);
    this.values = new Uint8Array(size);
    r.rawInto(this.ports.subarray(0, count));
    r.rawInto(this.values.subarray(0, count));
    this.count = count;
    this.dropped = dropped;
  }

  /** True when nothing but resets has been logged. */
  get empty(): boolean {
    for (let i = 0; i < this.count; i++) if (this.ports[i] !== PrinterPort.Reset) return false;
    return true;
  }

  /** The decoded listing, for the dot-matrix controller or the 9512's daisywheel. */
  text(printer: 'matrix' | 'daisywheel'): string {
    const out: string[] = [];
    const writes = this.count - this.marks();
    out.push(printer === 'matrix'
      ? `Amstrad PCW dot-matrix printer controller (ports &FC/&FD): ${writes} bytes sent`
      : `Amstrad PCW9512 daisywheel printer controller (ports &00FC/&01FC/&FD): ${writes} bytes sent`);
    out.push('Decoded per John Elliott\'s PCW hardware guide, section '
      + (printer === 'matrix' ? '6.1.2.' : '6.2.'));
    if (this.dropped > 0) out.push(`The log filled up; ${this.dropped} later bytes are missing.`);
    out.push('');
    if (printer === 'matrix') this.decodeMatrix(out);
    else this.decodeDaisywheel(out);
    return out.join('\n') + '\n';
  }

  private marks(): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.ports[i] === PrinterPort.Reset) n++;
    return n;
  }

  // ── Dot matrix ─────────────────────────────────────────────────────────────

  private decodeMatrix(out: string[]): void {
    let mode: 'cmd' | 'print' | 'feed' = 'cmd';
    let first = -1;                 // first byte of a pair, or -1
    let firstPort = PrinterPort.Data;
    let pass: MatrixPass | null = null;
    let feed = 0;
    let feedPair = '';

    for (let i = 0; i < this.count; i++) {
      const port = this.ports[i] as PrinterPort;
      if (port === PrinterPort.Reset) {
        if (pass) out.push(...pass.render(), '  (machine reset before the end of the line)');
        out.push('--- machine reset ---');
        mode = 'cmd'; first = -1; pass = null;
        continue;
      }
      if (first < 0) { first = this.values[i]; firstPort = port; continue; }
      const a = first;
      const b = this.values[i];
      first = -1;
      const word = (a << 8) | b;
      const where = firstPort === PrinterPort.Data ? '&FC' : '&FD';

      // A new command word (A0-BF: moves, line feeds, passes, reset) cannot be
      // a print or head-move word, so it ends a pass or feed that was never
      // given its C0 00 — as the initialisation's A9 C0 is not.
      if (mode !== 'cmd' && a >= 0xA0 && a < 0xC0) {
        if (pass) out.push(...pass.render(), '  (ended by the next command, with no C0 00)');
        else out.push(`${feedPair}  line feed ${feed}/360" (ended by the next command)`);
        pass = null;
        mode = 'cmd';
      }

      if (mode === 'print' && pass) {
        if (word === 0xC000) {
          out.push(...pass.render());
          pass = null;
          mode = 'cmd';
        } else if ((word & 0xF000) === 0) {
          pass.column(((word >> 9) & 7) + 5, word & 0x1FF);
        } else if ((word & 0xE000) === 0x8000) {
          pass.move(moveTicks(word));
        } else {
          pass.unknown++;
        }
        continue;
      }
      if (mode === 'feed') {
        if (word === 0xC000) {
          out.push(`${feedPair}  line feed ${feed}/360"`);
          mode = 'cmd';
        } else if ((word & 0xE000) === 0x8000) {
          feed += moveTicks(word);
        }
        continue;
      }

      const pair = `${where} ${hex(a)} ${hex(b)}`;
      if (a === 0x00 && b === 0x00) out.push(`${pair}  initialise (self-test?)`);
      else if (a === 0xA1) out.push(`${pair}  move head ${b * 12} ticks`);
      else if (a === 0xA4) out.push(`${pair}  line feed ${b}/360"`);
      else if (a >= 0xA8 && a <= 0xAB) {
        pass = new MatrixPass(pair, (a & 1) !== 0, (a & 2) !== 0, b);
        mode = 'print';
      } else if (a === 0xAC) {
        feed = b === 0 ? 256 : b;
        feedPair = pair;
        mode = 'feed';
      } else if (a === 0xB8 && b === 0x00) out.push(`${pair}  reset: head to the left margin`);
      else if (a === 0xC0 && b === 0x00) out.push(`${pair}  end of command`);
      else out.push(`${pair}  unknown command`);
    }
    if (pass) out.push(...pass.render(), '  (line not finished)');
    if (first >= 0) out.push(`${hex(first)}  (half a command)`);
  }

  // ── PCW9512 daisywheel ─────────────────────────────────────────────────────

  private decodeDaisywheel(out: string[]): void {
    let command = -1;
    const par: number[] = [];
    for (let i = 0; i < this.count; i++) {
      const port = this.ports[i] as PrinterPort;
      const v = this.values[i];
      if (port === PrinterPort.Reset) { out.push('--- machine reset ---'); command = -1; continue; }
      if (port === PrinterPort.DaisyCommand) {
        if (command >= 0) out.push(`&01FC ${hex(command)}  (no data byte followed)`);
        command = v;
        continue;
      }
      if (port === PrinterPort.Command) { out.push(`&FD ${hex(v)}  (not part of the 9512 protocol)`); continue; }
      if (command < 0) { out.push(`&00FC ${hex(v)}  (data with no command)`); continue; }
      const word = (command << 8) | v;
      out.push(`${hex(command)} ${hex(v)}  ${daisyCommand(word)}`);
      if (command === 0x04) par.push(v);
      command = -1;
    }
    if (command >= 0) out.push(`&01FC ${hex(command)}  (no data byte followed)`);
    if (par.length > 0) {
      out.push('', `Bytes written to the PAR (Centronics) port: ${par.length}`, '');
      out.push(String.fromCharCode(...par.map(c => (c === 0x0A || c === 0x0D || c === 0x09 || (c >= 0x20 && c < 0x7F) ? c : 0x2E))));
    }
  }
}

/** A head move: 13 bits, with "if the low 8 bits are 0, add 256". */
function moveTicks(word: number): number {
  let n = word & 0x1FFF;
  if ((n & 0xFF) === 0) n += 256;
  return n;
}

function daisyCommand(word: number): string {
  const top = word >> 12;
  const param = word & 0x0FFF;
  if (top === 0) {
    const sub = (word >> 8) & 0x0F;
    const v = word & 0xFF;
    switch (sub) {
      case 0x1: return `prepare to output a character (ribbon ${v === 3 ? 'single-strike' : hex(v)})`;
      case 0x2: return 'read PAR port status';
      case 0x4: return `write ${hex(v)} to the PAR port`;
      case 0x5: case 0x6: return 're-check paper sensor (unknown)';
      case 0x7: return 'enable daisywheel interrupts';
      case 0x8: return 'disable daisywheel interrupts';
      case 0x9: return 'reset interrupt flag';
      default: return 'unknown';
    }
  }
  if (word >> 8 === 0x12) return 'initialise controller';
  if (top >= 4 && top <= 7) {
    return `print petal ${word & 0xFF} (impression ${(word >> 9) & 0x0F})`;
  }
  if (top === 0x9) return `move left ${param}/120"`;
  if (top === 0xB) return `move right ${param}/120"`;
  if (top === 0xC) return `feed paper forward ${param}/192"`;
  if (top === 0xE) return `feed paper back ${param}/192"`;
  return 'unknown';
}

function hex(v: number): string {
  return v.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * One print pass (A8-AB ... C0 00): the columns fired and where, drawn as 9
 * rows of pins (bit 0 is the top pin, bit 8 the bottom). Column spacing and
 * head moves are in ticks; the picture puts one character cell per
 * TICKS_PER_CELL ticks and reads left to right whichever way the head ran.
 */
class MatrixPass {
  private x = 0;
  private readonly hits: { x: number; pins: number }[] = [];
  unknown = 0;

  constructor(
    private readonly pair: string,
    private readonly rightward: boolean,
    private readonly halfSpeed: boolean,
    private readonly leadIn: number,
  ) {}

  column(spacing: number, pins: number): void {
    if (pins !== 0) this.hits.push({ x: this.x, pins });
    this.x += this.rightward ? spacing : -spacing;
  }

  move(ticks: number): void {
    this.x += this.rightward ? ticks : -ticks;
  }

  render(): string[] {
    const lines = [
      `${this.pair}  print pass: head moving ${this.rightward ? 'right' : 'left'} at `
        + `${this.halfSpeed ? 'half' : 'full'} speed, ${this.leadIn} ticks in; `
        + `${this.hits.length} columns fired`
        + (this.unknown > 0 ? `, ${this.unknown} unknown words` : ''),
    ];
    if (this.hits.length === 0) return lines;
    let min = Infinity;
    let max = -Infinity;
    for (const h of this.hits) { min = Math.min(min, h.x); max = Math.max(max, h.x); }
    const width = Math.floor((max - min) / TICKS_PER_CELL) + 1;
    const rows = Array.from({ length: 9 }, () => new Array<string>(width).fill(' '));
    for (const h of this.hits) {
      const cell = Math.floor((h.x - min) / TICKS_PER_CELL);
      for (let pin = 0; pin < 9; pin++) if (h.pins & (1 << pin)) rows[pin][cell] = '#';
    }
    for (const row of rows) lines.push(`  |${row.join('').replace(/\s+$/, '')}`);
    return lines;
  }
}
