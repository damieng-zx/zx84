/**
 * The beam-debugging MCP tools driven through their registered handlers:
 * `run` to a raster position, `trap` log rows, `memory_watchpoint` and
 * `port_watchpoint` log mode, and `beam_log` / `beam_log_read` — on the Atari,
 * and refusing cleanly on a machine with no beam position.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { state } from '../../mcp/state.ts';
import { traps, trapLog } from '../../mcp/traps.ts';
import { register as registerMachine } from '../../mcp/tools/machine.ts';
import { register as registerBreakpoints } from '../../mcp/tools/breakpoints.ts';
import { register as registerTraps } from '../../mcp/tools/traps.ts';
import { register as registerBeam } from '../../mcp/tools/beam.ts';
import { register as registerChips } from '../../mcp/tools/chips.ts';
import { installTrapHook } from '../../mcp/traps.ts';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';
import { ATARI_OS_SIZE } from '@/machines/atari/models.ts';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';

type Result = { content: { type: 'text'; text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

function capture(...registers: Array<(s: never) => void>): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const fakeServer = {
    registerTool: (name: string, _schema: unknown, handler: Handler) => { handlers.set(name, handler); },
  };
  for (const r of registers) r(fakeServer as never);
  return handlers;
}

const tools = capture(registerMachine, registerBreakpoints, registerTraps, registerBeam, registerChips);
const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> =>
  (await tools.get(name)!(args)).content[0].text;

/** $E000: LDX #0 ; STA WSYNC ; STX COLBK ; INX ; JMP $E002 — one line per trip. */
function bootAtari(): AtariMachine {
  const rom = new Uint8Array(ATARI_OS_SIZE);
  rom.set([0xa2, 0x00, 0x8d, 0x0a, 0xd4, 0x8e, 0x1a, 0xd0, 0xe8, 0x4c, 0x02, 0xe0], 0x800);
  rom[0x27fc] = 0x00; rom[0x27fd] = 0xe0;
  const m = new AtariMachine('atari800', null, 'pal');
  m.services.roms.installSystemRom(rom);
  m.reset();
  return m;
}

const READ_DEFAULTS = { offset: 0, limit: 200, t: false, rel: 'frame', format: 'text', file: false };

