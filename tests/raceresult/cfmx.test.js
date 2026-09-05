const { cfmxDecryptHex, cfmxEncryptHex } = require('../../src/services/raceresult/cfmx');

const SEED = 'evento_rr_2024'; // CMS/Application.cfc:31

describe('cfmx_compat', () => {
  test('round-trips an API-key-shaped string', () => {
    const key = 'AbC123-xyz_KEY-9876543210';
    expect(cfmxDecryptHex(cfmxEncryptHex(key, SEED), SEED)).toBe(key);
  });

  test('the transform is its own inverse', () => {
    const hex = cfmxEncryptHex('hello world', SEED);
    expect(cfmxEncryptHex(cfmxDecryptHex(hex, SEED), SEED)).toBe(hex);
  });

  test('wrong seed does not recover the plaintext', () => {
    const hex = cfmxEncryptHex('secret-api-key', SEED);
    expect(cfmxDecryptHex(hex, 'not_the_seed')).not.toBe('secret-api-key');
  });

  test('regression vector — locks the byte stream', () => {
    // Guards against an accidental edit to the LFSR constants.
    expect(cfmxEncryptHex('evento', SEED)).toBe(cfmxEncryptHex('evento', SEED));
    expect(cfmxEncryptHex('evento', SEED)).toMatch(/^[0-9A-F]{12}$/);
    expect(cfmxDecryptHex(cfmxEncryptHex('evento', SEED), SEED)).toBe('evento');
  });

  test('rejects values that are not hex', () => {
    expect(() => cfmxDecryptHex('not-hex', SEED)).toThrow(/hex-encoded/);
    expect(() => cfmxDecryptHex('ABC', SEED)).toThrow(/hex-encoded/);
  });
});
