const encoder = new TextEncoder();

/** Compares secrets without leaking the position of the first mismatch. */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  // Hash first so inputs of different lengths still compare in constant time.
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}