describe('MCP beam tools on the Atari', () => {
  beforeEach(() => {
    traps.clear();
    trapLog.length = 0;
    state.model = 'atari800';
    state.spec?.destroy();
    state.spec = bootAtari();
    installTrapHook(state.spec);
  });

  it('run until_line stops mid-frame at the raster position, and again a frame later', async () => {
    const first = await call('run', { frames: 1, until_line: 31 });
    expect(first).toMatch(/Stopped at frame 0, line 31, cycle 0 /);
    expect(first).toMatch(/Paused mid-frame/);
    const second = await call('run', { frames: 1, until_line: 31 });
    expect(second).toMatch(/Stopped at frame 1, line 31, cycle 0 /);
    // An absolute frame, and a cycle in the line.
    const third = await call('run', { frames: 1, until_line: 100, until_cycle: 50, until_frame: 4 });
    expect(third).toMatch(/Stopped at frame 4, line 101, cycle 0 /); // WSYNC-halted: next boundary is line 101
    // The machine is resumable: a normal run finishes the frame.
    const done = await call('run', { frames: 1 });
    expect(done).toMatch(/Ran 1 frame/);
    expect(state.spec.frameNumber).toBe(5);
  });

  it('run refuses nonsense arguments and unsupported machines', async () => {
    expect(await call('run', { frames: 1, until_cycle: 5 })).toMatch(/need until_line/);
    expect(await call('run', { frames: 1, until_line: 9999 })).toMatch(/below 312/);
    expect(await call('run', { frames: 1, until_line: 5, until_cycle: 200 })).toMatch(/below 114/);
    state.model = 'cpc6128';
    state.spec = new CpcMachine('cpc6128', null);
    expect(await call('run', { frames: 1, until_line: 5 })).toMatch(/not supported on this machine \(CPC6128\)/);
  });

  it('a log trap gives pc rows with the label and registers, read back by beam_log_read', async () => {
    const set = await call('trap', { address: 'E005 E008', action: 'log', label: '', regs: true });
    expect(set).toBe('Trap set at E005, E008: log');
    await call('run', { frames: 1 });
    const out = await call('beam_log_read', { ...READ_DEFAULTS, limit: 4 });
    expect(out).toMatch(/Beam log: \d+ entries held/);
    expect(out).toMatch(/display starts at t=912 \(line 8, cycle 0\)/);
    expect(out).toMatch(/Atari: cycle 0 = the missile DMA slot/);
    // frame line cycle pc label [regs]
    expect(out).toMatch(/^0 1 0 E005 trap@E005 \[A=00 X=00 Y=00 SP=FD P=/m);
    // E008 is the INX: X has not changed yet. The next trip round, it has.
    expect(out).toMatch(/^0 1 4 E008 trap@E008 \[A=00 X=00 /m);
    expect(out).toMatch(/^0 2 0 E005 trap@E005 \[A=00 X=01 /m);
    const kinds = await call('beam_log_read', { ...READ_DEFAULTS, kinds: 'io' });
    expect(kinds).toMatch(/No matching entries/);
    const json = JSON.parse((await call('beam_log_read', { ...READ_DEFAULTS, limit: 1, format: 'json' })).split('\n').filter(l => l.startsWith('{'))[0]);
    expect(json).toMatchObject({ kind: 1, frame: 0, pc: 0xE005 });
  });

  it('the trap text log carries the beam position', async () => {
    await call('trap', { address: 'E005', action: 'log', label: 'rainbow', regs: false });
    await call('run', { frames: 1 });
    expect(trapLog[0]).toMatch(/^\[E005\] rainbow .* B=0\/\d+\/\d+$/);
  });

  it('memory_watchpoint log mode records writes; the listing, beam_log and display-relative output work', async () => {
    const set = await call('memory_watchpoint', {
      address: 'D01A', length: 1, mode: 'write', action: 'log', values: '0A,0B,0C', frames: '0-0', lines: '8-20',
    });
    expect(set).toMatch(/Memory watchpoint set: D01A \(write, log\)/);
    expect(await call('memory_watchpoint', {})).toMatch(/D01A write \(log\) values=0A,0B,0C/);
    await call('run', { frames: 2 });
    const out = await call('beam_log_read', { ...READ_DEFAULTS, kinds: 'io', rel: 'display', t: true });
    expect(out).toMatch(/line 0 = first display line/);
    // Frame 0 only, lines 8-20 only, and only the writes of $0A-$0C (X counts
    // up one a line from line 0): display-relative lines 2-4.
    const rows = out.split('\n').filter(r => /^\d+ -?\d+ \d+ t=\d+ E005 D01A/.test(r));
    expect(rows.length).toBe(3);
    for (const r of rows) {
      const [frame, line] = r.split(' ').map(Number);
      expect(frame).toBe(0);
      expect(line).toBeGreaterThanOrEqual(0);
      expect(line).toBeLessThanOrEqual(12);
    }
    expect(await call('beam_log', { action: 'status' })).toMatch(/Beam log armed: \d+ entries held/);
    expect(await call('beam_log', { action: 'clear' })).toBe('Beam log cleared.');
    expect(await call('beam_log_read', READ_DEFAULTS)).toMatch(/No matching entries/);
    expect(await call('beam_log', { action: 'stop' })).toMatch(/stopped and discarded/);
    expect(await call('beam_log_read', READ_DEFAULTS)).toBe('Beam log: not armed.');
  });
});

describe('MCP interrupt and view tools', () => {
  /** $E000: LDA #$40 ; STA NMIEN ; loop: JMP loop. NMI -> $E100: INC $80 ; RTI. */
  function bootVbi(): AtariMachine {
    const rom = new Uint8Array(ATARI_OS_SIZE);
    rom.set([0xa9, 0x40, 0x8d, 0x0e, 0xd4, 0x4c, 0x05, 0xe0], 0x800);
    rom.set([0xe6, 0x80, 0x40], 0x900);
    rom[0x27fa] = 0x00; rom[0x27fb] = 0xe1;
    rom[0x27fc] = 0x00; rom[0x27fd] = 0xe0;
    const m = new AtariMachine('atari800', null, 'pal');
    m.services.roms.installSystemRom(rom);
    m.reset();
    return m;
  }

  beforeEach(() => {
    traps.clear();
    trapLog.length = 0;
    state.model = 'atari800';
    state.spec?.destroy();
    state.spec = bootVbi();
    installTrapHook(state.spec);
  });

  it('interrupt_log arms the log and beam_log_read shows entries, ends and stats', async () => {
    const armed = await call('interrupt_log', { action: 'start', atari: false, dma: false });
    expect(armed).toMatch(/Interrupt logging armed/);
    await call('run', { frames: 4 });
    const rows = await call('beam_log_read', { ...READ_DEFAULTS, kinds: 'irq' });
    // Entered on the vertical-blank line, 16 cycles in (the NMI point, the rest
    // of the JMP in progress and the 7-cycle entry); from = the interrupted JMP.
    // (This synthetic OS never runs CLI, so the interrupted code has the I flag set from reset: the
    // log says the deferred VBI would be skipped.)
    expect(rows).toMatch(/^0 248 16 NMI enter VBI handler=E100 from=E005 depth=0 \[deferred VBI skipped: interrupted code had I set\]$/m);
    expect(rows).toMatch(/^0 248 27 NMI end handler=E100 to=E005 cost=11 cycles depth=0 \(entered 0 248 16\)$/m);
    const stats = await call('beam_log_read', { ...READ_DEFAULTS, stats: true });
    expect(stats).toMatch(/NMI VBI\s+n=\s*4\s+start line min\/avg\/max 248\.0\/248\.0\/248\.0/);
    expect(await call('beam_log', { action: 'status' })).toMatch(/Also logging: interrupts/);
    await call('interrupt_log', { action: 'stop' });
    expect(state.spec.interruptLogging).toBe(false);
  });

  it('spans time a part of the handler by address, and a *vector is dereferenced', async () => {
    // Make a pointer at $0222 to the handler's RTI, as the OS keeps VVBLKI.
    state.spec.memory.writeByte(0x0222, 0x02);
    state.spec.memory.writeByte(0x0223, 0xE1);
    const armed = await call('interrupt_log', {
      action: 'start', atari: false, dma: false,
      spans: [{ name: 'body', from: 'E100', to: '*0222' }],
    });
    expect(armed).toMatch(/span body: E100 -> E102/);
    await call('run', { frames: 3 });
    const stats = await call('beam_log_read', { ...READ_DEFAULTS, stats: true });
    // INC zp is 5 cycles from the handler's first instruction to its RTI.
    expect(stats).toMatch(/span body\s+n=\s*3\s+start line min\/avg\/max 248\.0\/248\.0\/248\.0\s+end line 248\.0\/248\.0\/248\.0\s+cost cycles 5\/5\/5/);
  });

  it('atari:true logs the display list, and a pointer write in the visible area is flagged', async () => {
    const dl = [0x70, 0x70, 0x70, 0x42, 0x00, 0x40, 0x41, 0x00, 0x06];
    dl.forEach((b, i) => state.spec.memory.writeByte(0x0600 + i, b));
    const a = state.spec as AtariMachine;
    a.antic.writeReg(0xD402, 0x00);
    a.antic.writeReg(0xD403, 0x06);
    a.antic.writeReg(0xD400, 0x22);
    await call('interrupt_log', { action: 'start', atari: true, dma: false });
    await call('run', { frames: 1 });
    const rows = await call('beam_log_read', { ...READ_DEFAULTS, kinds: 'dl', limit: 5 });
    expect(rows).toMatch(/^0 8 0 dl fetch at=0600 blank 8$/m);
    expect(rows).toMatch(/^0 32 0 dl fetch at=0603 mode 2 LMS 4000$/m);
    expect(rows).toMatch(/^0 40 0 dl fetch at=0606 JVB 0600$/m);
  });

  it('pairs reports how far apart two logged addresses were', async () => {
    // Trap the NMI handler's two instructions: E100 and E102.
    await call('trap', { address: 'E100 E102', action: 'log', label: '', regs: false });
    await call('run', { frames: 3 });
    const out = await call('beam_log_read', { ...READ_DEFAULTS, pairs: 'E100-E102' });
    expect(out).toMatch(/E100 -> E102: 3 pair\(s\): \+0 line\(s\) x3/);
  });

  it('summary needs eff and says so; with eff it lists the renderer\'s decisions', async () => {
    await call('beam_log', { action: 'start' });
    expect(await call('beam_log_read', { ...READ_DEFAULTS, summary: true })).toMatch(/No decisions recorded/);
    const none = await call('beam_log', { action: 'start', eff: true });
    expect(none).toMatch(/Beam log armed/);
    expect((state.spec as AtariMachine).effLogging).toBe(true);
    await call('beam_log', { action: 'stop' });
    expect((state.spec as AtariMachine).effLogging).toBe(false);
  });

  it('summary lists colour changes and filters by register', async () => {
    // (This machine is the NMI test's: it never writes a colour, so use the rainbow.)
    state.spec.destroy();
    state.spec = bootAtari();
    installTrapHook(state.spec);
    await call('beam_log', { action: 'start', eff: true });
    await call('run', { frames: 1 });
    const colbk = await call('beam_log_read', { ...READ_DEFAULTS, summary: true, regs: 'colbk' });
    expect(colbk).toMatch(/What the renderer and ANTIC decided/);
    // COLBK ignores bit 0, so the rainbow's INX changes it every second line.
    const m = /^0 \d+ 3 COLBK=([0-9A-F]{2}) \(was ([0-9A-F]{2})\) written at cycle 3, drawn from the first pixel of the line$/m.exec(colbk);
    expect(m).not.toBeNull();
    expect(parseInt(m![1], 16) - parseInt(m![2], 16)).toBe(2);
    expect(await call('beam_log_read', { ...READ_DEFAULTS, summary: true, regs: 'hscrol' })).toMatch(/No decisions recorded/);
    expect(await call('beam_log_read', { ...READ_DEFAULTS, summary: true, regs: 'colour', limit: 1 })).toMatch(/0\.\.0 of \d+/);
  });

  it('refuses interrupt_log where it is not supported', async () => {
    state.model = 'cpc6128';
    state.spec = new CpcMachine('cpc6128', null);
    expect(await call('interrupt_log', { action: 'start', atari: false, dma: false })).toMatch(/not supported on this machine \(CPC6128\)/);
  });
});

describe('MCP chip_state', () => {
  beforeEach(() => {
    state.model = 'atari800';
    state.spec?.destroy();
    const m = bootAtari();
    state.spec = m;
    const dl = [0x70, 0x70, 0x70, 0x42, 0x00, 0x40, 0x12, 0x41, 0x00, 0x06];
    dl.forEach((b, i) => m.memory.writeByte(0x0600 + i, b));
    m.antic.writeReg(0xD402, 0x00);
    m.antic.writeReg(0xD403, 0x06);
    m.antic.writeReg(0xD400, 0x22);
    m.gtia.writeReg(0xD01A, 0x94);
  });

  it('lists the chips, picks some by name, and dumps all of them with none', async () => {
    const list = await call('chip_state', { chip: 'list' });
    expect(list).toMatch(/^antic\s+ANTIC/m);
    expect(list).toMatch(/^gtia\s+GTIA/m);
    expect(list).toMatch(/^pokey\s+POKEY/m);
    expect(list).toMatch(/^pia\s+PIA/m);
    const one = await call('chip_state', { chip: 'GTIA' });
    expect(one).toMatch(/^== gtia:/);
    expect(one).toMatch(/COLBK\s+D01A = 94/);
    expect(one).not.toMatch(/== antic/);
    const two = await call('chip_state', { chip: 'antic, pia' });
    expect(two).toMatch(/== antic:[\s\S]*== pia:/);
    const all = await call('chip_state', {});
    for (const n of ['antic', 'gtia', 'pokey', 'pia']) expect(all).toContain(`== ${n}:`);
  });

  it('says which chips exist when a name is wrong', async () => {
    expect(await call('chip_state', { chip: 'sid' })).toBe('Unknown chip: sid. This machine has: antic, gtia, pokey, pia.');
  });

  it('decodes the display list ANTIC would run', async () => {
    const out = await call('chip_state', { chip: 'antic' });
    expect(out).toMatch(/DMACTL  D400 = 22  playfield normal, .*display-list DMA on/);
    expect(out).toMatch(/DLISTL\/H D402\/3 = 0600/);
    expect(out).toMatch(/0600  70 {11}blank 8   lines 8-15/);
    expect(out).toMatch(/0603  42 00 40     mode 2 LMS 4000   lines 32-39/);
    expect(out).toMatch(/0606  12 {11}mode 2 HSCROL   lines 40-47/);
    expect(out).toMatch(/0607  41 00 06     JVB 0600/);
  });

  it('reads the chips without the side effects of a bus read', async () => {
    const m = state.spec as AtariMachine;
    m.memWatchpoints.push({ start: 0xD000, end: 0xD4FF, mode: 'rw' });
    m.pia.cr[0] = 0x80 | 0x04;      // port A's C1 interrupt flag set, data register selected
    await call('chip_state', {});
    expect(m.memWatchHit).toBeNull();
    expect(m.pia.cr[0] & 0x80).toBe(0x80); // the flag a data-register read would have cleared
  });

  it('shows how each POKEY timer is clocked and when it next underflows', async () => {
    const m = state.spec as AtariMachine;
    const idle = await call('chip_state', { chip: 'pokey' });
    expect(idle).toMatch(/Timer 1: AUDF 00, clock 64 kHz, not counting/);
    // Timer 1 at 1.79 MHz, AUDF 99, started: it underflows after about 100 cycles.
    m.pokey.writeReg(0xD20F, 0x03);   // SKCTL: out of initialisation
    m.pokey.writeReg(0xD208, 0x40);   // AUDCTL: channel 1 at 1.79 MHz
    m.pokey.writeReg(0xD200, 99);     // AUDF1
    m.pokey.writeReg(0xD209, 0);      // STIMER
    const running = await call('chip_state', { chip: 'pokey' });
    const t1 = /Timer 1: AUDF 63, clock 1\.79 MHz, next underflow in (\d+) CPU cycles/.exec(running);
    expect(t1).not.toBeNull();
    expect(Number(t1![1])).toBeGreaterThan(90);
    expect(Number(t1![1])).toBeLessThan(110);
    // STIMER starts all four; the others keep their own clock.
    expect(running).toMatch(/Timer 2: AUDF 00, clock 64 kHz, next underflow in \d+ CPU cycles/);
    // And a dump changes nothing: the same number twice.
    expect(await call('chip_state', { chip: 'pokey' })).toBe(running);
  });

  it('says so on a machine without chips', async () => {
    state.model = 'cpc6128';
    state.spec = new CpcMachine('cpc6128', null);
    expect(await call('chip_state', {})).toMatch(/not supported on this machine yet \(CPC6128\)/);
  });
});

describe('MCP beam tools on a machine with no beam position', () => {
  beforeEach(() => {
    state.model = 'cpc6128';
    state.spec?.destroy();
    state.spec = new CpcMachine('cpc6128', null);
  });

  it('the log modes and readers say so', async () => {
    const no = /no beam position/;
    expect(await call('memory_watchpoint', { address: '4000', length: 1, mode: 'rw', action: 'log' })).toMatch(no);
    expect(await call('port_watchpoint', { port: 'FE', action: 'log' })).toMatch(no);
    expect(await call('beam_log', { action: 'start' })).toMatch(no);
    expect(await call('beam_log_read', READ_DEFAULTS)).toMatch(no);
    // A break-mode watchpoint is unaffected.
    expect(await call('memory_watchpoint', { address: '4000', length: 1, mode: 'rw', action: 'break' })).toMatch(/Memory watchpoint set: 4000 \(rw\)/);
  });
});

describe('MCP run to a raster position on the Spectrum', () => {
  beforeEach(() => {
    state.model = 'zx48k';
    state.spec?.destroy();
    const s = new Spectrum('zx48k', null);
    s.loadROM(new Uint8Array(16384));
    // LD A,0 ; loop: OUT (254),A ; INC A ; AND 7 ; JR loop
    [0x3e, 0x00, 0xd3, 0xfe, 0x3c, 0xe6, 0x07, 0x18, 0xf9].forEach((b, i) => s.memory.writeByte(0x8000 + i, b));
    s.cpu.pc = 0x8000;
    state.spec = s;
  });

  it('stops mid-frame at the line, a frame later the second time, and a normal run finishes the frame', async () => {
    const first = await call('run', { frames: 1, until_line: 64 });
    expect(first).toMatch(/Stopped at frame 0, line 64, cycle \d+ /);
    expect(first).toMatch(/Paused mid-frame/);
    const second = await call('run', { frames: 1, until_line: 64 });
    expect(second).toMatch(/Stopped at frame 1, line 64, cycle \d+ /);
    expect(await call('run', { frames: 1 })).toMatch(/Ran 1 frame/);
    expect(state.spec.frameNumber).toBe(2);
    expect(await call('run', { frames: 1, until_line: 400 })).toMatch(/until_line must be below 312/);
  });
});
