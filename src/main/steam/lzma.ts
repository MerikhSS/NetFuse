// An LZMA decoder (the LZMA1 "alone" stream inside Steam's VZip chunks), after Igor Pavlov's
// LzmaSpec.cpp. steam-user decodes with the `lzma` package, a translation from Java that does
// about 2.5 MB/s, far below what one network delivers; this one works on typed arrays straight
// into the output.
//
// A chunk says how big it decompresses to, so the whole output is one buffer of that size and
// doubles as the dictionary: a match can only reach back into what has been written, never past
// the start, and nothing is written past the end. A wrong or hostile stream throws instead. Its
// result is checked against the chunk's CRC and SHA-1 afterwards, so a decoding mistake can never
// reach the disk, only fail the chunk.

export class LzmaError extends Error {}

const PROB_BITS = 11
const PROB_INIT = 1 << (PROB_BITS - 1)
const MOVE_BITS = 5
const TOP = 1 << 24

const STATES = 12
const POS_BITS_MAX = 4
const LEN_TO_POS_STATES = 4
const ALIGN_BITS = 4
const END_POS_MODEL_INDEX = 14
const FULL_DISTANCES = 1 << (END_POS_MODEL_INDEX >> 1)
const MATCH_MIN_LEN = 2

// Where each model lives in the one probability array.
const IS_MATCH = 0
const IS_REP = IS_MATCH + (STATES << POS_BITS_MAX)
const IS_REP_G0 = IS_REP + STATES
const IS_REP_G1 = IS_REP_G0 + STATES
const IS_REP_G2 = IS_REP_G1 + STATES
const IS_REP0_LONG = IS_REP_G2 + STATES
const POS_SLOT = IS_REP0_LONG + (STATES << POS_BITS_MAX)
const SPEC_POS = POS_SLOT + (LEN_TO_POS_STATES << 6)
const ALIGN = SPEC_POS + FULL_DISTANCES - END_POS_MODEL_INDEX
const LEN_CODER = ALIGN + (1 << ALIGN_BITS)
// A length coder: choice, choice2, 16 low trees of 8, 16 mid trees of 8, one high tree of 256.
const LEN_CHOICE = 0
const LEN_CHOICE2 = 1
const LEN_LOW = 2
const LEN_MID = LEN_LOW + (16 << 3)
const LEN_HIGH = LEN_MID + (16 << 3)
const LEN_CODER_SIZE = LEN_HIGH + 256
const REP_LEN_CODER = LEN_CODER + LEN_CODER_SIZE
const LITERAL = REP_LEN_CODER + LEN_CODER_SIZE

export interface LzmaProperties {
  lc: number
  lp: number
  pb: number
  dictionarySize: number
}

/** The 5 property bytes in front of an LZMA stream. */
export function lzmaProperties(bytes: Uint8Array): LzmaProperties {
  if (bytes.length < 5) throw new LzmaError('LZMA properties are 5 bytes')
  let d = bytes[0]
  if (d >= 9 * 5 * 5) throw new LzmaError('Invalid LZMA properties')
  const lc = d % 9
  d = (d - lc) / 9
  const lp = d % 5
  const pb = (d - lp) / 5
  const dictionarySize = (bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24)) >>> 0
  return { lc, lp, pb, dictionarySize: Math.max(dictionarySize, 1 << 12) }
}

class Decoder {
  /** The range coder's range and code, as signed 32-bit integers (see literalBits). Kept in a typed
   * array rather than fields so they are never boxed as doubles between calls. */
  private readonly rc = new Int32Array(2)
  private inPos: number
  private readonly probs: Uint16Array

  constructor(
    private readonly input: Uint8Array,
    start: number,
    private readonly props: LzmaProperties
  ) {
    this.inPos = start
    this.probs = new Uint16Array(LITERAL + (0x300 << (props.lc + props.lp))).fill(PROB_INIT)
    if (this.nextByte() !== 0) throw new LzmaError('Corrupt LZMA stream')
    let code = 0
    for (let i = 0; i < 4; i++) code = (code << 8) | this.nextByte()
    this.rc[0] = -1 // 0xffffffff
    this.rc[1] = code
    if (code === -1) throw new LzmaError('Corrupt LZMA stream')
  }

