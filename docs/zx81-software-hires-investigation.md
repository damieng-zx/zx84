# ZX81 software-only high-resolution investigation

## Scope and terminology

The original “fake” software-only high-resolution request is the ZX81
**pseudo-hires** technique. The emulator now also supports the two common
optional hardware paths as separate, mutually exclusive settings.

- Normal video executes character bytes from the A15-high echo of `D_FILE`.
  On an M1 opcode fetch with bit 6 clear, the ULA latches the character and
  inverse bits, gives the CPU a NOP, and fetches an 8-pixel pattern from the
  ROM address selected by `I`, the character code, and its line counter.
- Pseudo-hires repeats that process for 192 individually generated scanlines.
  Software points `I` at a useful ROM region and resets the ULA line counter,
  choosing the closest available ROM pattern for every 8-pixel group. It is
  256x192 output, but not an arbitrary bitmap.
- **UDG RAM ($3000)** points the character-pattern path at writable RAM in
  `$3000-$3FFF`.
- **WRX hi-res** uses the unmodified `I:R` refresh address. WRX16 uses the
  optional refresh-readable `$2000-$3FFF` RAM, while compact WRX1K programs
  can source pixels from the ZX81's stock RAM.

## Evidence from the baseline emulator

The baseline implementation could not reproduce pseudo-hires:

1. `installCpuBus()` substitutes NOP for every qualifying read above `$8000`,
   although the ULA only does this during M1 opcode fetches.
2. `renderDisplayFile()` runs after the frame. It uses the final `I` value,
   the system `D_FILE` pointer, and a fixed 32x24 character layout.
3. Pseudo-hires software temporarily changes `I` and executes its own
   high-memory display stream once per raster line, then restores `I` before
   the frame finishes. The relevant state no longer exists when
   `renderDisplayFile()` runs.
4. There is no modeled ULA line counter or beam-side video capture. The frame
   loop currently supplies only coarse 312-line CPU scheduling and NMI calls.

A headless trace of the catalog copy of **Manic Miner** confirmed the expected
behavior. During its display phase it temporarily sets `I=$08`, performs M1
fetches from `$CD00` through `$CD1F` exactly four T-states apart, and executes
`RET` at `$CD20`. At frame end `I` is restored to `$1E`. The current OCR sees
garbage because it decodes the ordinary `D_FILE`, not the executed raster
stream.

Re-reading the ordinary `D_FILE` once per scanline is not sufficient: it
still misses the temporary `I` value and the separately executed display
buffer demonstrated by the trace above.

## ZX81 FAST and SLOW modes

The ROM records the display mode in bit 7 of `CDFLAG` at `$403B`. Ordinary
display-file output is visible in SLOW mode and the screen is blank in FAST
mode. Pseudo-hires is different: the application is generating raster data
explicitly, so a captured software raster remains visible in either mode.
When generation stops, the retained raster expires; FAST returns to blank,
while SLOW resumes the ordinary display-file renderer.

Headless validation with the catalog copy of **Manic Miner** produced its
first pseudo-hires frame on emulator frame 6 and captured a stable 127-row
active raster while `CDFLAG` was in FAST mode.

Manic Miner follows its ROM-pattern cave raster with two ordinary-font status
rows (sixteen NMI-paced scanlines). These are captured with the ZX81 modulo-8
line counter and composited directly below the pseudo-hires rows; treating them
as another pseudo-hires frame either drops the HUD or flashes a partial image.

## Accuracy setting

ZX81 pseudo-hires requires the equivalent of the Spectrum's high-accuracy
path: the emulator must observe individual M1 fetches and software-generated
sync pulses. A lower scanline- or frame-batched mode cannot reconstruct the
temporary `I` value or the generated rows. The ZX81 implementation therefore
runs this path unconditionally rather than exposing an Accuracy dropdown whose
lower choices would silently disable pseudo-hires. Its frame cadence uses the
machine's 207-T-state scanline and 312-line frame (64,584 T-states).

## Option A: targeted pseudo-hires capture (recommended)

Keep the existing normal character renderer as a fallback and add a
machine-local raster capture path for nonstandard ROM-based display streams.

1. Before each `cpu.step()`, observe the actual PC opcode fetch. If A15 is set
   and the raw byte has bit 6 clear, this is a ZX81 display byte. Latch it and
   let the existing CPU bus return NOP. Bytes with bit 6 set execute normally
   and terminate or control the display routine.
2. Detect pseudo-hires while `I` selects a nonstandard ROM page (for example
   Manic Miner’s `$08`; normal ZX81 text uses `$1E`). Do not infer it merely
   from the final frame state.
3. For each captured display byte, read the pixel pattern from:

   ```text
   ((I & $FE) << 8) | ((character & $3F) << 3) | (lineCounter & 7)
   ```

   Apply inverse video when bit 7 of the display byte is set.
4. Group a run of 32 consecutive 4T display fetches into one 256-pixel output
   row. A bit-6-set instruction such as `RET` ends the run, and the following
   ZX81 `OUT` sync pulse commits it. Requiring both timing and sync qualification
   rejects ordinary high-memory execution that would otherwise appear as
   bitmap noise.
5. Accumulate up to 192 rows in a 32-byte-per-row scratch raster. Copy it into
   the existing RGBA framebuffer at frame end. Fall back to
   `renderDisplayFile()` when no complete pseudo-hires rows were captured.
6. Reset capture state on reset and media load. Use the long gap between
   committed rows to finalize a software frame, ignore isolated transitional
   rows once a multi-row raster exists, and expire a retained raster after
   generation stops. Keep the feature ZX81-only initially.

