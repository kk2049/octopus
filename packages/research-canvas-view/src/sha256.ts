/**
 * Incremental SHA-256 (FIPS 180-4) for hashing a file one window at a time.
 *
 * Web Crypto only digests a whole buffer, which forced an upload to hold the
 * entire file in the page. No installed package offers an incremental digest
 * (lib0's is one-shot), and adding @noble/hashes re-resolves jsdom's optional
 * peer in every package's test environment; this is the few dozen lines that
 * replace it, checked against node:crypto in sha256.test.ts.
 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export class Sha256 {
  private readonly h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private readonly w = new Uint32Array(64);
  private readonly block = new Uint8Array(64);
  private used = 0;
  private length = 0;
  private finished = false;

  update(data: Uint8Array): this {
    if (this.finished) throw new Error("SHA-256 digest already produced");
    this.length += data.length;
    let i = 0;
    if (this.used) {
      i = Math.min(64 - this.used, data.length);
      this.block.set(data.subarray(0, i), this.used);
      this.used += i;
      if (this.used < 64) return this;
      this.compress(this.block, 0);
      this.used = 0;
    }
    for (; i + 64 <= data.length; i += 64) this.compress(data, i);
    if (i < data.length) { this.block.set(data.subarray(i), 0); this.used = data.length - i; }
    return this;
  }

  hex(): string {
    if (this.finished) throw new Error("SHA-256 digest already produced");
    this.finished = true;
    const block = this.block;
    block[this.used++] = 0x80;
    if (this.used > 56) { block.fill(0, this.used); this.compress(block, 0); this.used = 0; }
    block.fill(0, this.used, 56);
    // Message length in bits, as a 64-bit big-endian integer.
    const high = Math.floor(this.length / 0x20000000), low = (this.length << 3) >>> 0;
    for (let i = 0; i < 4; i++) { block[56 + i] = high >>> (24 - 8 * i); block[60 + i] = low >>> (24 - 8 * i); }
    this.compress(block, 0);
    return Array.from(this.h, word => word.toString(16).padStart(8, "0")).join("");
  }

  private compress(data: Uint8Array, at: number): void {
    const w = this.w, h = this.h;
    for (let t = 0; t < 16; t++) {
      const j = at + t * 4;
      w[t] = (data[j]! << 24) | (data[j + 1]! << 16) | (data[j + 2]! << 8) | data[j + 3]!;
    }
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15]!, b = w[t - 2]!;
      w[t] = w[t - 16]! + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[t - 7]! + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10));
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, k = h[7]!;
    for (let t = 0; t < 64; t++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t]! + w[t]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += k;
  }
}
