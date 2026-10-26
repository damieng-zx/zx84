import { AudioCassette } from '@/machines/shared/audio-cassette.ts';

/**
 * Apple II cassette deck. The CPU samples the comparator output on bit 7 of
 * $C060.
 */
export class Apple2Cassette extends AudioCassette {}
