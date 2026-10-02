/** Generates opaque identifiers. Injected so behavior tests are deterministic. */
export interface IdGenerator {
  next(): string;
}

const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

/**
 * 128 random bits as 26 lowercase base32hex characters. The alphabet and length
 * also satisfy Google Calendar's client-supplied event ID rules, so an operation
 * can derive a stable provider ID for idempotent creates.
 */
export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32HEX[(value << (5 - bits)) & 31];
  return out;
}

export const randomIds: IdGenerator = { next: randomId };
