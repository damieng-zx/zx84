# ZX84 MCP Server

Persistent Model Context Protocol server for driving ZX84 machines from an MCP
client. It runs a headless machine, keeps state between tool calls, and exposes
execution, media, debugging, disk, OCR, and machine-specific bench tools.

## Setup

The project `.mcp.json` already registers the server:

```json
{
  "mcpServers": {
    "zx84": {
      "command": "cmd",
      "args": ["/c", "npx", "tsx", "mcp/server.ts"]
    }
  }
}
```

Run it directly with:

```text
npm run mcp -- --model 48k
```

Supported startup models are derived from the machine registry and include
`zx80`, `zx81`, `16k`, `48k`, `128k`, `+2`, `+2A`, `+3`, `cpc464`, `cpc664`,
`cpc6128`, `cpc6128plus`, `gx4000`, `einstein`, `hx-10`, `mtx500`, and
`mtx512`. The default is `48k`.
System ROM pages come from the machine registry, are fetched through the shared
ROM source loader, and are cached under `mcp/.cache/`.

## Model Support

The generic tools work through the `Machine` SPI and support every model where
the relevant service exists: execution, register inspection, memory access,
disassembly, breakpoints/watchpoints, stepping, and OCR.

Some tools are intentionally hardware-specific:

- Spectrum: tape/snapshot loading (auto-enabling the +D / Interface 1 / Beta
  Disk ROMs), ZXTL/full/port-I/O tracing, library loading, Multiface, VTX-5000,
  +D, Beta Disk, microdrives, and +3 boot helpers.
- CPC, MSX, MTX, Einstein, ZX80/ZX81: media loads route through the machine's own
  `MediaService` (CPC `.dsk/.hfe/.scp/.cdt/.sna/.cpr`, MSX `.rom/.cas`,
  MTX `.mtx/.mfloppy`, Einstein `.dsk/.hfe/.scp`, ZX80/ZX81 program files). CPC adds
  built-in uPD765A disk inspection, CPC OCR, and PNG screenshots.
- ZX80/ZX81 additionally: model-constrained ZXDB library loading, 1KB/16KB
  RAM selection, ZX81 UDG and WRX hi-res hardware selection, and display-file
  OCR.
- MSX/MTX/Einstein media capabilities are exposed exactly where their machine
  services support them.

Use `model` to switch machines. Switching always creates a fresh machine.

## Tool Reference

### Execution And State

| Tool | Parameters | Description |
| --- | --- | --- |
| `run` | `frames` (default `1`) | Run frames; reports a breakpoint or watchpoint hit. |
| `step_frame` | | Run exactly one frame. |
| `step` | `count` (default `1`) | Step Z80 instructions with disassembly and registers. |
| `continue` | `max_frames` (default `5000`) | Run until a breakpoint, watchpoint, trap, or reset trap hits. |
| `registers` | | Display CPU and machine state. |
| `set_register` | `register`, `value` | Set A/F/AF, B/C/BC, D/E/DE, H/L/HL, SP, PC, IX, or IY. |
| `model` | `target`, `ram16k`, `udgRam`, `udg128Ram`, `wrxHires`, `memotechHrg`, `quickSilvaHrg` (optional) | Show or switch the active model; `ram16k` selects ZX80/ZX81 16KB RAM, while the graphics options select one mutually exclusive ZX81 hi-res device. |

### Memory And Symbols

| Tool | Parameters | Description |
| --- | --- | --- |
| `read_memory` | `address`, `length` (default `64`), `bank` (optional) | Hex dump mapped memory, or an explicit Spectrum RAM bank. |
| `write_memory` | `address`, `hex_bytes`, `bank` (optional) | Write bytes to mapped memory or a Spectrum RAM bank. |
| `find` | `hex_bytes` | Search the 64KB address space; returns up to 64 matches. |
| `disassemble` | `address` (default PC), `lines` (default `16`) | Z80 disassembly with byte display. |
| `symbols_load` | `file` | Load a symbol file into the MCP symbol table. |
| `symbols` | `query`, `limit` | Find/list loaded symbols. |

### Breakpoints, Watchpoints, And Traps

| Tool | Parameters | Description |
| --- | --- | --- |
| `breakpoint` / `delete_breakpoint` | `address` (optional) | Add/list or remove/clear PC breakpoints. Multiple addresses are accepted. |
| `port_watchpoint` / `delete_port_watchpoint` | `port` (optional) | Add/list or remove/clear IN/OUT port watchpoints. |
| `memory_watchpoint` | `address` (optional), `length`, `mode` | Watch reads, writes, or both. Omit address to list. |
| `delete_memory_watchpoint` | `address` (optional) | Remove by start address, or clear all. |
| `reset_trap` | `enabled` (optional) | Arm (`true`), disarm (`false`), or inspect the ROM-reset trap. |
| `trap` | `address` (optional), `action`, `cond_c`, `label`, `responses` | Add/list PC traps. Actions are `log`, `break`, and `respond`. |
| `trap_delete` | `address` (optional), `cond_c` | Remove matching traps or clear all. |
| `trap_log` | `from`, `to`, `clear` | Read the trap log buffer. |
| `trap_respond` | `address`, `cond_c`, `responses` | Queue responses for a respond-mode trap. |

`log` traps automatically decode CP/M BDOS calls at `0005`.

### Ports And Input