This approach is small, machine-local, and avoids adding a hot-path callback
to every Z80 machine. The same ZX81-local M1 observer now selects ROM patterns,
UDG character RAM, or WRX refresh bytes according to the enabled hardware.

### Tests for Option A

- A synthetic 32-byte high-memory display stream produces one exact raster
  row from a nonstandard ROM page.
- `I` is sampled at M1 time; restoring it before frame end does not alter the
  captured row.
- Bit 7 inverts the generated byte.
- A bit-6-set terminator is executed and not captured.
- Ordinary data reads above `$8000` are not treated as display fetches.
- Standard `$1E` character display still uses the existing renderer.
- Standard display-file output is present in SLOW mode and blank in FAST.
- A generated pseudo-hires raster is visible in FAST as well as SLOW, then
  expires back to the correct mode-specific fallback.
- Pseudo-hires mode does not feed the ordinary text OCR path garbage; report
  no text unless a later framebuffer OCR implementation is added.

## Hardware options now implemented

The Hardware panel exposes `UDG RAM ($3000)` and `WRX hi-res` for ZX81 only.
Selecting either recreates the machine with the relevant RAM decoding and
turns the other option off. Both modes retain the unconditional high-accuracy
M1/sync capture needed by software pseudo-hires and preserve FAST/SLOW-mode
behaviour.

- UDG rows read glyph bytes from character-generator RAM and use the ZX81's
  modulo-8 line counter.
- WRX rows read bitmap bytes from the pre-step `I:R` refresh address. Full-width
  32-byte WRX16 and centered variable-width WRX1K rows are accepted, including
  sparse blank scanlines encoded as exact 207-T-state gaps.
- The MCP `model` tool exposes the same `udgRam` and `wrxHires` options and
  preserves them when a ZXDB library launch enables 16KB RAM.

Real-program validation covers Artic's **ZX Galaxians** UDG board title and all
ten programs in the WRX1K **1K hires gamepack**, in addition to the ROM
pseudo-hires Manic Miner fixture.

## ZXDB enhanced-graphics classifications

ZXDB tag type `Z` is the structured `ZX81 Enhanced Graphics` filter shown by
Spectrum Computing. The catalog builder now retains every tag for filtering and
maps the modes we emulate to launch settings. Counts below are from ZXDB
1.0.238 (July 2026); a title can carry more than one tag.

| ZXDB tag | Titles | Status |
| --- | ---: | --- |
| ZX81 Pseudo Hi-Res (Software) | 28 | Supported |
| ZX81 Hi-res: WRX (Original 1K RAM) | 61 | Supported |
| ZX81 Hi-res: WRX (Modified RAM Pack) | 41 | Supported |
| ZX81 Hi-res: UDG Card (Mapped at 3000h) | 7 | Supported |
| ZX81 Hi-res: Memotech HRG Interface | 4 | Missing |
| ZX81 Hi-res: QuickSilva (QS) HRG Interface | 10 | Missing |
| ZX81 Hi-res: HRG-ms (Modified RAM Pack) | 7 | Missing |
| ZX81 Hi-res: UDG-128 | 11 | Missing |
| ZX81 Chroma Interface | 53 | Missing colour and attribute emulation |
| ZX81 Hi-res - unknown/unidentified method | 18 | Needs title-by-title research |

Zedragon (ZXDB 33460) is tagged with the `$3000` UDG card, so library launches
select that graphics board automatically. The title as a whole is not yet
supported: it is also a ZX81 32K program that requires ZXpand and advertises AY
sound, while the emulator currently offers only 1KB/16KB RAM and no ZXpand.
Those dependencies are separate from the enhanced-graphics classification.

## Cycle-aware ZX81 ULA (possible future refinement)

For standard, pseudo-hires, UDG, WRX, FAST/SLOW video, and unusual sync code,
introduce a proper ZX81 ULA object and an explicit Z80 M1-fetch seam.

- Add a Z80 opcode-fetch method used by the main opcode and all prefix M1
  cycles, distinct from ordinary `read8` data accesses.
- Let the ZX81 ULA own beam position, HSYNC/VSYNC, its modulo-8 line counter,
  NMI/INT timing, character/inverse latches, and framebuffer writes.
- Advance the ULA by elapsed CPU T-states rather than rendering memory after
  the frame.
- Move the existing optional refresh-readable UDG/WRX RAM and pre-step `I:R`
  byte selection into that ULA object.

This is architecturally accurate but materially larger. It touches the shared
Z80 M1 hot path and needs regression testing against every Z80 machine and the
Spectrum timing suites. It should follow, rather than block, targeted
pseudo-hires support.

## References

- Wilf Rigter, “ZX Video Tutorial,” sections 9–11 (character, pseudo-hires,
  and true-hires timing):
  https://quix.us/timex/rigter/ZX%4020Video%4020Tutorial.html
- Wilf Rigter, “WRX 16 Hi-Res for the 1000,” including the refresh-readable
  static RAM requirement:
  https://www.timexsinclair.com/article/wrx-16-hi-res-for-the-1000/index.html
- ZEsarUX `src/machines/zx8081.c`, particularly
  `fetch_opcode_zx81_graphics()`, used as a reference implementation:
  https://github.com/chernandezba/zesarux
- sz81 `z80.c`, whose standard character path captures video during opcode
  execution and notes that true-hires needs refresh-address handling:
  https://sz81.sourceforge.net/
