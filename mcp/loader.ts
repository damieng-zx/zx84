import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Spectrum, SpectrumModel } from '../src/spectrum.ts';
import { loadSNA } from '../src/snapshot/sna.ts';
import { loadZ80 } from '../src/snapshot/z80format.ts';
import { loadSZX } from '../src/snapshot/szx.ts';
import { parseDSK } from '../src/plus3/dsk.ts';
import { parseMgt, mgtExtFromName } from '../src/plus3/mgt-image.ts';
import { parseTZX } from '../src/tape/tzx.ts';
import { h16 } from './hex.ts';
import { fetchPlusDRom } from './rom-fetch.ts';
import { state, initMachine, activeSpectrum } from './state.ts';

export async function loadFileInto(spec: Spectrum, filepath: string, diskUnit: number = 0): Promise<string> {
  if (!fs.existsSync(filepath)) return `File not found: ${filepath}`;
  const data = new Uint8Array(fs.readFileSync(filepath));
  const ext = path.extname(filepath).toLowerCase();
  const filename = path.basename(filepath);

  if (ext === '.tap') {
    spec.loadTAP(data);
    spec.tape.rewind();
    spec.tape.paused = false;
    spec.reset();
    spec.tape.startPlayback();
    return `TAP loaded: ${filename} (${spec.tape.blocks.length} blocks)`;
  } else if (ext === '.tzx') {
    const blocks = parseTZX(data);
    spec.tape.blocks = blocks;
    spec.tape.rewind();
    spec.tape.paused = false;
    spec.reset();
    spec.tape.startPlayback();
    return `TZX loaded: ${filename} (${blocks.length} blocks)`;
  } else if (ext === '.dsk') {
    const image = parseDSK(data);
    spec.loadDisk(image, diskUnit);
    const driveLetter = diskUnit === 0 ? 'A' : 'B';
    return `DSK loaded: ${filename} → Drive ${driveLetter}: (${image.numTracks} tracks, ${image.numSides} side${image.numSides > 1 ? 's' : ''})`;
  } else if (ext === '.mgt' || ext === '.img') {
    // Auto-enable the +D (load G+DOS ROM + reset to boot it) then insert.
    if (!spec.mgtPlusD.enabled || !spec.mgtPlusD.romLoaded) {
      const rom = await fetchPlusDRom();
      spec.mgtPlusD.loadROM(rom);
      spec.mgtPlusD.enabled = true;
      spec.reset();
    }
    const image = parseMgt(data, mgtExtFromName(filename));
    if (!image) return `Not a recognised +D image: ${filename} (${data.length} bytes)`;
    spec.loadPlusDDisk(image, diskUnit);
    const dl = diskUnit === 0 ? 'C' : 'D';
    return `+D image loaded: ${filename} → Drive ${dl}: (${image.numTracks} tracks, ${image.numSides} side${image.numSides > 1 ? 's' : ''})`;
  } else if (ext === '.sna') {
    spec.reset();
    const result = loadSNA(data, spec.cpu, spec.memory);
    spec.ula.borderColor = result.borderColor;
    return `SNA loaded: ${filename} (${result.is128K ? '128K' : '48K'}) PC=${h16(spec.cpu.pc)}`;
  } else if (ext === '.z80') {
    spec.reset();
    const result = loadZ80(data, spec.cpu, spec.memory);
    spec.ula.borderColor = result.borderColor;
    return `Z80 loaded: ${filename} (${result.is128K ? '128K' : '48K'}) PC=${h16(spec.cpu.pc)}`;
  } else if (ext === '.szx') {
    // Auto-detect model from SZX header byte 6 (machine ID).
    // Must switch before loading so memory.is128K is set correctly and ROM pages are right.
    const SZX_ID_MODEL: Record<number, SpectrumModel> = {
      0: '16k', 1: '48k', 2: '128k', 3: '+2', 4: '+2A', 5: '+3', 6: '+3',
    };
    const szxModel: SpectrumModel = (data.length >= 7 ? SZX_ID_MODEL[data[6]] : undefined) ?? '48k';
    if (szxModel !== state.model) {
      await initMachine(szxModel);
      spec = activeSpectrum()!; // szxModel is always a Spectrum model
    } else {
      spec.reset();
    }
    const result = await loadSZX(data, spec.cpu, spec.memory);
    if (result.is128K) {
      // Use direct property assignment + applyBanking() — NOT bankSwitch().
      // bankSwitch() uses slot-diffing and won't re-populate fixed slots (bank5/bank2).
      spec.memory.port7FFD    = result.port7FFD;
      spec.memory.port1FFD    = result.port1FFD;
      spec.memory.currentBank = result.port7FFD & 0x07;
      spec.memory.pagingLocked  = (result.port7FFD & 0x20) !== 0;
      spec.memory.specialPaging = (result.port1FFD & 1) !== 0;
      // +2A/+3 ROM index uses bits from both ports; others use only 7FFD bit 4
      spec.memory.currentROM = (szxModel === '+2A' || szxModel === '+3')
        ? (((result.port1FFD >> 2) & 1) << 1) | ((result.port7FFD >> 4) & 1)
        : (result.port7FFD >> 4) & 1;
      spec.memory.applyBanking();
    }
    spec.ula.borderColor = result.borderColor;
    return `SZX loaded: ${filename} (${szxModel}) PC=${h16(spec.cpu.pc)}`;
  }
  return `Unsupported file type: ${ext}`;
}
