const { rrLogin, parseTokenBody, TOKEN_URL, LEGACY_LOGIN_URL } = require('../src/services/raceresult/login');

const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body });

function fetchMock(byUrl) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: init.body });
    const r = byUrl[url];
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}

describe('parseTokenBody — both RaceResult login shapes', () => {
  test.each([
    ['{"access_token":"jwt.abc","token_type":"Bearer","refresh_token":"r1","expiry":"2026-11-14T03:59:31+01:00"}', 'jwt.abc'],
    ['{"Token":"legacy123"}', 'legacy123'],
    ['"bare456"', 'bare456'],
    ['bare789', 'bare789'],
    ['', ''],
    ['{"error":"access denied"}', ''],
    ['{not json', ''],
  ])('%s → %s', (body, expected) => {
    expect(parseTokenBody(body)).toBe(expected);
  });
});

describe('rrLogin — JWT endpoint first, legacy fallback', () => {
  test('uses /api/token/get and sends the key as the apikey form field', async () => {
    const f = fetchMock({ [TOKEN_URL]: resp(200, '{"access_token":"jwt.ok","refresh_token":"r","expiry":"x"}') });
    await expect(rrLogin('K EY', { fetch: f })).resolves.toBe('jwt.ok');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe(TOKEN_URL);
    expect(f.calls[0].body).toBe('apikey=K%20EY');
  });

  test('a bad key is final: 401 from the token endpoint is not retried on the legacy one', async () => {
    const f = fetchMock({ [TOKEN_URL]: resp(401, '{"error":"access denied"}'), [LEGACY_LOGIN_URL]: resp(200, 'should-not-be-used') });
    await expect(rrLogin('bad', { fetch: f })).rejects.toMatchObject({ status: 401, message: expect.stringContaining('HTTP 401') });
    expect(f.calls.map((c) => c.url)).toEqual([TOKEN_URL]);
  });

  test('falls back to /api/public/login when the token endpoint is missing or broken', async () => {
    for (const first of [resp(404, 'not found'), resp(500, 'boom'), resp(200, '{"unexpected":1}'), new Error('ECONNRESET')]) {
      const f = fetchMock({ [TOKEN_URL]: first, [LEGACY_LOGIN_URL]: resp(200, '{"Token":"legacy"}') });
      await expect(rrLogin('k', { fetch: f })).resolves.toBe('legacy');
      expect(f.calls.map((c) => c.url)).toEqual([TOKEN_URL, LEGACY_LOGIN_URL]);
    }
  });

  test('legacy failure after fallback reports its status', async () => {
    const f = fetchMock({ [TOKEN_URL]: resp(503, ''), [LEGACY_LOGIN_URL]: resp(401, '{"error":"access denied"}') });
    await expect(rrLogin('k', { fetch: f })).rejects.toMatchObject({ status: 401 });
  });

  test('rejects an empty key without calling RaceResult', async () => {
    const f = fetchMock({});
    await expect(rrLogin('', { fetch: f })).rejects.toThrow(/needs an API key/);
    expect(f.calls).toHaveLength(0);
  });
});
