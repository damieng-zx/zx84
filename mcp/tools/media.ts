import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { saveSZX } from '../../src/machines/spectrum/snapshots/szx.ts';
import { hex8 as h8, hex16 as h16 } from '../../src/utils/hex.ts';
import { state, initMachine } from '../state.ts';
import { activeSpectrum, activeCpc, activeFdc, zx8x16kRam } from '../concrete.ts';
import { text, formatHexDump } from '../format.ts';
import { loadFileInto, loadMediaInto, mountAndArm, mountMediaBytes, runLoadVerdict } from '../loader.ts';
import { fdcLog } from '../fdc-log.ts';
import { unzip } from '../../src/media/zip.ts';
import { CACHE_DIR } from '../rom-fetch.ts';
import {
  findGames, findZx8xGames, suggestTitles, suggestZx8xTitles,
  fileUrls, planLoad, availableFormats, basename,
} from '../catalog.ts';
import { encodePNG } from '../png.ts';
import { isZx8xModel } from '../../src/models.ts';

async function loadZx8xLibraryTitle(
  title: string, innerFile: string | undefined, id: number | undefined,
  frames: number, refresh: boolean,
): Promise<string> {
  if (!isZx8xModel(state.model)) return 'ZX80/ZX81 library requires a ZX80 or ZX81 model.';
  const model = state.model;

  let games;
  try {
    games = await findZx8xGames(title, model, refresh);
  } catch (error) {
    return `Catalog error: ${(error as Error).message}`;
  }
  if (games.length === 0) {
    const near = await suggestZx8xTitles(title, model);
    return `No exact ${model.toUpperCase()} title match for "${title}".` +
      (near.length ? `\n${model.toUpperCase()} titles containing it:\n${near.map(name => `  • ${name}`).join('\n')}` : '');
  }

  let game = games[0];
  if (games.length > 1) {
    const picked = id === undefined ? undefined : games.find(candidate => candidate.id === id);
    if (!picked) {
      return `${games.length} ${model.toUpperCase()} titles match "${title}" exactly — re-run with id=:\n` +
        games.map(candidate => `  id=${candidate.id}  ${candidate.title} (${candidate.year ?? '?'})  ${candidate.publisher || '—'}`).join('\n');
    }
    game = picked;
  }

  let data: Uint8Array | null = null;
  let fetchedFrom = '';
  let lastError = 'no candidate URL';
  for (const url of fileUrls(game.file)) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        data = new Uint8Array(await response.arrayBuffer());
        fetchedFrom = url;
        break;
      }
      lastError = `HTTP ${response.status} (${url})`;
    } catch (error) {
      lastError = `${(error as Error).message} (${url})`;
    }
  }
  if (!data) return `Download failed for "${game.title}" → ${game.file}\n  ${lastError}`;

  const lines = [
    `Match: ${game.title}${game.year === null ? '' : ` (${game.year})`}  id=${game.id}`,
    `Model: ${model.toUpperCase()} (catalog constrained; no model switch)`,
    `From:  ${fetchedFrom}`,
  ];

  // ZXDB does not record RAM requirements. Match the app's library launch:
  // fit the backward-compatible 16KB pack before mounting any catalog title.
  if (!zx8x16kRam()) lines.push(await initMachine(model, { zx8x16kRam: true }));
  lines.push(await mountMediaBytes(state.spec, data, basename(game.file), innerFile));

  if (frames > 0) {
    const ran = state.spec.runUntil(frames);
    lines.push(`Ran ${ran}/${frames} frame(s). PC=${h16(state.spec.services.debug.pc)} T=${state.spec.services.debug.tStates}`);
  }
  return lines.join('\n');
}

