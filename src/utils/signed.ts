/** Reinterpret an unsigned byte (0–255) as a signed 8-bit value (−128…127). */
export function signed8(v: number): number { return v < 128 ? v : v - 256; }
