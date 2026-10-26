/**
 * "TR-DOS" entry for the Pentagon's 128K menu.
 *
 * The Pentagons ship with a Sinclair 128K ROM pair, whose menu ends in a
 * "Tape Tester" entry that no Pentagon software wants; a real Pentagon ROM
 * replaces it with "TR-DOS". zx84 hosts only the Sinclair pair, so it makes that
 * change when the ROM is loaded rather than hosting a patched image: the entry
 * enters TR-DOS exactly as typing RANDOMIZE USR 15616 would.
 *
 * The routine is zx84's own, laid out after the Tape Loader's tail at 0x1AF1:
 * put a tokenised line in the edit line and fall into the interpreter. The line
 * is RANDOMIZE USR VAL "15616". VAL is there because that entry point runs the
 * line without the syntax pass that would embed a number's binary form, so a
 * bare 15616 would not evaluate.
 *
 * Nothing is changed unless page 0 is the stock Sinclair 128K ROM 0: a Pentagon
 * ROM the user supplies already has the entry and is left alone.
 */

const PAGE = 0x4000;

/** The menu text, high bit set on the last character. */
const TAPE_TESTER = [0x54, 0x61, 0x70, 0x65, 0x20, 0x54, 0x65, 0x73, 0x74, 0x65, 0xF2];
const TEXT_AT = 0x2784;
/** Tape Tester's body: reached only by the `CALL 3BE9` at 0x2819 in the menu. */
const ROUTINE_AT = 0x3BE9;
const CALL_AT = 0x2819;
const CALL_TAPE_TESTER = [0xCD, 0xE9, 0x3B];
const TAPE_TESTER_BODY = [0xCD, 0x56, 0x3C, 0xF3, 0xDB, 0xFE];   // CALL 3C56; DI; IN A,(FE)

/** RANDOMIZE USR VAL "15616" */
const LINE = [0xF9, 0xC0, 0xB0, 0x22, 0x31, 0x35, 0x36, 0x31, 0x36, 0x22];

/** Offset of the `LD HL,line` operand within routine(). */
const LINE_ADDR_AT = 28;

function routine(): number[] {
  const code = [
    0x21, 0x3C, 0x5C,         // LD HL,TV_FLAG
    0xCB, 0x86,               // RES 0,(HL)      main screen, as the other entries leave it
    0xCB, 0xF6,               // SET 6,(HL)
    0x21, 0x0E, 0xEC,         // LD HL,EC0E      the 128K menu's "running" marker
    0x36, 0xFF,               // LD (HL),FF
    0xCD, 0x20, 0x1F,         // CALL 1F20       back onto the 128K stack
    0xEF, 0xB0, 0x16,         // RST 28: ROM 1 SET-MIN, a fresh edit line
    0x2A, 0x59, 0x5C,         // LD HL,(E_LINE)
    0x01, LINE.length, 0x00,  // LD BC,len
    0xEF, 0x55, 0x16,         // RST 28: ROM 1 MAKE-ROOM
    0x21, 0x00, 0x00,         // LD HL,line      (address filled in below)
    0xED, 0x5B, 0x59, 0x5C,   // LD DE,(E_LINE)
    0x01, LINE.length, 0x00,  // LD BC,len
    0xED, 0xB0,               // LDIR
    0xC3, 0x11, 0x1B,         // JP 1B11         run it
  ];
  const lineAt = ROUTINE_AT + code.length;
  code[LINE_ADDR_AT] = lineAt & 0xFF;
  code[LINE_ADDR_AT + 1] = lineAt >> 8;
  return [...code, ...LINE];
}

const matches = (rom: Uint8Array, at: number, bytes: number[]): boolean =>
  bytes.every((b, i) => rom[at + i] === b);

/** `rom` with the TR-DOS menu entry added, or `rom` itself when it is not the
 *  stock Sinclair 128K ROM pair (so a Pentagon ROM is never altered). */
export function withTrdosMenuEntry(rom: Uint8Array): Uint8Array {
  if (rom.length < 2 * PAGE) return rom;
  if (!matches(rom, TEXT_AT, TAPE_TESTER) || !matches(rom, CALL_AT, CALL_TAPE_TESTER)
    || !matches(rom, ROUTINE_AT, TAPE_TESTER_BODY)) return rom;
  const out = rom.slice();
  // Same width as the old text so the table behind it stays put; the last
  // character carries the terminator bit, the rest is blank.
  const text = [0x54, 0x52, 0x2D, 0x44, 0x4F, 0xD3];                // "TR-DOS"
  out.set(text, TEXT_AT);
  out.fill(0x20, TEXT_AT + text.length, TEXT_AT + TAPE_TESTER.length);
  out.set(routine(), ROUTINE_AT);
  return out;
}
