/**
 * RRPublish v2.1 serves /view as text/event-stream with the view wrapped one
 * level down (Data.Elements / Data.Data.SplitsAndLegs). Recorded from
 * 434149 (Popup Races Belfast 5K, pid 2973) on 21 Nov 2026 — before the fix
 * the JSON parse failed, the legacy fallback 404'd and splits came back empty.
 */

jest.mock('../../src/services/rrpublish/client', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'fixtures', 'rrpublish-sse', '434149');
  const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
  return {
    PROXY_SERVER: 'eventoapi.com/v1/rrpublish',
    proxyGet: async (rrId, rawPathAndQuery) => {
      const [p] = rawPathAndQuery.split('?');
      if (p === 'results/config') {
        return { status: 200, contentType: 'application/json', body: read('config.json') };
      }
      if (p.endsWith('/view')) {
        return { status: 200, contentType: 'text/event-stream', body: read('athlete-2973-view.sse') };
      }
      return { status: 404, contentType: 'text/plain', body: 'not found' };
    },
  };
});

const { normalizedAthlete } = require('../../src/services/rrpublish/normalize');

test('SSE /view body yields splits and SplitConfig', async () => {
  const res = await normalizedAthlete('434149', { pid: '2973', lang: 'en' });
  expect(res.status).toBe(200);
  expect(res.body.splitConfig).not.toBe('');
  expect(res.body.show.splits).toBe(true);
  expect(res.body.splits.rows.length).toBe(3);
});

jest.mock('../../src/config/redis', () => ({}));
jest.mock('../../src/config/database', () => ({}));

describe('readBody', () => {
  const { readBody } = jest.requireActual('../../src/services/rrpublish/client');

  test('returns the first SSE event without waiting for the stream to close', async () => {
    const enc = new TextEncoder();
    // Never closes — mirrors RR holding /view open ~30 s after the update.
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('retry: 3000\n\nevent: update\ndata: {"a"'));
        c.enqueue(enc.encode(':1}\n\n'));
      },
    });
    const res = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    const text = await readBody(res);
    expect(text).toContain('data: {"a":1}');
  });

  test('plain JSON bodies read as text', async () => {
    const res = new Response('{"b":2}', { headers: { 'content-type': 'application/json' } });
    expect(await readBody(res)).toBe('{"b":2}');
  });
});
