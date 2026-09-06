/**
 * SAM BASIC system-variable display.
 *
 * The SAM has its own system variables, at its own addresses, and they are not
 * read the way the Spectrum's are. Two differences drive this whole component:
 *
 *  - They live in **RAM page 0**, which the ROM keeps paged at 0x4000 — not in
 *    whatever the CPU happens to be looking at. So this reads the page
 *    directly rather than a 64K snapshot; a program that pages itself over the
 *    system variables does not blank the pane.
 *  - The pointers into BASIC's memory are **three bytes, page then a
 *    0x8000-based offset**, so they are shown as `page:offset` rather than as a
 *    16-bit address that would name nothing.
 */

import { createMemo, For } from 'solid-js';
import { sysvarRev } from '@/state/debug-state.ts';
import { HEX8, HEX16 } from '@/utils/hex.ts';
import {
  readSamByte, readSamPointer, readSamWord,
  SAM_SYSVARS, SAM_SYSVAR_PAGE, type SamSysVarDef,
} from '../sysvars.ts';
import { activeSam } from './active.ts';

/**
 * Width every value is padded to, so the two columns line up.
 *
 * Seven characters is what the widest form needs: a page/offset pointer on a
 * 512K machine reads `31:3FFF`. The values here are four very different
 * shapes — a 3-byte pointer, a word, a byte, a channel letter — and letting
 * each take its natural width moves the second column from row to row.
 */
const VALUE_WIDTH = 7;

/** Format one system variable for display, right-aligned in a fixed field. */
function readVal(page: Uint8Array, def: SamSysVarDef): string {
  return value(page, def).padStart(VALUE_WIDTH);
}

function value(page: Uint8Array, def: SamSysVarDef): string {
  switch (def.width) {
    case 'ptr': {
      const p = readSamPointer(page, def.addr);
      return `${p.page}:${HEX16[p.offset]}`;
    }
    case 16:
      return HEX16[readSamWord(page, def.addr)];
    case 'char': {
      const v = readSamByte(page, def.addr);
      return v >= 0x20 && v < 0x7F ? String.fromCharCode(v) : HEX8[v];
    }
    default:
      return HEX8[readSamByte(page, def.addr)];
  }
}

function pad(name: string): string {
  return name.length < 8 ? name + ' '.repeat(8 - name.length) : name;
}

interface Cell { name: string; tip: string; text: string }

export function SamSysVars() {
  const rows = createMemo<Cell[][]>(() => {
    sysvarRev(); // track
    const sam = activeSam();
    if (!sam) return [];
    const page = sam.memory.getRamBank(SAM_SYSVAR_PAGE);
    return SAM_SYSVARS.map(pair => pair.map(def => ({
      name: pad(def.name),
      tip: def.tip,
      text: readVal(page, def),
    })));
  });

  return (
    <pre id="sysvar-output">
      <For each={rows()}>{(row, i) => (
        <>
          <For each={row}>{(cell, j) => (
            <>
              {j() > 0 ? '    ' : ''}
              <span class="reg-name" data-tip={cell.tip}>{cell.name}</span>
              {' '}{cell.text}
            </>
          )}</For>
          {i() < rows().length - 1 ? '\n' : ''}
        </>
      )}</For>
    </pre>
  );
}
