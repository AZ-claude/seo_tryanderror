import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, no I/L/O/U

function encodeTime(ms: number, length: number): string {
  let out = '';
  let value = ms;
  for (let i = length - 1; i >= 0; i--) {
    out = ENCODING[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ENCODING[bytes[i]! % 32];
  }
  return out;
}

/** ULID-shaped id: 10-char timestamp + 16-char randomness, lexicographically sortable by creation time. */
export function generateId(now: number = Date.now()): string {
  return `${encodeTime(now, 10)}${encodeRandom(16)}`;
}
