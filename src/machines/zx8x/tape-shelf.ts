/**
 * The ZX81's cassette, modelled as the programs the user has mounted.
 *
 * A .p image is exactly what the ROM's SAVE writes after the name: RAM from
 * VERSN ($4009) up to, not including, E_LINE. Rather than synthesise the
 * waveform, the machine traps the ROM's LOAD and SAVE command routines and
 * moves those bytes directly (see Zx8xMachine.serviceTapeTrap).
 *
 * Programs sit on the shelf in mount order with a play position, like
 * programs one after another on a tape: LOAD "" takes the next one, and
 * LOAD "NAME" winds forward (wrapping once) to the first whose name matches.
 */

export interface Zx81Program {
  readonly name: string;
  readonly data: Uint8Array;
}

/** ZX81 character codes 0x00-0x3F; '"' is the quote glyph, '£' the pound. */
const ZX81_CHARSET = ' ??????????"£$:?()><=+-*/;,.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Decode a ZX81-coded name (inverse bit ignored) to upper-case ASCII. */
export function zx81NameToAscii(codes: ArrayLike<number>): string {
  let out = '';
  for (let i = 0; i < codes.length; i++) out += ZX81_CHARSET[codes[i] & 0x3f];
  return out;
}

/** Normalise a host filename or tape name for comparison: drop any extension
 *  and directory, upper-case, and trim surrounding spaces. */
export function programNameFromFilename(filename: string): string {
  const base = filename.replace(/^.*[\\/]/, '').replace(/\.(p|81|p81)$/i, '');
  return base.toUpperCase().trim();
}

export class Zx81TapeShelf {
  private readonly programs: Zx81Program[] = [];
  private position = 0;
  /** A program the user mounted while LOAD was already waiting — delivered to
   *  that LOAD whatever it asked for, as if they had pressed PLAY on it. */
  private cued: Zx81Program | null = null;

  get size(): number { return this.programs.length; }
  list(): readonly Zx81Program[] { return this.programs; }

  /** Put a program on the tape. `played` marks it as already read (it was
   *  auto-loaded on mount), so the next LOAD "" moves on to what follows. */
  insert(name: string, data: Uint8Array, played: boolean): void {
    this.programs.push({ name, data });
    if (played) this.position = this.programs.length;
  }

  /** Mount a program for a LOAD that is already waiting. */
  cue(name: string, data: Uint8Array): void {
    this.insert(name, data, false);
    this.cued = this.programs[this.programs.length - 1];
  }

  /** Record a SAVE: a later LOAD of the same name finds it. */
  record(name: string, data: Uint8Array): void {
    this.insert(name, data, true);
  }

  /** The program a LOAD with this name (null for LOAD "") would read. */
  take(name: string | null): Zx81Program | null {
    if (this.cued) {
      const cued = this.cued;
      this.cued = null;
      this.position = this.programs.indexOf(cued) + 1;
      return cued;
    }
    const count = this.programs.length;
    if (name === null) {
      if (this.position >= count) return null;
      return this.programs[this.position++];
    }
    const wanted = name.toUpperCase().trim();
    for (let i = 0; i < count; i++) {
      const index = (this.position + i) % count;
      if (this.programs[index].name === wanted) {
        this.position = index + 1;
        return this.programs[index];
      }
    }
    return null;
  }
}
