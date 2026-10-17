import type { HostKeyEvent, InputService, MouseSink } from '@/machines/machine.ts';
import type { ElectronMachine } from '../electron-machine.ts';

export class ElectronInputService implements InputService {
  constructor(private readonly machine: ElectronMachine) {}

  keyDown(event: HostKeyEvent): boolean {
    // The BREAK key has no matrix cell: it resets the CPU. With SHIFT held
    // the OS also boots a disc or cartridge.
    if (event.code === 'Pause' || event.code === 'F12') {
      if (event.shift) this.machine.bootWithShift(); else this.machine.breakReset();
      return true;
    }
    return this.machine.keyboard.handleEvent(event, true);
  }

  keyUp(event: HostKeyEvent): boolean {
    if (event.code === 'Pause' || event.code === 'F12') return true;
    return this.machine.keyboard.handleEvent(event, false);
  }

  releaseAll(): void {
    this.machine.keyboard.reset();
  }

  readonly mouse: MouseSink | null = null;
}
