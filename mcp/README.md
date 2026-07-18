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

Supported startup models are `16k`, `48k`, `128k`, `+2`, `+2A`, `+3`,
`cpc464`, `cpc664`, `cpc6128`, `einstein`, and `hx-10`. The default is `48k`.
System ROM pages come from the machine registry, are fetched through the shared
ROM source loader, and are cached under `mcp/.cache/`.

## Model Support

The generic tools work through the `Machine` SPI and support every model where
the relevant service exists: execution, register inspection, memory access,
disassembly, breakpoints/watchpoints, stepping, and OCR.

Some tools are intentionally hardware-specific:

- Spectrum: tape/snapshot loading, ZXTL/full/port-I/O tracing, library loading,
  Multiface, VTX-5000, +D, Beta Disk, microdrives, and +3 boot helpers.
- CPC: `.dsk` mounting, built-in uPD765A disk inspection, CPC OCR, and PNG
  screenshots.
- Einstein and MSX: generic execution/debug/OCR tools; their media capabilities
  are exposed only where their machine services support them.

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
| `model` | `target` (optional) | Show or switch the active model. |

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

Spectrum key names include `a`-`z`, `0`-`9`, `enter`, `space`, `shift`,
`sym`, `backspace`, cursor keys, `capslock`, and `escape`.

### Media, Library, And Screenshots

| Tool | Parameters | Description |
| --- | --- | --- |
| `load` | `file`, `drive` | Load supported local media. Spectrum accepts tape, snapshot, disk, microdrive, and Beta Disk formats; CPC accepts `.dsk`. |
| `library` | `title`, `file`, `id`, `frames`, `refresh` | Spectrum-only exact-title library load, mount, and optional load verdict. |
| `screenshot` | `file` (optional) | Write the current Spectrum or CPC display to PNG. |
| `save` | `file` | Save a Spectrum `.szx` snapshot. |
| `eject` | `target`, `drive` | Eject a Spectrum tape or an FDC disk. |
| `disk_boot` | `file` (optional) | Spectrum +3 Loader-menu boot helper. |
| `disk_trace` | `file` | +3 copy-protection helper: boot, arm `FE10`, and watch `3FFD`. |

### Tracing And OCR

| Tool | Parameters | Description |
| --- | --- | --- |
| `trace` | `mode`: `full`, `portio`, or `zxtl` | Start Spectrum execution tracing. |
| `stop_trace` | | Stop tracing. Large full/port-I/O traces are written to a file. |
| `trace_read` | `from`, `to` | Read stored ZXTL trace lines. |
| `frame_trace` | | Spectrum-only one-frame instruction/contention/VRAM trace written to a file. |
| `ocr` | `mode` (optional) | Read screen text through the active machine OCR engine. Spectrum supports `auto`, `32x24`, `51x24`, and `64x24`. |

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
image, symbols, FDC log wiring, and traps. Generic tools consume
`machine.services`; concrete MCP bench tools narrow only in `mcp/concrete.ts`.

Tool registrations live under `mcp/tools/`. The root helpers cover formatting,
ROM/media loading, catalog access, PNG output, traps, FDC logging, and ZXTL
storage. Hex output uses the shared `src/utils/hex.ts`; there is no MCP-local
hex formatter.
