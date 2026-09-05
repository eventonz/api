/**
 * CFMX_COMPAT transform — port of Lucee's lucee.runtime.crypt.CFMXCompat
 * (three coupled LFSRs producing a keyed XOR stream; the transform is its own
 * inverse).
 *
 * The ColdFusion CMS stores organisation RaceResult API keys as
 *   Encrypt(key, application.rr_encryption_key, "cfmx_compat", "hex")
 * (CMS/cms/components/org_settings.cfm, CMS/cms/admin/org_edit.cfm), so this is
 * the only correct way to read organisations.rr_apikey.
 *
 * NOTE: routes/v1/timer_events.js and routes/v2/timer_events.js carry a local
 * decrypt() using DES-EDE3 with an MD5-derived key. That is not CFMX_COMPAT and
 * cannot decrypt this column — see docs/rr_provisioning.md.
 *
 * Kept byte-compatible with NEXTJS-CMS/lib/cfmx.ts, which reads the same column
 * in production.
 */

const MASK_A = 0x80000062;
const MASK_B = 0x40000020;
const MASK_C = 0x10000002;
const ROT0_A = 0x7fffffff;
const ROT0_B = 0x3fffffff;
const ROT0_C = 0x0fffffff;
const ROT1_A = 0x80000000;
const ROT1_B = 0xc0000000;
const ROT1_C = 0xf0000000;

function cfmxTransform(key, input) {
  let A = 0x13579bdf | 0;
  let B = 0x2468ace0 | 0;
  let C = 0xfdb97531 | 0;

  // setKey — including Lucee's quirk of seeding all three LFSRs from the same
  // Seed[i+4] positions. Reproduced verbatim for compatibility.
  const k = key.length === 0 ? 'Default Seed' : key;
  const seedLen = Math.max(k.length, 12);
  const seed = new Array(seedLen);
  for (let i = 0; i < k.length; i++) seed[i] = k.charCodeAt(i);
  for (let i = 0; k.length + i < 12; i++) seed[k.length + i] = seed[i];
  for (let i = 0; i < 4; i++) {
    A = ((A << 8) | seed[i + 4]) | 0;
    B = ((B << 8) | seed[i + 4]) | 0;
    C = ((C << 8) | seed[i + 4]) | 0;
  }
  if (A === 0) A = 0x13579bdf | 0;
  if (B === 0) B = 0x2468ace0 | 0;
  if (C === 0) C = 0xfdb97531 | 0;

  const out = new Uint8Array(input.length);
  for (let n = 0; n < input.length; n++) {
    let crypto = 0;
    let b = B & 1;
    let c = C & 1;
    for (let i = 0; i < 8; i++) {
      if ((A & 1) !== 0) {
        A = ((A ^ (MASK_A >>> 1)) | ROT1_A) | 0;
        if ((B & 1) !== 0) {
          B = ((B ^ (MASK_B >>> 1)) | ROT1_B) | 0;
          b = 1;
        } else {
          B = (B >>> 1) & ROT0_B;
          b = 0;
        }
      } else {
        A = (A >>> 1) & ROT0_A;
        if ((C & 1) !== 0) {
          C = ((C ^ (MASK_C >>> 1)) | ROT1_C) | 0;
          c = 1;
        } else {
          C = (C >>> 1) & ROT0_C;
          c = 0;
        }
      }
      crypto = ((crypto << 1) | (b ^ c)) & 0xff;
    }
    out[n] = input[n] ^ crypto;
  }
  return out;
}

/** Decrypt a ColdFusion Encrypt(value, seed, "cfmx_compat", "hex") string. */
function cfmxDecryptHex(hex, seed) {
  const clean = String(hex || '').trim();
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error('Not a hex-encoded cfmx_compat value');
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return Buffer.from(cfmxTransform(seed, bytes)).toString('utf8');
}

/** Encrypt to the same hex form (the transform is self-inverse). */
function cfmxEncryptHex(value, seed) {
  const bytes = Buffer.from(String(value), 'utf8');
  return Buffer.from(cfmxTransform(seed, bytes)).toString('hex').toUpperCase();
}

module.exports = { cfmxTransform, cfmxDecryptHex, cfmxEncryptHex };
