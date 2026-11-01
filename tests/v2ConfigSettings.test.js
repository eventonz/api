/** CMS Event Settings folded into /v2/config: avatar mode + Live Activities flag. */
let mockEventJson = {};
jest.mock('../src/config/database', () => ({ query: jest.fn(async () => ({ rows: [{ avatar: mockEventJson.avatar ?? null, live: mockEventJson.liveActivities ?? null }] })) }));
jest.mock('../src/services/v2bridge', () => ({ platformRacesForEvent: jest.fn() }));
const { applyV2EventSettings } = require('../src/routes/v2/config');

const doc = () => ({ athletes: { avatar: 'initials', url: 'x' }, _hash: 'h0' });

test('defaults: live activities on, hash folded once', async () => {
  mockEventJson = {};
  const d = await applyV2EventSettings(doc(), 'ev');
  expect(d.athletes.live_activities).toBe(true);
  expect(d._hash).not.toBe('h0');
});

test('CMS switches Live Activities off → flag false and a different hash', async () => {
  mockEventJson = { liveActivities: false, avatar: 'raceno' };
  const d = await applyV2EventSettings(doc(), 'ev');
  expect(d.athletes).toMatchObject({ avatar: 'raceno', live_activities: false });
  mockEventJson = { liveActivities: true, avatar: 'raceno' };
  const d2 = await applyV2EventSettings(doc(), 'ev');
  expect(d2._hash).not.toBe(d._hash);
});
