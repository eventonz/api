/**
 * One Firebase project per app: fcm.js routes every send / subscribe through
 * the app's own project (v2.app_push_credentials) or the shared default.
 * firebase-admin and the DB are mocked — no network.
 */
const crypto = require('crypto');

const mockSends = [];          // { app: adminAppName, message, dryRun }
const mockSubs = [];           // { app, tokens, topic }
const mockAdminApps = [];
const mockRows = new Map();    // app_id → { project_id, credentials }

jest.mock('../src/config/database', () => ({
  query: jest.fn(async (_sql, [appId]) => ({ rows: mockRows.has(appId) ? [mockRows.get(appId)] : [] })),
}));
jest.mock('firebase-admin/app', () => ({
  getApps: () => mockAdminApps,
  initializeApp: (opts, name) => { const a = { name, opts }; mockAdminApps.push(a); return a; },
  cert: (c) => ({ cert: c }),
}));
jest.mock('firebase-admin/messaging', () => ({
  getMessaging: (app) => ({
    send: async (message, dryRun) => { mockSends.push({ app: app.name, message, dryRun: !!dryRun }); return `mid-${app.name}`; },
    subscribeToTopic: async (tokens, topic) => { mockSubs.push({ app: app.name, tokens, topic }); },
    unsubscribeFromTopic: async () => {},
    sendEach: async (msgs) => ({ successCount: msgs.length, failureCount: 0, responses: msgs.map(() => ({})) }),
  }),
}));

const sa = (project, keyId = 'k1') => ({ type: 'service_account', project_id: project, private_key_id: keyId, client_email: `x@${project}.iam`, private_key: 'pk' });
const DEFAULT_SA = Buffer.from(JSON.stringify(sa('evento-7ec10'))).toString('base64');

let fcm, creds;
beforeEach(() => {
  jest.resetModules();
  mockSends.length = 0; mockSubs.length = 0; mockAdminApps.length = 0; mockRows.clear();
  process.env.FIREBASE_SERVICE_ACCOUNT_B64 = DEFAULT_SA;
  delete process.env.PUSH_DRY_RUN;
  delete process.env.PUSH_CREDENTIALS_KEY;
  fcm = require('../src/services/fcm');
  creds = require('../src/services/pushCredentials');
});

test('an app without its own credentials sends through the default project', async () => {
  await fcm.sendToTopic('app-901-en', { title: 'Hi' }, 901);
  expect(mockSends).toHaveLength(1);
  expect(mockSends[0].app).toBe('evento-default');
  expect(mockAdminApps[0].opts.credential.cert.project_id).toBe('evento-7ec10');
});

test('an app with its own credentials sends through its own project', async () => {
  mockRows.set('35', { project_id: 'my-results-by-ses', credentials: JSON.stringify(sa('my-results-by-ses')) });
  await fcm.sendToTopic('app-35-en', { title: 'Hi' }, 35);
  expect(mockSends[0].app).toBe('evento-my-results-by-ses:k1');
  expect(mockAdminApps[0].opts.credential.cert.project_id).toBe('my-results-by-ses');
  expect(mockSends[0].message.topic).toBe('app-35-en');
});

test('subscribe uses the app\'s project', async () => {
  mockRows.set('30', { project_id: 'timit-92f3d', credentials: JSON.stringify(sa('timit-92f3d')) });
  await fcm.subscribe(['tok'], 'event-x-en', 30);
  await fcm.subscribe(['tok2'], 'event-x-en', 901);
  expect(mockSubs.map((s) => s.app)).toEqual(['evento-timit-92f3d:k1', 'evento-default']);
});

test('distinctProjects keeps one app per Firebase project', async () => {
  mockRows.set('35', { project_id: 'my-results-by-ses', credentials: JSON.stringify(sa('my-results-by-ses')) });
  mockRows.set('30', { project_id: 'timit-92f3d', credentials: JSON.stringify(sa('timit-92f3d')) });
  // 901 and 44 share the default project; 35 appears twice.
  expect(await fcm.distinctProjects([35, 901, 30, 44, 35])).toEqual([35, 901, 30]);
  expect(await fcm.distinctProjects([null])).toEqual([null]);
});

test('encrypted credentials are decrypted with PUSH_CREDENTIALS_KEY', async () => {
  process.env.PUSH_CREDENTIALS_KEY = 'secret';
  const key = crypto.createHash('sha256').update('secret').digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(sa('pop-up-races'))), c.final()]);
  const stored = `enc:v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${data.toString('base64')}`;
  mockRows.set('27', { project_id: 'pop-up-races', credentials: stored });
  expect((await creds.forApp(27)).credential.project_id).toBe('pop-up-races');
});

test('encrypted credentials without the key fail with a clear error', async () => {
  mockRows.set('27', { project_id: 'pop-up-races', credentials: 'enc:v1:a:b:c' });
  await expect(creds.forApp(27)).rejects.toThrow(/PUSH_CREDENTIALS_KEY/);
});

test('check() dry-runs a send and reports the project', async () => {
  mockRows.set('35', { project_id: 'my-results-by-ses', credentials: JSON.stringify(sa('my-results-by-ses')) });
  expect(await fcm.check(35)).toEqual({ ok: true, own: true, project_id: 'my-results-by-ses' });
  expect(mockSends[0].dryRun).toBe(true);
  expect(await fcm.check(901)).toEqual({ ok: true, own: false, project_id: 'evento-7ec10' });
});

test('a missing credentials table (migration not applied) falls back to the default project', async () => {
  const db = require('../src/config/database');
  db.query.mockImplementationOnce(async () => { const e = new Error('relation does not exist'); e.code = '42P01'; throw e; });
  expect(await fcm.projectKey(35)).toBe('default');
});