export function register(server: McpServer): void {
  server.registerTool(
    'load',
    { description: 'Load a file into the emulator. ZX80 accepts .o/.80; ZX81 accepts .p/.81/.p81; CPC accepts .dsk/.hfe/.scp disks, .cdt tapes, .sna snapshots, and .cpr cartridges on Plus models; MSX accepts .rom/.cas; Einstein accepts .dsk/.hfe/.scp; Spectrum accepts its tape/snapshot/disk formats (peripheral media auto-enables the matching interface). ZIPs are unwrapped when they hold exactly one compatible file. For DSK, optional drive unit (0/A or 1/B); for MDR, optional microdrive unit (0-7 → drives 1-8).', inputSchema: {
      file: z.string().describe('Path to a machine-compatible media file or ZIP'),
      drive: z.enum(['0', '1', 'A', 'B']).default('0').describe('Drive unit for DSK files'),
    } },
    async ({ file, drive }) => {
      const diskUnit = (drive === '1' || drive === 'B') ? 1 : 0;
      // The Spectrum keeps its bench path: it auto-enables the +D/Interface 1/
      // Beta Disk ROMs for peripheral media, which the machine's own
      // MediaService deliberately refuses to do.
      const spectrum = activeSpectrum();
      if (spectrum) return text(await loadFileInto(spectrum, file, diskUnit));
      // Every other machine mounts through its own MediaService — the machine
      // owns the extension→device routing; ZIP unwrapping is handled inside.
      return text(await loadMediaInto(state.spec, file, `unit:${diskUnit}`));
    },
  );

  server.registerTool(
    'library',
    {
      description:
        'Load a title from the ZX84 game library by EXACT title (case-insensitive), reproducing the app\'s one-click Library play: pick the model + file via planLoad, download from the CDN/Worker, unzip, mount, and arm the auto-boot trap. ' +
        'For an archive with multiple loadable files, pass `file`. For duplicate titles, pass `id`. With frames=0 (default) it only arms the loader — call `run` afterwards. With frames=N it runs the loader and returns a pass/fail verdict: a load FAILS when the tape reaches its end while the CPU is still polling the EAR port (loader stranded), and LOADS when EAR polling stops. Use a generous budget (e.g. 8000) for slow multiloads.',
      inputSchema: {
        title: z.string().describe('Exact game title from the catalog (case-insensitive)'),
        file: z.string().optional().describe('Inner file to load when the archive holds several (name or basename)'),
        id: z.number().int().optional().describe('ZXDB entry id, to disambiguate duplicate titles'),
        frames: z.number().int().min(0).default(0).describe('Frames to run after arming (0 = just arm; use run afterwards)'),
        refresh: z.boolean().default(false).describe('Force re-download of the catalog before resolving'),
      },
    },
    async ({ title, file, id, frames, refresh }) => {
      if (isZx8xModel(state.model)) return text(await loadZx8xLibraryTitle(title, file, id, frames, refresh));
      if (!activeSpectrum()) return text('library supports Spectrum, ZX80, and ZX81 models. Switch model first.');

      // 1. Resolve the exact title against the catalog.
      let games;
      try {
        games = await findGames(title, refresh);
      } catch (e) {
        return text(`Catalog error: ${(e as Error).message}`);
      }
      if (games.length === 0) {
        const near = await suggestTitles(title);
        return text(`No exact title match for "${title}".` +
          (near.length ? `\nTitles containing it:\n${near.map(t => `  • ${t}`).join('\n')}` : ''));
      }
      let game = games[0];
      if (games.length > 1) {
        const picked = id != null ? games.find(g => g.id === id) : undefined;
        if (!picked) {
          const list = games.map(g => `  id=${g.id}  ${g.title} (${g.year ?? '?'})  ${g.publisher || '—'}  [${availableFormats(g).join(', ')}]`).join('\n');
          return text(`${games.length} titles match "${title}" exactly — re-run with id=:\n${list}`);
        }
        game = picked;
      }

      // 2. Plan the load from the current model (same decision the UI makes).
      const plan = planLoad(game, state.model);
      if (!plan) return text(`"${game.title}" has no playable tape/disk/ROM/snapshot in the catalog.`);

      // 3. Download the file: CDN first, then the file-proxy Worker.
      const urls = fileUrls(plan.link);
      let data: Uint8Array | null = null;
      let fetchedFrom = '';
      let lastErr = 'no candidate URL';
      for (const url of urls) {
        try {
          const resp = await fetch(url);
          if (resp.ok) { data = new Uint8Array(await resp.arrayBuffer()); fetchedFrom = url; break; }
          lastErr = `HTTP ${resp.status} (${url})`;
        } catch (e) {
          lastErr = `${(e as Error).message} (${url})`;
        }
      }
      if (!data) return text(`Download failed for "${game.title}" → ${plan.link}\n  ${lastErr}`);

      // 4. Unzip if the file_link is an archive, and pick the inner file.
      let innerName = basename(plan.link);
      if (/\.zip$/i.test(innerName)) {
        let entries;
        try {
          entries = await unzip(data);
        } catch (e) {
          return text(`ZIP error for "${game.title}": ${(e as Error).message}`);
        }
        if (entries.length === 0) return text(`Archive for "${game.title}" contains no loadable files.`);
        let entry = entries[0];
        if (entries.length > 1) {
          const want = file?.toLowerCase();
          const found = want
            ? entries.find(e => e.name.toLowerCase() === want || basename(e.name).toLowerCase() === want)
            : undefined;
          if (!found) {
            const list = entries.map(e => `  • ${e.name}`).join('\n');
            return text(`Archive holds ${entries.length} loadable files — re-run with file=<name>:\n${list}`);
          }
          entry = found;
        }
        data = entry.data;
        innerName = entry.name;
      }

      const lines: string[] = [];
      lines.push(`Match: ${game.title}${game.year ? ` (${game.year})` : ''}  id=${game.id}`);
      lines.push(`Link:  ${plan.link}`);
      lines.push(`From:  ${fetchedFrom}`);
      lines.push(`Plan:  model=${plan.target}  boot=${plan.boot}  inner=${innerName}`);

      // 5. Switch model if the plan needs a different one.
      if (plan.target !== state.model) {
        lines.push(await initMachine(plan.target));
      }

      // 6. Mount + boot. Snapshots and peripheral media use the path-based
      // loader: it handles SZX banking and enables the +D/Interface 1 ROM before
      // mounting. Tapes/disks mount + arm the auto-boot trap like the UI.
      if (plan.boot === 'snapshot' || plan.boot === 'peripheral') {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        const tmp = path.join(CACHE_DIR, `library-${path.basename(innerName)}`);
        fs.writeFileSync(tmp, data);
        lines.push(await loadFileInto(activeSpectrum()!, tmp, 0));
      } else {
        lines.push(mountAndArm(activeSpectrum()!, data, innerName, plan.boot, plan.target));
      }

      // 7. With a frame budget, run the loader to a pass/fail verdict (tape/disk)
      //    using the end-of-tape oracle; a snapshot or ROM cartridge (both
      //    self-starting, no loader to poll) just runs the frames.
      if (frames > 0) {
        const spec = activeSpectrum()!;
        if (plan.boot === 'snapshot' || plan.boot === 'rom' || plan.boot === 'peripheral') {
          const ran = spec.runUntil(frames);
          lines.push(`Ran ${ran}/${frames} frame(s). PC=${h16(spec.cpu.pc)} T=${spec.cpu.tStates}`);
        } else {
          const v = runLoadVerdict(spec, frames);
          const tag = v.result === 'loaded' ? '✅ LOADED' : v.result === 'failed' ? '❌ FAILED' : '⏳ LOADING';
          lines.push(`Verdict: ${tag} after ${v.frames} frame(s)`);
          lines.push(`  ${v.detail}`);
        }
      } else if (plan.boot !== 'snapshot' && plan.boot !== 'rom' && plan.boot !== 'peripheral') {
        lines.push(`Boot trap armed (not yet fired). Pass frames=N to run to a verdict, or use 'run' + 'ocr' to debug.`);
      }
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'screenshot',
    {
      description: 'Capture the active machine display as a PNG file and return the file path.',
      inputSchema: {
        file: z.string().optional().describe('Output PNG path (default: <mcp cache>/screenshot.png)'),
      },
    },
    async ({ file }) => {
      let rgba: Uint8Array;
      let width: number;
      let height: number;

      const spec = activeSpectrum();
      if (spec) {
        // Re-render from the active screen bank: the headless run may have skipped
        // the bulk frame render, so the pixel buffer can be stale.
        spec.ula.renderFrame(spec.memory.screenBank, 0x4000);
        rgba = spec.ula.pixels;
        width = spec.ula.screenWidth;
        height = spec.ula.screenHeight;
      } else {
        rgba = state.spec.pixels;
        width = state.spec.frameWidth;
        height = state.spec.frameHeight;
      }

      let out = file ?? path.join(CACHE_DIR, 'screenshot.png');
      if (!/\.png$/i.test(out)) out += '.png';
      out = path.resolve(out);

      const png = encodePNG(rgba, width, height);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, png);
      return text(`Screenshot saved: ${out} (${width}×${height}, ${png.length} bytes)`);
    },
  );

  server.registerTool(
    'save',
    { description: 'Save current emulator state to a SZX snapshot file.', inputSchema: { file: z.string().describe('Output path for .szx file') } },
    async ({ file }) => {
      const spec = activeSpectrum();
      if (!spec) return text('SZX snapshot save is Spectrum-only.');
      if (!file.toLowerCase().endsWith('.szx')) file = file + '.szx';
      const ayRegs = spec.ay ? new Uint8Array(16).map((_, i) => spec.ay.readRegister(i)) : undefined;
      const ayCurrentReg = spec.ay?.selectedReg;
      const szxData = await saveSZX(
        spec.cpu,
        spec.memory,
        spec.ula.borderColor,
        spec.model,
        spec.contention.frameStartTStates,
        ayRegs,
        ayCurrentReg,
      );
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      fs.writeFileSync(file, szxData);
      return text(`Saved ${szxData.length} bytes → ${file}\nPC=${h16(spec.cpu.pc)}  Model=${state.model}  Bank=${spec.memory.currentBank}  ROM=${spec.memory.currentROM}`);
    },
  );

  server.registerTool(
    'disk_boot',
    { description: 'Boot from disk in drive A: on a +3. Runs 500 frames to reach the menu, then presses Enter on "Loader". If a file path is given, switches to +3, mounts the DSK, and boots it.', inputSchema: { file: z.string().optional().describe('Path to DSK file to load into drive A: (optional — omit if disk already mounted)') } },
    async ({ file }) => {
      if (activeCpc()) return text('disk_boot is +3-specific. On the CPC, use load to mount a .dsk, then type RUN"DISC or |CPM.');
      const lines: string[] = [];
      if (file) {
        if (state.model !== '+3') {
          lines.push(await initMachine('+3'));
        } else {
          state.spec.reset();
          lines.push('Machine reset (+3)');
        }
        const loadResult = await loadFileInto(activeSpectrum()!, file, 0);
        lines.push(loadResult);
        if (loadResult.startsWith('File not found') || loadResult.startsWith('Unsupported')) {
          return text(lines.join('\n'));
        }
      } else {
        if (state.model !== '+3') return text('disk_boot requires +3 model. Use model tool to switch, or pass a file path.');
        if (!activeFdc()!.getDiskImage(0)) return text('No disk in drive A:. Use load tool first, or pass a file path.');
      }
      const spec = activeSpectrum()!;
      spec.runUntil(500);
      spec.keyboard.handleKeyEvent('Enter', true);
      for (let i = 0; i < 5; i++) spec.tick();
      spec.keyboard.handleKeyEvent('Enter', false);
      spec.tick();
      lines.push('DOS BOOT initiated via Loader menu.');
      lines.push('Bootstrap loads to FE00h, enters at FE10h.');
      lines.push('Suggested: breakpoint FE10 → continue');
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'disk_trace',
    { description: 'Copy-protection trace helper: switch to +3, mount a DSK, boot to Loader, then arm a FE10h PC breakpoint and a 3FFDh FDC data port watchpoint so every FDC command byte breaks execution.', inputSchema: { file: z.string().describe('Path to DSK file to load into drive A:') } },
    async ({ file }) => {
      if (activeCpc()) return text('disk_trace is a +3 copy-protection helper, not applicable to the CPC.');
      const lines: string[] = [];
      if (state.model !== '+3') {
        lines.push(await initMachine('+3'));
      } else {
        state.spec.reset();
        lines.push('Machine reset (+3)');
      }
      const loadResult = await loadFileInto(activeSpectrum()!, file, 0);
      lines.push(loadResult);
      if (loadResult.startsWith('File not found') || loadResult.startsWith('Unsupported')) {
        return text(lines.join('\n'));
      }
      const spec = activeSpectrum()!;
      spec.runUntil(500);
      spec.keyboard.handleKeyEvent('Enter', true);
      for (let i = 0; i < 5; i++) spec.tick();
      spec.keyboard.handleKeyEvent('Enter', false);
      spec.tick();
      lines.push('Booted to Loader. Bootstrap now loading from disk...');
      spec.breakpoints.clear();
      spec.breakpoints.add(0xFE10);
      lines.push('Breakpoint: FE10h (bootstrap entry)');
      spec.portWatchpoints.clear();
      spec.portWatchpoints.add(0x3FFD);
      lines.push('Port watchpoint: 3FFDh (FDC data port — every IN/OUT breaks)');
      lines.push('');
      lines.push('Use "continue" to run until the next FDC access or FE10h.');
      lines.push('At each break: "registers" + "disassemble" to document the command.');
      lines.push('Clear port watchpoint with "delete_port_watchpoint 3FFD" once past the FDC setup.');
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'eject',
    { description: 'Eject a disk or tape.', inputSchema: {
      target: z.enum(['tape', 'disk']).describe('What to eject'),
      drive: z.enum(['0', '1', 'A', 'B']).default('0').describe('Drive unit (for disk only)'),
    } },
    async ({ target, drive }) => {
      if (target === 'tape') {
        const tape = state.spec.services.tape;
        if (!tape) return text(`${state.model.toUpperCase()} has no cassette deck.`);
        tape.eject();
        return text('Tape ejected');
      }
      const unit = (drive === '1' || drive === 'B') ? 1 : 0;
      const id = unit === 0 ? 'a' : 'b';
      const disks = state.spec.services.disks;
      if (!disks || !disks.drives.some(d => d.id === id)) {
        return text(`${state.model.toUpperCase()} has no drive ${unit === 0 ? 'A:' : 'B:'}.`);
      }
      disks.eject(id);
      return text(`Drive ${unit === 0 ? 'A' : 'B'}: ejected`);
    },
  );

  server.registerTool(
    'weak',
    { description: 'Mark disk sector(s) as weak (randomised on each read). If sector omitted, marks all sectors on the track.', inputSchema: {
      track: z.number().int().min(0).describe('Track number'),
      sector: z.number().int().min(0).optional().describe('Sector R value (omit for all sectors on track)'),
    } },
    async ({ track: wTrack, sector: wSector }) => {
      const fdc = activeFdc();
      if (!fdc) return text(`No uPD765A fitted on ${state.model.toUpperCase()} — disk inspection needs a +3 or a CPC.`);
      const dsk = fdc.getDiskImage(0);
      if (!dsk) return text('No disk in drive A:');
      const track = dsk.tracks[wTrack]?.[0];
      if (!track) return text(`Track ${wTrack} not found`);
      if (wSector !== undefined) {
        const idx = track.sectorMap.get(wSector);
        if (idx === undefined) return text(`Sector R=${wSector} not found on track ${wTrack}`);
        track.sectors[idx].st2 |= 0x20;
        return text(`Marked track ${wTrack} sector R=${wSector} as weak (st2=0x${h8(track.sectors[idx].st2)})`);
      }
      for (const s of track.sectors) s.st2 |= 0x20;
      return text(`Marked all ${track.sectors.length} sectors on track ${wTrack} as weak`);
    },
  );

  server.registerTool(
    'disk_geometry',
    { description: 'Show geometry of the mounted disk image: format, tracks, sides, protection, and a per-track sector summary.', inputSchema: { drive: z.number().int().min(0).max(1).default(0).describe('Drive number (0=A, 1=B)') } },
    async ({ drive }) => {
      const fdc = activeFdc();
      if (!fdc) return text(`No uPD765A fitted on ${state.model.toUpperCase()} — disk inspection needs a +3 or a CPC.`);
      const dsk = fdc.getDiskImage(drive);
      if (!dsk) return text(`No disk in drive ${drive === 0 ? 'A' : 'B'}:`);
      const lines: string[] = [];
      lines.push(`Format: ${dsk.format}  Tracks: ${dsk.numTracks}  Sides: ${dsk.numSides}`);
      if (dsk.diskFormat) lines.push(`Disk format: ${dsk.diskFormat}`);
      if (dsk.protection) lines.push(`Protection: ${dsk.protection}`);
      lines.push('');
      lines.push('Trk Side  Sectors  IDs');
      for (let t = 0; t < dsk.tracks.length; t++) {
        for (let s = 0; s < dsk.numSides; s++) {
          const track = dsk.tracks[t]?.[s];
          if (!track) continue;
          const ids = track.sectors.map(sec => `R${sec.r}(N${sec.n}${sec.st1 || sec.st2 ? ' st1=' + h8(sec.st1) + ' st2=' + h8(sec.st2) : ''})`).join(' ');
          lines.push(`${String(t).padStart(3)}    ${s}     ${String(track.sectors.length).padStart(2)}     ${ids}`);
        }
      }
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'track_geometry',
    { description: 'Show detailed geometry of a single track: gap3, filler, and full CHRN + status + size for each sector.', inputSchema: {
      track: z.number().int().min(0).describe('Track (cylinder) number'),
      side: z.number().int().min(0).max(1).default(0).describe('Side/head (0 or 1)'),
      drive: z.number().int().min(0).max(1).default(0).describe('Drive number (0=A, 1=B)'),
    } },
    async ({ track: tNum, side, drive }) => {
      const fdc = activeFdc();
      if (!fdc) return text(`No uPD765A fitted on ${state.model.toUpperCase()} — disk inspection needs a +3 or a CPC.`);
      const dsk = fdc.getDiskImage(drive);
      if (!dsk) return text(`No disk in drive ${drive === 0 ? 'A' : 'B'}:`);
      const track = dsk.tracks[tNum]?.[side];
      if (!track) return text(`Track ${tNum} side ${side} not found`);
      const lines: string[] = [];
      lines.push(`Track ${tNum}  Side ${side}  Sectors: ${track.sectors.length}  Gap3: ${h8(track.gap3)}  Filler: ${h8(track.filler)}`);
      lines.push('');
      lines.push('  #  C  H   R   N   ST1  ST2  DataSize');
      for (let i = 0; i < track.sectors.length; i++) {
        const s = track.sectors[i];
        lines.push(`${String(i).padStart(3)}  ${h8(s.c)}  ${h8(s.h)}  ${h8(s.r)}  ${h8(s.n)}   ${h8(s.st1)}   ${h8(s.st2)}   ${s.data.length}`);
      }
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'sector_read',
    { description: 'Read raw sector data from a mounted disk image. Returns a hex dump of the sector contents.', inputSchema: {
      track: z.number().int().min(0).describe('Track (cylinder) number'),
      sector: z.number().int().min(0).describe('Sector R value'),
      side: z.number().int().min(0).max(1).default(0).describe('Side/head (0 or 1)'),
      drive: z.number().int().min(0).max(1).default(0).describe('Drive number (0=A, 1=B)'),
      offset: z.number().int().min(0).default(0).describe('Byte offset within sector to start from'),
      length: z.number().int().positive().optional().describe('Number of bytes to dump (default: entire sector)'),
    } },
    async ({ track: tNum, sector: sR, side, drive, offset, length }) => {
      const fdc = activeFdc();
      if (!fdc) return text(`No uPD765A fitted on ${state.model.toUpperCase()} — disk inspection needs a +3 or a CPC.`);
      const dsk = fdc.getDiskImage(drive);
      if (!dsk) return text(`No disk in drive ${drive === 0 ? 'A' : 'B'}:`);
      const track = dsk.tracks[tNum]?.[side];
      if (!track) return text(`Track ${tNum} side ${side} not found`);
      const idx = track.sectorMap.get(sR);
      if (idx === undefined) return text(`Sector R=${sR} not found on track ${tNum} side ${side}`);
      const sec = track.sectors[idx];
      const start = Math.min(offset, sec.data.length);
      const len = length !== undefined ? Math.min(length, sec.data.length - start) : sec.data.length - start;
      if (len === 0) return text(`Sector R=${sR} has no data from offset ${offset}`);
      const header =
        `Track ${tNum}  Side ${side}  Sector R=${h8(sR)}  C=${h8(sec.c)} H=${h8(sec.h)} N=${h8(sec.n)}  ST1=${h8(sec.st1)} ST2=${h8(sec.st2)}  Size=${sec.data.length}\n`;
      const dump = formatHexDump(a => sec.data[a], start, len);
      return text(header + '\n' + dump);
    },
  );

  server.registerTool(
    'fdc_log',
    { description: 'Read (and optionally clear) the FDC log ring buffer. Returns up to the last 2000 FDC log lines.', inputSchema: { clear: z.boolean().default(false).describe('Clear the buffer after reading') } },
    async ({ clear }) => {
      const lines = [...fdcLog];
      if (clear) fdcLog.length = 0;
      if (lines.length === 0) return text('FDC log is empty');
      return text(`${lines.length} FDC log line(s):\n\n${lines.join('\n')}`);
    },
  );
}
