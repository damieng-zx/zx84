/**
 * emulator.ts — compatibility shim, NOT an import hub.
 *
 * The former ~2,400-line god-module was split into `src/shell/*` (lifecycle,
 * media, settings, rom, context) with the reactive stores in `src/state/*`.
 * Production code imports those directly; this façade survives only because
 * `frame-bridge.ts` still imports its ~30 collaborators from here and its unit
 * test (`tests/frame-bridge.test.ts`) mocks THIS module wholesale — repointing
 * the bridge would force that mock (and `emulator.test.ts`) to be rewritten for
 * no architectural gain. New code must import shell actions from `@/shell/*`
 * and state signals from `@/state/*`.
 */

export * from '@/shell/context.ts';
export * from '@/shell/lifecycle.ts';
export * from '@/shell/media.ts';
export * from '@/shell/settings.ts';
export * from '@/shell/rom.ts';

export * from '@/state/machine-state.ts';
export * from '@/state/tape-state.ts';
export * from '@/state/disk-state.ts';
export * from '@/state/debug-state.ts';
export * from '@/state/activity-state.ts';
