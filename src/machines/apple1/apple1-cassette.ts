import { AudioCassette } from '@/machines/shared/audio-cassette.ts';

/**
 * Apple Cassette Interface tape deck. The comparator output is read by the CPU
 * from bit 7 of `$C081`.
 */
export class Apple1Cassette extends AudioCassette {}
