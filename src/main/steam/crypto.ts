import { createDecipheriv } from 'node:crypto'

// Steam encrypts depot chunks, and a manifest's file names when it says so, with the depot's
// 32-byte AES key: the first 16 bytes are the IV, itself encrypted with AES-256-ECB, and the rest
// is AES-256-CBC with PKCS#7 padding (@doctormckay/steam-crypto's symmetricEncrypt).

const KEY_BYTES = 32
const BLOCK_BYTES = 16

export class SteamCryptoError extends Error {}

/** Decrypts `data` with `key`. Throws a SteamCryptoError on anything that can't have come from
 * the key: a wrong length, or padding that doesn't check out. */
export function symmetricDecrypt(data: Uint8Array, key: Uint8Array): Buffer {
  if (key.length !== KEY_BYTES) throw new SteamCryptoError('A depot key is 32 bytes')
  // An IV block and at least one block of padded data.
  if (data.length < 2 * BLOCK_BYTES || data.length % BLOCK_BYTES !== 0) {
    throw new SteamCryptoError(`Encrypted data can't be ${data.length} bytes long`)
  }
  const ivDecipher = createDecipheriv('aes-256-ecb', key, null).setAutoPadding(false)
  const iv = Buffer.concat([ivDecipher.update(data.subarray(0, BLOCK_BYTES)), ivDecipher.final()])
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  try {
    return Buffer.concat([decipher.update(data.subarray(BLOCK_BYTES)), decipher.final()])
  } catch {
    // OpenSSL's "bad decrypt": the padding is wrong, which a wrong key almost always causes.
    throw new SteamCryptoError('The data could not be decrypted with this depot key')
  }
}

/** A manifest's encrypted file name: base64 of the encrypted, NUL-terminated name. */
export function decryptFilename(encoded: string, key: Uint8Array): string {
  const plain = symmetricDecrypt(Buffer.from(encoded, 'base64'), key)
  const end = plain.indexOf(0)
  return plain.subarray(0, end < 0 ? plain.length : end).toString('utf8')
}
