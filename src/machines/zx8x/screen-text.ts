import type { OcrResult } from '@/ocr/ocr.ts';
import type { Zx8xModel } from './models.ts';
import { zx8xChar } from './basic.ts';

const COLS = 32;
const ROWS = 24;

function escapeHtml(value: string): string {
  return value === '<' ? '&lt;' : value === '>' ? '&gt;' : value === '&' ? '&amp;' : value;
}

function cells(mem: Uint8Array, model: Zx8xModel): string[] {
  let pointer = mem[0x400c] | (mem[0x400d] << 8);
  const result = new Array<string>(COLS * ROWS).fill(' ');
  if (pointer < 0x4000 || pointer >= 0x8000) return result;
  if (mem[pointer] === 0x76) pointer++;
  for (let row = 0; row < ROWS && pointer < 0x8000; row++) {
    for (let col = 0; col < COLS && pointer < 0x8000; col++) {
      const value = mem[pointer++];
      if (value === 0x76) break;
      result[row * COLS + col] = zx8xChar(model, value);
    }
  }
  return result;
}

export class Zx8xScreenText {
  active = false;
  activate(): void { this.active = true; }
  deactivate(): void { this.active = false; }

  ocr(mem: Uint8Array, model: Zx8xModel): string {
    const grid = cells(mem, model);
    const lines: string[] = [];
    for (let row = 0; row < ROWS; row++) lines.push(grid.slice(row * COLS, (row + 1) * COLS).join('').trimEnd());
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines.join('\n');
  }

  ocrStyled(mem: Uint8Array, model: Zx8xModel): OcrResult {
    const grid = cells(mem, model);
    const mask = grid.map(value => value !== ' ');
    let text = '', html = '';
    for (let row = 0; row < ROWS; row++) {
      const line = grid.slice(row * COLS, (row + 1) * COLS).join('');
      text += line;
      html += `<span style="color:#000000">${[...line].map(escapeHtml).join('')}</span>`;
      if (row < ROWS - 1) { text += '\n'; html += '\n'; }
    }
    return { text, html, mask, grid: '32x24', cellWidth: 8, cellHeight: 8, cols: COLS, rows: ROWS };
  }
}
