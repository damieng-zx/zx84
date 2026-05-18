import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { variantForModel, variantLabel } from '../../src/peripherals/multiface.ts';
import { h8, h16 } from '../hex.ts';
import { state } from '../state.ts';
import { text } from '../format.ts';
import { fetchMFRom, fetchVTXRom } from '../rom-fetch.ts';

export function register(server: McpServer): void {
  server.tool(
    'multiface',
    'Enable/disable Multiface peripheral, load its ROM, or press the NMI button. Actions: "on", "off", "nmi", "status".',
    { action: z.enum(['on', 'off', 'nmi', 'status']).describe('Action to perform') },
    async ({ action }) => {
      const spec = state.spec;
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

  server.tool(
    'vtx5000',
    'Enable/disable the VTX-5000 Viewdata/Prestel modem (48K only). Loads the ROM overlay and resets the machine.',
    { action: z.enum(['on', 'off', 'status']).describe('Action to perform') },
    async ({ action }) => {
      const spec = state.spec;
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

  server.tool(
    'ocr',
    'OCR the screen bitmap. mode: auto (default) | 32x24 | 51x24 (CP/M Plus) | 64x24 (Tasword).',
    { mode: z.enum(['auto', '32x24', '51x24', '64x24']).optional().describe('Cell grid (default: auto-detect).') },
    async ({ mode }) => text(state.spec.ocrScreenForMcp(mode ?? 'auto')),
  );
}