  private nextByte(): number {
    if (this.inPos >= this.input.length) throw new LzmaError('The LZMA stream ends early')
    return this.input[this.inPos++]
  }

  private bit(index: number): number {
    const probs = this.probs
    const rc = this.rc
    const prob = probs[index]
    let range = rc[0]
    let code = rc[1]
    // Wraps like the C original: the product is under 2^32, read as unsigned below.
    const bound = Math.imul(range >>> PROB_BITS, prob)
    let bit: number
    if ((code ^ 0x80000000) < (bound ^ 0x80000000)) {
      range = bound
      probs[index] = prob + (((1 << PROB_BITS) - prob) >>> MOVE_BITS)
      bit = 0
    } else {
      range = (range - bound) | 0
      code = (code - bound) | 0
      probs[index] = prob - (prob >>> MOVE_BITS)
      bit = 1
    }
    if (range >>> 0 < TOP) {
      range = range << 8
      code = (code << 8) | this.nextByte()
    }
    rc[0] = range
    rc[1] = code
    return bit
  }

  /** The rest of a literal's 8 bits from `symbol` on: bit() written out with the coder's state in
   * locals. Incompressible data is nearly all literals, nine coded bits a byte, so this loop is
   * most of the time a high-entropy chunk takes to decode. */
  private literalBits(offset: number, symbol: number): number {
    const probs = this.probs
    const input = this.input
    // In signed 32-bit form: V8 keeps these in integer registers, where the unsigned values would
    // be doubles. Unsigned comparisons flip the sign bit of both sides first.
    const rc = this.rc
    let range = rc[0]
    let code = rc[1]
    let inPos = this.inPos
    while (symbol < 0x100) {
      const index = offset + symbol
      const prob = probs[index]
      const bound = Math.imul(range >>> PROB_BITS, prob)
      if ((code ^ 0x80000000) < (bound ^ 0x80000000)) {
        range = bound
        probs[index] = prob + (((1 << PROB_BITS) - prob) >>> MOVE_BITS)
        symbol = symbol << 1
      } else {
        range = (range - bound) | 0
        code = (code - bound) | 0
        probs[index] = prob - (prob >>> MOVE_BITS)
        symbol = (symbol << 1) | 1
      }
      if (range >>> 0 < TOP) {
        if (inPos >= input.length) throw new LzmaError('The LZMA stream ends early')
        range = range << 8
        code = (code << 8) | input[inPos++]
      }
    }
    rc[0] = range
    rc[1] = code
    this.inPos = inPos
    return symbol
  }

  private directBits(count: number): number {
    const rc = this.rc
    let range = rc[0]
    let code = rc[1]
    let result = 0
    for (let i = 0; i < count; i++) {
      range = range >>> 1
      let bit = 0
      if ((code ^ 0x80000000) >= (range ^ 0x80000000)) {
        code = (code - range) | 0
        bit = 1
      }
      if (range >>> 0 < TOP) {
        range = range << 8
        code = (code << 8) | this.nextByte()
      }
      // Up to 26 bits: multiplied rather than shifted, so it never turns negative.
      result = result * 2 + bit
    }
    rc[0] = range
    rc[1] = code
    return result
  }

  private tree(offset: number, bits: number): number {
    let m = 1
    for (let i = 0; i < bits; i++) m = (m << 1) + this.bit(offset + m)
    return m - (1 << bits)
  }

  private reverseTree(offset: number, bits: number): number {
    let m = 1
    let symbol = 0
    for (let i = 0; i < bits; i++) {
      const bit = this.bit(offset + m)
      m = (m << 1) + bit
      symbol |= bit << i
    }
    return symbol
  }

  private length(coder: number, posState: number): number {
    if (this.bit(coder + LEN_CHOICE) === 0) return this.tree(coder + LEN_LOW + (posState << 3), 3)
    if (this.bit(coder + LEN_CHOICE2) === 0) {
      return 8 + this.tree(coder + LEN_MID + (posState << 3), 3)
    }
    return 16 + this.tree(coder + LEN_HIGH, 8)
  }

