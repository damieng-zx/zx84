import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { variantForModel, variantLabel } from '../../src/machines/spectrum/peripherals/multiface.ts';
import { isPlusDCapable, isBetaDiskCapable } from '../../src/models.ts';
import { hex8 as h8, hex16 as h16 } from '../../src/utils/hex.ts';
import { state } from '../state.ts';
import { activeMtx, activeSpectrum } from '../concrete.ts';
import { text } from '../format.ts';
import { fetchMFRom, fetchVTXRom, fetchPlusDRom, fetchBetaDiskRom } from '../rom-fetch.ts';

export function register(server: McpServer): void {
  server.registerTool(
    'multiface',
    { description: 'Enable/disable Multiface peripheral, load its ROM, or press the NMI button. Actions: "on", "off", "nmi", "status".', inputSchema: { action: z.enum(['on', 'off', 'nmi', 'status']).describe('Action to perform') } },
    async ({ action }) => {
      const spec = activeSpectrum();
      if (!spec) return text('Multiface is a Spectrum peripheral — not available on the CPC.');
      const mf = spec.multiface;

      if (action === 'status') {
        return text(
          `Multiface: ${mf.enabled ? 'ON' : 'OFF'}  variant=${mf.variant}  ` +
          `romLoaded=${mf.romLoaded}  pagedIn=${mf.pagedIn}\n` +
          `Model: ${spec.model}  → ${variantLabel(variantForModel(spec.model))}`
        );
      }

      if (action === 'off') {
        if (mf.pagedIn) {
          mf.pageOut(spec.memory);
          spec.memory.applyBanking();
        }
        mf.enabled = false;
        return text('Multiface disabled');
      }

      if (action === 'on') {
        const variant = variantForModel(spec.model);
        mf.variant = variant;
        mf.enabled = true;
        if (!mf.romLoaded) {
          try {
            const data = await fetchMFRom(variant);
            mf.loadROM(data);
            return text(`Multiface enabled: ${variantLabel(variant)} ROM loaded (${data.length} bytes, byte@66=${h8(data[0x66])})`);
          } catch (err) {
            mf.enabled = false;
            return text(`Failed to load ${variantLabel(variant)} ROM: ${err}`);
          }
        }
        return text(`Multiface enabled: ${variantLabel(variant)} (ROM already loaded)`);
      }

      // action === 'nmi'
      if (!mf.enabled) return text('Multiface not enabled. Use action=on first.');
      if (!mf.romLoaded) return text('Multiface ROM not loaded. Use action=on first.');

      const prevPC = spec.cpu.pc;
      mf.pressButton(spec.memory, spec.cpu, spec.memory.slot0Bank);
      return text(
        `NMI triggered. PC: ${h16(prevPC)} → ${h16(spec.cpu.pc)}\n` +
        `pagedIn=${mf.pagedIn}  [0x66]=${h8(spec.memory.readByte(0x66))}  [0x67]=${h8(spec.memory.readByte(0x67))}  [0x68..6A]=${h8(spec.memory.readByte(0x68))}${h8(spec.memory.readByte(0x69))}${h8(spec.memory.readByte(0x6A))}\n` +
        `SP=${h16(spec.cpu.sp)}  IFF1=${spec.cpu.iff1}  IFF2=${spec.cpu.iff2}`
      );
    },
  );

  server.registerTool(
    'vtx5000',
    { description: 'Enable/disable the VTX-5000 Viewdata/Prestel modem (48K only). Loads the ROM overlay and resets the machine.', inputSchema: { action: z.enum(['on', 'off', 'status']).describe('Action to perform') } },
    async ({ action }) => {
      const spec = activeSpectrum();
      if (!spec) return text('The VTX-5000 is a Spectrum peripheral — not available on the CPC.');
      const vtx = spec.vtx5000;

      if (action === 'status') {
        return text(
          `VTX-5000: ${vtx.enabled ? 'ON' : 'OFF'}  romLoaded=${vtx.romLoaded}  romSize=${vtx.romSize}\n` +
          `8251: vtxRomPaged=${vtx.vtxRomPaged}  status=${h8(vtx.readStatus())}  dsr=${vtx.dsr}\n` +
          `Model: ${spec.model}  (only supported on 48K)\n` +
          `[0x0000]=${h8(spec.memory.readByte(0x0000))}  [0x1FFF]=${h8(spec.memory.readByte(0x1FFF))}  [0x2000]=${h8(spec.memory.readByte(0x2000))}`
        );
      }

      if (action === 'off') {
        vtx.enabled = false;
        spec.memory.applyBanking();
        spec.cpu.pc = 0;
        return text('VTX-5000 disabled. Memory restored to Spectrum ROM. PC=0000');
      }

      // action === 'on'
      if (spec.model !== '48k') return text('VTX-5000 only supported on 48K model. Use model tool to switch.');
      vtx.enabled = true;
      if (!vtx.romLoaded) {
        try {
          const data = await fetchVTXRom();
          vtx.loadROM(data);
        } catch (err) {
          vtx.enabled = false;
          return text(`Failed to load VTX-5000 ROM: ${err}`);
        }
      }
      // reset() will call vtx.applyROM() internally since enabled+romLoaded are both true
      spec.reset();
      return text(
        `VTX-5000 enabled (ROM: ${vtx.romSize} bytes). Machine reset.\n` +
        `[0x0000]=${h8(spec.memory.readByte(0x0000))}  [0x1FFF]=${h8(spec.memory.readByte(0x1FFF))}  [0x2000]=${h8(spec.memory.readByte(0x2000))}\n` +
        `PC=${h16(spec.cpu.pc)}`
      );
    },
  );

  server.registerTool(
    'plusd',
    { description: 'Enable/disable the MGT +D disk interface (48K/128K/+2). Loads the G+DOS ROM and resets so the +D boots. Actions: "on", "off", "status".', inputSchema: { action: z.enum(['on', 'off', 'status']).describe('Action to perform') } },
    async ({ action }) => {
      const spec = activeSpectrum();
      if (!spec) return text('The +D is a Spectrum peripheral — not available on the CPC.');
      const pd = spec.mgtPlusD;

      if (action === 'status') {
        return text(
          `MGT +D: ${pd.enabled ? 'ON' : 'OFF'}  romLoaded=${pd.romLoaded}  pagedIn=${pd.pagedIn}\n` +
          `WD1772: track=${pd.fdc.currentTrack} drive=${pd.fdc.currentUnit} side=${pd.fdc.side} status=${h8(pd.fdc.readStatus())}\n` +
          `Model: ${spec.model}\n` +
          `[0x0000]=${h8(spec.memory.readByte(0x0000))} [0x1FFF]=${h8(spec.memory.readByte(0x1FFF))} [0x2000]=${h8(spec.memory.readByte(0x2000))}  PC=${h16(spec.cpu.pc)}`
        );
      }

      if (action === 'off') {
        if (pd.pagedIn) pd.pageOut(spec.memory);
        pd.enabled = false;
        spec.reset();
        return text('MGT +D disabled. Machine reset.');
      }

      // action === 'on'
      if (!isPlusDCapable(spec.model)) return text(`+D supported on 48k/128k/+2 only (current: ${spec.model}). Use the model tool to switch.`);
      pd.enabled = true;
      if (!pd.romLoaded) {
        try {
          const data = await fetchPlusDRom();
          pd.loadROM(data);
        } catch (err) {
          pd.enabled = false;
          return text(`Failed to load +D ROM: ${err}`);
        }
      }
      spec.reset(); // pages the +D shadow ROM in so G+DOS boots
      return text(
        `MGT +D enabled (ROM ${pd.rom.length} bytes). Machine reset.\n` +
        `pagedIn=${pd.pagedIn}  [0x0000]=${h8(spec.memory.readByte(0x0000))} [0x1FFF]=${h8(spec.memory.readByte(0x1FFF))}  PC=${h16(spec.cpu.pc)}`
      );
    },
  );

  server.registerTool(
    'betadisk',
    { description: 'Enable/disable the Beta Disk interface / TR-DOS (48K/128K/+2). Loads the 16KB TR-DOS ROM; it maps itself in via the 0x3Dxx trap. Mutually exclusive with the +D and Interface 1. Actions: "on", "off", "status".', inputSchema: { action: z.enum(['on', 'off', 'status']).describe('Action to perform') } },
    async ({ action }) => {
      const spec = activeSpectrum();
      if (!spec) return text('The Beta Disk is a Spectrum peripheral — not available on the CPC.');
      const bd = spec.betaDisk;

      if (action === 'status') {
        return text(
          `Beta Disk: ${bd.enabled ? 'ON' : 'OFF'}  romLoaded=${bd.romLoaded}  pagedIn=${bd.pagedIn}\n` +
          `WD1793: track=${bd.fdc.currentTrack} drive=${bd.fdc.currentUnit} side=${bd.fdc.side} status=${h8(bd.fdc.readStatus())}\n` +
          `Model: ${spec.model}  PC=${h16(spec.cpu.pc)}`
        );
      }

      if (action === 'off') {
        if (bd.pagedIn) bd.pageOut(spec.memory);
        bd.enabled = false;
        spec.reset();
        return text('Beta Disk disabled. Machine reset.');
      }

      // action === 'on'
      if (!isBetaDiskCapable(spec.model)) return text(`Beta Disk supported on 48k/128k/+2 only (current: ${spec.model}). Use the model tool to switch.`);
      // Mutually exclusive with the +D / Interface 1 (all overlay slot 0).
      if (spec.mgtPlusD.pagedIn) spec.mgtPlusD.pageOut(spec.memory);
      spec.mgtPlusD.enabled = false;
      if (spec.interface1.pagedIn) spec.interface1.pageOut(spec.memory);
      spec.interface1.enabled = false;
      bd.enabled = true;
      if (!bd.romLoaded) {
        try {
          const data = await fetchBetaDiskRom();
          bd.loadROM(data);
        } catch (err) {
          bd.enabled = false;
          return text(`Failed to load TR-DOS ROM: ${err}`);
        }
      }
      spec.reset(); // TR-DOS pages in on the 0x3Dxx trap once BASIC enters it
      return text(
        `Beta Disk enabled (TR-DOS ROM ${bd.rom.length} bytes). Machine reset.\n` +
        `Enter TR-DOS with: RANDOMIZE USR 15616\n` +
        `pagedIn=${bd.pagedIn}  PC=${h16(spec.cpu.pc)}`
      );
    },
  );

  server.registerTool(
    'mtx80column',
    {
      description: 'Enable, disable, or inspect the Memotech FDX 6845-based 80-column display.',
      inputSchema: {
        action: z.enum(['on', 'off', 'status']).describe('Action to perform'),
      },
    },
    async ({ action }) => {
      const mtx = activeMtx();
      if (!mtx) return text('The FDX 80-column display is a Memotech MTX peripheral.');
      if (action === 'status') {
        return text(
          `FDX 80-column display: ${mtx.column80.enabled ? 'ON' : 'OFF'}  ` +
          `${mtx.frameWidth}x${mtx.frameHeight}  ` +
          `CRTC R12:R13=${h8(mtx.column80.crtc.regs[12])}:${h8(mtx.column80.crtc.regs[13])}`,
        );
      }
      mtx.set80ColumnEnabled(action === 'on');
      return text(`FDX 80-column display ${action === 'on' ? 'enabled' : 'disabled'}.`);
    },
  );

  server.registerTool(
    'ocr',
    { description: 'Read text from the active display. ZX80/ZX81 decode their 32x24 display file; bitmap machines use OCR. mode: auto (default) | 32x24 | 51x24 (CP/M Plus) | 64x24 (Tasword).', inputSchema: { mode: z.enum(['auto', '32x24', '51x24', '64x24']).optional().describe('Cell grid (default: auto-detect).') } },
    async ({ mode }) => text(state.spec.services.debug.ocr(mode ?? 'auto')),
  );
}
