# Third-party notices

zx84 is MIT-licensed (see [LICENSE](./LICENSE)). The following third-party work
is used in, or adapted for, zx84. Each remains under its own licence.

Several other cores and machines cite MAME, FUSE/libspectrum, openMSX, Caprice32,
Arnold, HxC and other projects as references for hardware behaviour. Those
citations are in code comments next to the behaviour concerned; the entries
below cover the places where code or data was adapted from a project.

## Hyllian's xBR shaders — MIT

Used in `src/display/shaders/xbr.ts` (xBR-lv2 and xBR-lv3 scaling), ported from
libretro/common-shaders (`xbr/shaders/xbr-lv2.cg`, `xbr-lv3.cg`).

```
Hyllian's xBR-lv2 Shader

Copyright (C) 2011-2016 Hyllian - sergiogdb@gmail.com
(xBR-lv3: Copyright (C) 2011-2015 Hyllian - sergiogdb@gmail.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

Incorporates some of the ideas from SABR shader. Thanks to Joshua Street.
```

## MAME (BSD-3-Clause files) — adapted code and data

zx84 adapts the following from MAME source files that carry
`license:BSD-3-Clause`. The notice below applies to each.

- **Intel 8271** — `src/cores/i8271.ts`: structure, field and method names,
  status/error names and values, the status/result/command/parameter register
  logic, the command-parameter table and the SPECIFY and special-register
  handling, from `src/devices/machine/i8271.cpp` and `i8271.h`
  (copyright-holders: Carl, Olivier Galibert).
- **Yamaha V9938** — `src/cores/v9938.ts`: the register write masks, the
  power-on palette, the Graphic 7 sprite colour table, the screen-mode table,
  the reset status values and the register/port handling, from
  `src/devices/video/v9938.cpp` and `v9938.h`
  (copyright-holders: Aaron Giles, Nathan Woods).
- **TMS9928A palette** — `src/cores/tms9918a.ts` (`TMS9918_PALETTE`): the
  15-colour RGB table from `src/devices/video/tms9928a.cpp`
  (copyright-holders: Sean Young, Nathan Woods, Aaron Giles, Wilbert Pol, hap;
  the table is R. Nabet's computation recorded in that file).
- **Camputers Lynx** — `src/machines/lynx/` (`lynx-memory.ts` banking
  tables and port decode, `lynx-keyboard.ts` and the keyboard layout's
  matrix, `lynx-video.ts` addressing, `lynx-io.ts`) and
  `src/media/tape/lynx-tap.ts` (tape format constants): from
  `src/mame/camputers/camplynx.cpp` (copyright-holders: Robbbert) and
  `src/lib/formats/camplynx_cas.cpp` (copyright-holders: Robbbert,
  Nigel Barnes).
- **Jupiter Ace and Memotech MTX** — the Ace keyboard matrix and frame
  interrupt timing, and the MTX sound-latch arrangement, were taken from
  `src/mame/cantab/jupace.cpp` (copyright-holders: Curt Coder, Robbbert),
  `src/lib/formats/ace_tap.cpp` (copyright-holders: Wilbert Pol) and
  `src/mame/memotech/mtx.cpp` / `mtx_m.cpp` (copyright-holders: Lee Ward,
  Dirk Best, Curt Coder).

```
BSD 3-Clause License

Copyright (c) the copyright-holders named above for each file

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## MAME (GPL-2.0+ files) — studied for behaviour only

MAME's Tatung Einstein, Amstrad CPC and Amstrad PCW drivers are GPL-2.0+. They
were read to learn how the hardware behaves; no code from them is used in zx84
(some comments mention them as behaviour references, and the Einstein keyboard
matrix agrees with MAME's, verified against the real ROMs).

## Bedstead — CC0-1.0

`src/cores/saa5050-font.ts` holds the SAA5050 teletext glyph dot patterns,
derived from the glyph table in Ben Harris's Bedstead font
(https://bjh21.me.uk/bedstead/). Bedstead's program code and newly designed
glyphs are dedicated to the public domain under CC0 1.0
(http://creativecommons.org/publicdomain/zero/1.0/). The glyph shapes that
reproduce the Mullard SAA5050 typeface remain the copyright of Mullard's
successors; Bedstead relies on section 55 of the UK Copyright, Designs and
Patents Act 1988, under which making articles specifically designed to produce
material in that typeface does not infringe it. That is a UK provision and
Bedstead's author notes it is not legal advice.

## ZXDB — open database

The software library catalogs are built from [ZXDB](https://github.com/zxdb/ZXDB)
by Einar Saukas and contributors. ZXDB asks users to mention it and, for derived
databases, to keep them open (it points to the Open Database License, ODbL 1.0).
`tools/fetch-zxdb.ts` ports the MySQL-to-SQLite line transforms from ZXDB's
`scripts/ZXDB_to_SQLite.py`; that script carries no licence file.

## dskmanager-rust — Apache-2.0 / MIT (same author)

`src/media/floppy/disk-detect.ts` (`detectProtection`) is ported from
https://github.com/damieng-zx/dskmanager-rust, written by zx84's author.

## retro-render — MIT (same author)

`src/machines/spectrum/screen-to-canvas.ts` adapts the Spectrum screen
algorithm from https://github.com/damieng/retro-render, written by zx84's
author.

## MEMU — FDX 80-column character font

`src/machines/mtx/peripherals/fdx-80-column.ts` embeds the FDX alpha character
glyphs (256 × 10 rows) transcribed by Andy Key for his MEMU emulator
(http://www.nyangau.org/memu/, `monprom.c`) from the Memotech FDX user manual.
MEMU states no licence. The glyphs are bitmap shapes of the original hardware's
character set and are credited to Andy Key as their transcriber. The mosaic
(graphics) glyphs are generated by zx84's own code.
