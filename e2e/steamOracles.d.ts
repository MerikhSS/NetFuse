// The libraries Steam test fixtures are built with, and the pure Steam modules are checked
// against. None of them is on NetFuse's data path; they have no types of their own.

declare module '@doctormckay/steam-crypto' {
  export function symmetricEncrypt(input: Buffer, key: Buffer, iv?: Buffer): Buffer
  export function symmetricDecrypt(input: Buffer, key: Buffer): Buffer
}

declare module 'lzma' {
  /** Synchronous without a callback: an LZMA "alone" stream (properties, uint64 size, data). */
  export function compress(data: Uint8Array | number[], mode: number): number[]
  /** Synchronous without a callback. A string when the output happens to read as UTF-8. */
  export function decompress(data: Uint8Array | number[]): string | number[]
}

declare module 'steam-user/components/cdn_compression.js' {
  export function unzip(data: Buffer): Promise<Buffer>
}

declare module 'steam-user/components/content_manifest.js' {
  export function parse(data: Buffer): {
    files: {
      filename: string
      size: string
      flags: number
      linktarget?: string
      chunks: { sha: string; offset: string; cb_original: number; cb_compressed: number }[]
    }[]
    depot_id: number
    gid_manifest: string
    filenames_encrypted: boolean
  }
}

declare module 'steam-user/protobufs/generated/_load.js' {
  interface Message {
    encode(value: object): { finish(): Uint8Array }
  }
  const Schema: {
    ContentManifestPayload: Message
    ContentManifestMetadata: Message
    ContentManifestSignature: Message
  }
  export = Schema
}
