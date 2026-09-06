process.env.JWT_SECRET = 'test-secret-that-is-long-enough-123';
jest.mock('../src/config/redis', () => ({ get: jest.fn(async () => null), set: jest.fn(async () => 'OK') }));
const { issueInstallToken, verifyInstallToken, looksLikeInstallToken } = require('../src/services/installTokens');

describe('install tokens', () => {
  test('issue → verify round trip carries app + install', async () => {
    const { token, expires_at } = issueInstallToken({ appId: 44, installId: 'ios-ABCDEF123456', keyId: 7, platform: 'ios' });
    expect(looksLikeInstallToken(token)).toBe(true);
    expect(new Date(expires_at).getTime()).toBeGreaterThan(Date.now());
    const p = await verifyInstallToken(token);
    expect(p.app_id).toBe(44); expect(p.sub).toBe('ios-ABCDEF123456'); expect(p.typ).toBe('install');
  });
  test('an API key is not mistaken for a token', () => {
    expect(looksLikeInstallToken('evt_abc.def.ghi')).toBe(false);
    expect(looksLikeInstallToken('3c9889fa343303866fb89a62bf97efd1')).toBe(false);
  });
  test('tampered token is rejected', async () => {
    const { token } = issueInstallToken({ appId: 1, installId: 'x'.repeat(12) });
    await expect(verifyInstallToken(token.slice(0, -2) + 'zz')).rejects.toThrow();
  });
});
