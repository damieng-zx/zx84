/**
 * Headless start() contract — the MCP server and Node tests run machines
 * with display=null and drive frames manually via tick()/runUntil(). The
 * environment has no AudioContext and no requestAnimationFrame, so start()
 * must mark the machine running without touching either. Machine services
 * (media mounts, snapshot apply) call stop()/start() around their mutations,
 * so this is what makes those services usable headless.
 */

import { describe, it, expect } from 'vitest';
import { Zx8xMachine } from '@/machines/zx8x/zx8x-machine.ts';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { serializeDSK } from '@/media/floppy/dsk.ts';
import { blankMgtDisk } from '@/media/floppy/mgt-image.ts';

describe('BaseMachine.start() headless (no AudioContext / rAF)', () => {
  it('resolves, marks running, and schedules no frame loop', async () => {
    // Sanity: the test env really is headless — no stubs anywhere.
    expect(typeof AudioContext).toBe('undefined');
    expect(typeof requestAnimationFrame).toBe('undefined');

    const m = new Zx8xMachine('zx80', null);
    await m.start();
    expect((m as unknown as { running: boolean }).running).toBe(true);
    expect((m as unknown as { rafId: number }).rafId).toBe(0);

    m.stop();
    expect((m as unknown as { running: boolean }).running).toBe(false);
    m.destroy();
  });

  it('a media service that stops/starts around a mount works headless', async () => {
    // CpcMediaService.mount wraps the disk insert in c.stop()/c.start();
    // pre-fix that start() rejected on `new AudioContext()`.
    const c = new CpcMachine('cpc6128', null);
    const r = await c.services.media.mount(serializeDSK(blankMgtDisk(40, 1)), 'game.dsk');
    expect(r.ok).toBe(true);
    expect(c.fdc.getDiskImage(0)).not.toBeNull();
    c.destroy();
  });
});