| Tool | Parameters | Description |
| --- | --- | --- |
| `port_out` | `port`, `value` | Write an I/O port. |
| `port_in` | `port` | Read an I/O port. |
| `key` | `name`, `frames` (default `5`) | Hold a key or combination such as `shift+2` or `sym+p`. |
| `type` | `text` | Type text; backtick-delimited control names are supported. |

Common key names include `a`-`z`, `0`-`9`, `enter`, `space`, `shift`,
`backspace`, cursor keys, and `escape`. ZX80/ZX81 also accept `period`;
Spectrum additionally supports `sym`, `capslock`, and symbol-shift combos.

### Media, Library, And Screenshots

| Tool | Parameters | Description |
| --- | --- | --- |
| `load` | `file`, `drive` | Load media from a local path or HTTP(S) URL. Spectrum uses its bench path (auto-enables peripheral ROMs); every other machine routes through its own MediaService. ZIPs unwrap to a sole compatible file. |
| `library` | `title`, `file`, `id`, `frames`, `refresh` | Exact-title library load. ZX80 and ZX81 searches stay strictly within the active model and apply catalog RAM and hi-res hardware requirements before launch. |
| `screenshot` | `file` (optional) | Write the active machine display to PNG. |
| `save` | `file` | Save a Spectrum `.szx` snapshot. |
| `eject` | `target`, `drive` | Eject a tape (any deck machine) or a disk (`a`/`b` where fitted). |
| `disk_boot` | `file` (optional) | Spectrum +3 Loader-menu boot helper; the optional DSK may be a local path or HTTP(S) URL. |
| `disk_trace` | `file` | +3 copy-protection helper for a local or HTTP(S) DSK: boot, arm `FE10`, and watch `3FFD`. |

### Tracing And OCR

| Tool | Parameters | Description |
| --- | --- | --- |
| `trace` | `mode`: `full`, `portio`, or `zxtl` | Start Spectrum execution tracing (other machines have no trace engine yet — the tool declines). |
| `stop_trace` | | Stop tracing. Large full/port-I/O traces are written to a file. |
| `trace_read` | `from`, `to` | Read stored ZXTL trace lines. |
| `frame_trace` | | Spectrum-only one-frame instruction/contention/VRAM trace written to a file. |
| `ocr` | `mode` (optional) | Read screen text through the active machine OCR engine. ZX80/ZX81 return their 32×24 display-file text. |

### Disk Inspection And Protection

These use the active +3 or CPC uPD765A where fitted.

| Tool | Parameters | Description |
| --- | --- | --- |
| `disk_geometry` | `drive` | Mounted disk geometry and sector summary. |
| `track_geometry` | `track`, `side`, `drive` | Detailed track and CHRN/status information. |
| `sector_read` | `track`, `sector`, `side`, `drive`, `offset`, `length` | Hex dump raw sector data. |
| `weak` | `track`, `sector` (optional) | Mark one sector or a whole track weak. |
| `fdc_log` | `clear` | Read/clear the FDC log ring buffer. |

### Spectrum Peripherals

| Tool | Parameters | Description |
| --- | --- | --- |
| `multiface` | `action`: `on`, `off`, `nmi`, `status` | Control MF1/MF128/MF3 and trigger NMI. |
| `vtx5000` | `action`: `on`, `off`, `status` | Control the 48K VTX-5000 Viewdata modem. |
| `plusd` | `action`: `on`, `off`, `status` | Control the MGT +D interface. |
| `betadisk` | `action`: `on`, `off`, `status` | Control Beta Disk/TR-DOS. |

### Memotech MTX Peripherals

| Tool | Parameters | Description |
| --- | --- | --- |
| `mtx80column` | `action`: `on`, `off`, `status` | Control the FDX 6845-based 80-column display and select it as the active monitor. |
| `mtx512kram` | `action`: `on`, `off`, `status` | Control the 512 KiB SDX/FDX RAM expansion (576 KiB total on an MTX512); the bundled CP/M disk exposes it as type-51 drive F:. |
| `mtxcpm` | `action`: `on`, `off`, `status` | Configure the MTX512 CP/M profile, fetch its public Type-07 system disk when needed, and reset. |

## Address Values

Address and register-value strings are parsed by the shared MCP parser:

- `0x1234` and `$1234` are explicitly hexadecimal.
- All other address/value strings are hexadecimal, including digit-only values
  such as `4000`.
- Identifier-shaped strings resolve through the loaded symbol table. Prefer
  `0x` or `$` when a token could be either a symbol or hexadecimal text.

## Architecture

`mcp/server.ts` creates one persistent, headless `Machine` through the machine
registry. `mcp/state.ts` remains machine-blind and owns the active handle, ROM
image, symbols, FDC log wiring, and traps; `mcp/host.ts` is the attached
`MachineHost` (a cross-model snapshot rebuild re-runs `initMachine`, and the
mount is replayed onto the replacement machine). Generic tools consume
`machine.services`; concrete MCP bench tools narrow only in `mcp/concrete.ts`
(which also holds the per-family headless launch knobs).

Tool registrations live under `mcp/tools/`. The root helpers cover formatting,
ROM fetching, catalog access, PNG output, traps, FDC logging, and ZXTL storage;
`mcp/loader.ts` is the generic MediaService + ZIP mount path, while
`mcp/spectrum-loader.ts` is the Spectrum bench loader (peripheral-ROM arming,
boot traps, load verdicts). Hex output uses the shared `src/utils/hex.ts`;
there is no MCP-local hex formatter.
