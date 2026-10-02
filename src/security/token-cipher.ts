import { ConfigError } from "../env";

/**
 * Authenticated encryption for stored OAuth tokens (AES-256-GCM). The key lives
 * in a Worker secret, never in D1. Each ciphertext is bound to its owner and
 * purpose via additional authenticated data, so a token copied into another
 * user's row, or into another column, fails to decrypt.
 *
 * Format: `v1.<base64 iv>.<base64 ciphertext+tag>`; the version prefix allows
 * key rotation later.
 */
export interface TokenCipher {
  encrypt(plaintext: string, context: TokenContext): Promise<string>;
  /** Throws if the value was tampered with, moved, or encrypted under another key. */
  decrypt(sealed: string, context: TokenContext): Promise<string>;
}

export interface TokenContext {
  userId: string;
  purpose: "refresh_token" | "access_token";
}

const VERSION = "v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function createTokenCipher(base64Key: string): Promise<TokenCipher> {
  let raw: Uint8Array;
  try {
    raw = fromBase64(base64Key);
  } catch {
    throw new ConfigError("TOKEN_ENCRYPTION_KEY must be base64");
  }
  if (raw.byteLength !== 32) throw new ConfigError("TOKEN_ENCRYPTION_KEY must be 32 bytes");
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);

  const aad = (context: TokenContext) =>
    encoder.encode(`${VERSION}|${context.purpose}|${context.userId}`);

  return {
    async encrypt(plaintext, context) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad(context) },
        key,
        encoder.encode(plaintext),
      );
      return `${VERSION}.${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`;
    },
    async decrypt(sealed, context) {
      const [version, iv, data] = sealed.split(".");
      if (version !== VERSION || !iv || !data) throw new Error("Unsupported token format");
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64(iv), additionalData: aad(context) },
        key,
        fromBase64(data),
      );
      return decoder.decode(plain);
    },
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
