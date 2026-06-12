import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { saveSZX } from '../../src/snapshot/szx.ts';
import { h8, h16 } from '../hex.ts';
import { state, initMachine, activeSpectrum, activeCpc } from '../state.ts';
import { text, formatHexDump } from '../format.ts';
import { loadFileInto, mountAndArm, runLoadVerdict } from '../loader.ts';
import { fdcLog } from '../fdc-log.ts';
import { parseDSK } from '../../src/plus3/dsk.ts';
import { unzip } from '../../src/snapshot/zip.ts';
import { CACHE_DIR } from '../rom-fetch.ts';
import { findGames, suggestTitles, fileUrls, planLoad, gameNeeds, basename } from '../catalog.ts';

export function register(server: McpServer): void {
  server.registerTool(
    'load',
    { description: 'Load a file into the emulator. Supports TAP, TZX, SNA, Z80, DSK formats. For DSK, optional drive unit (0/A or 1/B).', inputSchema: {
      file: z.string().describe('Path to file (TAP/TZX/SNA/Z80/DSK)'),
      drive: z.enum(['0', '1', 'A', 'B']).default('0').describe('Drive unit for DSK files'),
    } },
    async ({ file, drive }) => {
      const diskUnit = (drive === '1' || drive === 'B') ? 1 : 0;
      const cpc = activeCpc();
      if (cpc) {
        if (!fs.existsSync(file)) return text(`File not found: ${file}`);
        if (!/\.dsk$/i.test(file)) return text('On the CPC, load accepts .dsk disk images only.');
        const image = parseDSK(new Uint8Array(fs.readFileSync(file)));
        cpc.loadDisk(image, diskUnit);
        return text(`DSK mounted in drive ${diskUnit === 0 ? 'A' : 'B'}: ${path.basename(file)}`);
      }
      return text(await loadFileInto(activeSpectrum()!, file, diskUnit));
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
      if (activeCpc()) return text('library is Spectrum-only — switch to a Spectrum model first (CPC titles are not in this catalog).');

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
          const list = games.map(g => `  id=${g.id}  ${g.title} (${g.year ?? '?'})  ${g.publisher || '—'}  [needs ${gameNeeds(g)}]`).join('\n');
          return text(`${games.length} titles match "${title}" exactly — re-run with id=:\n${list}`);
        }
        game = picked;
      }

      // 2. Plan the load from the current model (same decision the UI makes).
      const plan = planLoad(game, state.model);
      if (!plan) return text(`"${game.title}" has no playable tape/disk/snapshot in the catalog.`);

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

      // 6. Mount + boot. Snapshots restore running state and self-select their
      //    model, so route them through the path-based loader (SZX banking etc.);
      //    tapes/disks mount + arm the auto-boot trap like the UI's one-click play.
      if (plan.boot === 'snapshot') {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        const tmp = path.join(CACHE_DIR, `library-${path.basename(innerName)}`);
        fs.writeFileSync(tmp, data);
        lines.push(await loadFileInto(activeSpectrum()!, tmp, 0));
      } else {
        lines.push(mountAndArm(activeSpectrum()!, data, innerName, plan.boot, plan.target));
      }

      // 7. With a frame budget, run the loader to a pass/fail verdict (tape/disk)
      //    using the end-of-tape oracle; a snapshot just runs the frames.
      if (frames > 0) {
        const spec = activeSpectrum()!;
        if (plan.boot === 'snapshot') {
          const ran = spec.runUntil(frames);
          lines.push(`Ran ${ran}/${frames} frame(s). PC=${h16(spec.cpu.pc)} T=${spec.cpu.tStates}`);
        } else {
          const v = runLoadVerdict(spec, frames);
          const tag = v.result === 'loaded' ? '✅ LOADED' : v.result === 'failed' ? '❌ FAILED' : '⏳ LOADING';
          lines.push(`Verdict: ${tag} after ${v.frames} frame(s)`);
          lines.push(`  ${v.detail}`);
        }
      } else if (plan.boot !== 'snapshot') {
        lines.push(`Boot trap armed (not yet fired). Pass frames=N to run to a verdict, or use 'run' + 'ocr' to debug.`);
      }
      return text(lines.join('\n'));
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
        if (!state.spec.fdc.getDiskImage(0)) return text('No disk in drive A:. Use load tool first, or pass a file path.');
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
        const s = activeSpectrum();
        if (!s) return text('No tape on the CPC.');
        s.tape.load(new Uint8Array(0));
        return text('Tape ejected');
      }
      const unit = (drive === '1' || drive === 'B') ? 1 : 0;
      state.spec.fdc.ejectDisk(unit);
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
      const dsk = state.spec.fdc.getDiskImage(0);
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
      const dsk = state.spec.fdc.getDiskImage(drive);
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
      const dsk = state.spec.fdc.getDiskImage(drive);
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
      const dsk = state.spec.fdc.getDiskImage(drive);
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
