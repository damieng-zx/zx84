import type { HostKeyEvent, InputService, MouseSink } from '@/machines/machine.ts';
import type { ElectronMachine } from '../electron-machine.ts';

export class ElectronInputService implements InputService {
  constructor(private readonly machine: ElectronMachine) {}

  keyDown(event: HostKeyEvent): boolean {
    // The BREAK key has no matrix cell: it resets the CPU.
    if (event.code === 'Pause' || event.code === 'F12') {
      this.machine.breakReset();
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