  private distance(length: number): number {
    const lenState = Math.min(length, LEN_TO_POS_STATES - 1)
    const posSlot = this.tree(POS_SLOT + (lenState << 6), 6)
    if (posSlot < 4) return posSlot
    const directBits = (posSlot >>> 1) - 1
    // Up to 32 bits: multiplied rather than shifted, so it never turns negative.
    let distance = (2 | (posSlot & 1)) * 2 ** directBits
    if (posSlot < END_POS_MODEL_INDEX) {
      distance += this.reverseTree(SPEC_POS + distance - posSlot, directBits)
    } else {
      distance += this.directBits(directBits - ALIGN_BITS) * (1 << ALIGN_BITS)
      distance += this.reverseTree(ALIGN, ALIGN_BITS)
    }
    return distance
  }

  /** Decodes exactly `out.length` bytes into `out`. */
  decode(out: Uint8Array): void {
    const { lc, lp, pb, dictionarySize } = this.props
    const posMask = (1 << pb) - 1
    const literalPosMask = (1 << lp) - 1
    const size = out.length
    let outPos = 0
    let state = 0
    let rep0 = 0
    let rep1 = 0
    let rep2 = 0
    let rep3 = 0

    // The stream may end with an end marker or simply stop; once the output is full, whatever is
    // left is never decoded.
    while (outPos < size) {
      const posState = outPos & posMask
      if (this.bit(IS_MATCH + (state << POS_BITS_MAX) + posState) === 0) {
        const previous = outPos > 0 ? out[outPos - 1] : 0
        const offset =
          LITERAL + 0x300 * (((outPos & literalPosMask) << lc) + (previous >>> (8 - lc)))
        let symbol = 1
        if (state >= 7) {
          // After a match, the byte at the match distance steers the literal's bits until they
          // part ways.
          let matchByte = out[outPos - rep0 - 1]
          while (symbol < 0x100) {
            const matchBit = (matchByte >>> 7) & 1
            matchByte <<= 1
            const bit = this.bit(offset + ((1 + matchBit) << 8) + symbol)
            symbol = (symbol << 1) | bit
            if (matchBit !== bit) break
          }
        }
        if (symbol < 0x100) symbol = this.literalBits(offset, symbol)
        out[outPos++] = symbol - 0x100
        state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6
        continue
      }

      let length: number
      if (this.bit(IS_REP + state) !== 0) {
        if (outPos === 0) throw new LzmaError('Corrupt LZMA stream')
        if (this.bit(IS_REP_G0 + state) === 0) {
          if (this.bit(IS_REP0_LONG + (state << POS_BITS_MAX) + posState) === 0) {
            // A "short rep": one byte from rep0.
            state = state < 7 ? 9 : 11
            out[outPos] = out[outPos - rep0 - 1]
            outPos++
            continue
          }
        } else {
          let distance: number
          if (this.bit(IS_REP_G1 + state) === 0) {
            distance = rep1
          } else {
            if (this.bit(IS_REP_G2 + state) === 0) {
              distance = rep2
            } else {
              distance = rep3
              rep3 = rep2
            }
            rep2 = rep1
          }
          rep1 = rep0
          rep0 = distance
        }
        length = this.length(REP_LEN_CODER, posState)
        state = state < 7 ? 8 : 11
      } else {
        rep3 = rep2
        rep2 = rep1
        rep1 = rep0
        length = this.length(LEN_CODER, posState)
        state = state < 7 ? 7 : 10
        rep0 = this.distance(length)
        if (rep0 === 0xffffffff) throw new LzmaError('The LZMA stream ends early')
        if (rep0 >= dictionarySize || rep0 >= outPos) throw new LzmaError('Corrupt LZMA stream')
      }

      length += MATCH_MIN_LEN
      if (length > size - outPos) throw new LzmaError('The LZMA stream is longer than declared')
      // Byte by byte: a match may overlap the bytes it is producing (a distance shorter than its
      // length repeats a run).
      let from = outPos - rep0 - 1
      for (const end = outPos + length; outPos < end;) out[outPos++] = out[from++]
    }
  }
}

/** Decodes the raw LZMA stream at `input[start..]` with `props` into exactly `size` bytes. */
export function decodeLzma(
  input: Uint8Array,
  props: LzmaProperties,
  size: number,
  start = 0
): Buffer {
  if (!Number.isSafeInteger(size) || size < 0) throw new LzmaError('Invalid LZMA output size')
  const out = Buffer.allocUnsafe(size)
  if (size > 0) new Decoder(input, start, props).decode(out)
  return out
}
