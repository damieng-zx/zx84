/**
 * Family-blind register panel — the fallback layout for any CPU family that
 * has not (yet) shipped a bespoke one of its own.
 *
 * It renders whatever `RegisterSnapshot` reports: the register list in the
 * family's own order, its own flag letters, PC/SP and the interrupt state. That
 * makes a newly added CPU family debuggable from its first commit, before
 * anyone hand-lays-out a panel for it (see Z80Registers.tsx for what a tailored
 * one looks like).
 *
 * Like every register panel it builds its DOM once — on the first snapshot,
 * since the register *list* is fixed per family — and then writes text nodes
 * directly, so Solid never re-renders it.
 */

import { createEffect, onMount, onCleanup } from 'solid-js';
import { machine } from '@/shell/context.ts';
import { regsRev } from '@/state/debug-state.ts';
import type { RegisterSnapshot } from '@/machines/machine.ts';
import { set8, set16, setStr, makeLabel, makeSlot, makeFlag } from './dom.ts';

/** Registers per row — four 16-bit pairs fit the debugger pane's width. */
const PER_ROW = 4;

export function GenericRegisters() {
  let ref!: HTMLPreElement;

  onMount(() => {
    const pre = ref;
    const t = (str: string) => document.createTextNode(str);

    // Built from the first snapshot: the register/flag *list* is fixed per CPU
    // family, only the values move.
    let built = false;
    const regSlots: { slot: Text; width: 8 | 16; prev: number }[] = [];
    const flagEls: { update: (on: boolean) => void }[] = [];
    let pcSlot!: Text, spSlot!: Text, tpfSlot!: Text, iffSlot!: Text, imSlot!: Text, haltSlot!: Text;
    let pPC = -1, pSP = -1, pTPF = '', pIFF = '', pIM = '', pHALT = '';

    function build(snap: RegisterSnapshot) {
      const width = Math.max(...snap.regs.map(r => r.name.length), 3);
      snap.regs.forEach((r, i) => {
        const slot = makeSlot();
        regSlots.push({ slot, width: r.width, prev: -1 });
        const last = i === snap.regs.length - 1;
        pre.append(
          makeLabel(r.name.padEnd(width), `${r.name} (${r.width}-bit)`), t(' '), slot,
          t(i % PER_ROW === PER_ROW - 1 || last ? '\n' : '   '),
        );
      });

      for (const f of snap.flags) {
        const flag = makeFlag(f.name, `Flag ${f.name}`);
        flagEls.push(flag);
        pre.append(flag.el, t(' '));
      }
      if (snap.flags.length > 0) pre.append(t('\n'));

      pcSlot = makeSlot(); spSlot = makeSlot(); tpfSlot = makeSlot();
      iffSlot = makeSlot(); imSlot = makeSlot(); haltSlot = makeSlot();
      pre.append(
        makeLabel('PC', 'Program counter'), t('  '), pcSlot, t('  '),
        makeLabel('SP', 'Stack pointer'), t('  '), spSlot, t('   '),
        makeLabel('T/F', 'T-states per frame'), t(' '), tpfSlot, t('   '),
        iffSlot, t('  '), makeLabel('IM', 'Interrupt mode'), imSlot, haltSlot,
      );
    }

    createEffect(() => {
      regsRev(); // track the signal
      if (!machine) return;
      const snap = machine.services.debug.regs();
      if (!built) { build(snap); built = true; }

      snap.regs.forEach((r, i) => {
        const s = regSlots[i];
        if (!s) return;
        s.prev = s.width === 16 ? set16(s.slot, r.value, s.prev) : set8(s.slot, r.value, s.prev);
      });
      snap.flags.forEach((f, i) => flagEls[i]?.update(f.set));

      pPC = set16(pcSlot, snap.pc, pPC);
      pSP = set16(spSlot, snap.sp, pSP);
      pTPF = setStr(tpfSlot, machine.tStatesPerFrame.toLocaleString(), pTPF);
      pIFF = setStr(iffSlot, snap.iff1 ? 'EI' : 'DI', pIFF);
      pIM = setStr(imSlot, String(snap.im), pIM);
      pHALT = setStr(haltSlot, snap.halted ? ' HALT' : '', pHALT);
    });

    onCleanup(() => {
      pre.textContent = '';
    });
  });

  return <pre id="regs-output" ref={ref} />;
}
