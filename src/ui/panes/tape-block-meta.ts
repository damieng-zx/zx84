/**
 * Tape-block → one-line pane label.
 *
 * Pure formatting for the pulse-deck block list (Spectrum TAP/TZX/CSW and the
 * Lynx's typed entries). Kept out of the pane component so it can be tested
 * without a DOM.
 */

import type { TapeBlock, DataBlock } from '@/media/tape/tap.ts';

function tapeFileLine(typeId: number, filename: string, dataLen: number, param1: number): string {
  switch (typeId) {
    case 0: return `PROGRAM "${filename}"${param1 < 10000 ? ` LINE ${param1}` : ''}`;
    case 1: return `NUMERIC ARRAY "${filename}" ${dataLen}`;
    case 2: return `CHARACTER ARRAY "${filename}" ${dataLen}`;
    case 3: return `CODE "${filename}" ${param1},${dataLen}`;
    default: return `DATA "${filename}" ${dataLen}`;
  }
}

function sourceTag(block: DataBlock): string {
  if (block.source === 'standard') return ' [STD]';
  if (block.source === 'turbo') return ' [TURBO]';
  if (block.source === 'pure-data') return ' [PURE]';
  return '';
}

function dataTimingDetail(block: DataBlock): string {
  const parts: string[] = [`pause=${block.pause}ms`];
  if (block.pilotCount > 0) parts.push(`pilot=${block.pilotPulse}T x${block.pilotCount}`);
  if (block.syncPulse1 > 0) parts.push(`sync=${block.syncPulse1}/${block.syncPulse2}T`);
  parts.push(`bit=${block.bit0Pulse}/${block.bit1Pulse}T`);
  if (block.usedBits !== 8) parts.push(`used=${block.usedBits}bits`);
  return parts.join(' ');
}

export function parseTapeBlockMeta(block: TapeBlock, index: number, blocks: TapeBlock[], collapseBlocks: boolean): { line: string; detail: string; hidden: boolean; control: boolean; absorbsNext: boolean } {
  switch (block.kind) {
    case 'data': {
      const tag = sourceTag(block);
      const timing = block.source !== 'tap' ? dataTimingDetail(block) : '';
      // A format-tagged file entry (the Lynx's quoted name + typed data pair)
      // carries its own identity, so show the name/type instead of a byte count.
      if (block.file) {
        const f = block.file;
        const line = `${index}: ${f.name ? `${f.command} "${f.name}"` : f.command}`;
        const detail = `${f.typeName} · ${f.size} bytes`;
        if (!f.header) {
          // The data child hides behind its name header when combining.
          const prev = blocks[index - 1];
          if (collapseBlocks && prev && prev.kind === 'data' && prev.file?.header) {
            return { line: '', detail: '', hidden: true, control: false, absorbsNext: false };
          }
          return { line, detail, hidden: false, control: false, absorbsNext: false };
        }
        const next = blocks[index + 1];
        const hasChild = !!next && next.kind === 'data' && !!next.file && !next.file.header;
        return { line, detail, hidden: false, control: false, absorbsNext: !!(hasChild && collapseBlocks) };
      }
      if (block.source !== 'pure-data' && block.flag === 0x00 && block.data.length >= 15) {
        const typeId = block.data[0];
        let filename = '';
        for (let i = 1; i <= 10; i++) filename += String.fromCharCode(block.data[i]);
        const dataLen = block.data[11] | (block.data[12] << 8);
        const param1 = block.data[13] | (block.data[14] << 8);
        const nextBlock = blocks[index + 1];
        const hasMatchingData = nextBlock && nextBlock.kind === 'data' && nextBlock.flag === 0xFF && nextBlock.data.length === dataLen;
        const line = `${index}: ${tapeFileLine(typeId, filename.trimEnd(), dataLen, param1)}${tag}`;
        const detail = timing;
        // When collapsed, the header row absorbs the hidden data child that follows it,
        // so it must also reflect that child's loading/played state.
        return { line, detail, hidden: false, control: false, absorbsNext: !!(hasMatchingData && collapseBlocks) };
      }
      if (collapseBlocks) {
        const prevBlock = blocks[index - 1];
        if (prevBlock && prevBlock.kind === 'data' && prevBlock.flag === 0x00 && prevBlock.data.length >= 15) {
          const headerDataLen = prevBlock.data[11] | (prevBlock.data[12] << 8);
          if (block.data.length === headerDataLen) return { line: '', detail: '', hidden: true, control: false, absorbsNext: false };
        }
      }
      const size = block.data.length;
      let detail = ''; if (timing) detail = timing;
      return { line: `${index}: Data ${size} bytes${tag}`, detail, hidden: false, control: false, absorbsNext: false };
    }
    case 'tone': return { line: `${index}: Pure Tone`, detail: `${block.pulseLen}T × ${block.count} pulses`, hidden: false, control: true, absorbsNext: false };
    case 'pulses': return { line: `${index}: Pulse Sequence`, detail: `${block.lengths.length} pulses`, hidden: false, control: true, absorbsNext: false };
    case 'csw': return { line: `${index}: CSW Recording`, detail: `${block.pulses.length} pulses`, hidden: false, control: true, absorbsNext: false };
    case 'direct': return { line: `${index}: Direct Recording`, detail: `${block.tStatesPerSample}T/sample, ${block.data.length} bytes, pause=${block.pause}ms`, hidden: false, control: true, absorbsNext: false };
    case 'pause': return { line: block.duration === 0 ? `${index}: Stop the tape` : `${index}: Pause ${block.duration}ms`, detail: '', hidden: false, control: true, absorbsNext: false };
    case 'set-level': return { line: `${index}: Set Level ${block.level}`, detail: '', hidden: false, control: true, absorbsNext: false };
    case 'stop-if-48k': return { line: `${index}: Stop if 48K`, detail: '', hidden: false, control: true, absorbsNext: false };
    case 'group-start': return { line: `${index}: ▸ ${block.name}`, detail: '', hidden: false, control: true, absorbsNext: false };
    case 'group-end': return { line: '', detail: '', hidden: true, control: true, absorbsNext: false };
    case 'text': return { line: `${index}: ${block.text}`, detail: '', hidden: false, control: true, absorbsNext: false };
    case 'archive-info': return { line: `${index}: Archive Info`, detail: block.entries.map(e => e.text).join(', '), hidden: false, control: true, absorbsNext: false };
  }
}
