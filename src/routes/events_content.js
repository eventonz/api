'use strict';

/**
 * Static event content for the block-based mobile app (MOBILE-V2).
 *
 * Serves /events/* from the repo's content/events directory:
 *   /events/index.json                      events list
 *   /events/{id}/manifest.json              per-file versions (the app polls this)
 *   /events/{id}/event.json                 theme, races, nav
 *   /events/{id}/pages/{slug}.json          block stacks
 *   /events/{id}/schedule.json, results.json, course.gpx
 *
 * Caching contract (matches the app's ContentStore):
 *   - manifest.json / index.json → Cache-Control: no-cache + ETag, 304 on If-None-Match
 *   - everything else            → immutable, 1 year (fetched as ?v={version} URLs)
 *
 * Publish flow: edit JSON in the workspace, commit, git pull on the droplet.
 * Content is plain files — no restart needed.
 */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const CONTENT_ROOT = path.join(__dirname, '..', '..', 'content', 'events');

const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.gpx': 'application/gpx+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

module.exports = async function eventsContent(app) {
  app.get('/events/*', async (req, reply) => {
    const rel = req.params['*'] || '';
    const safe = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
    const file = path.join(CONTENT_ROOT, safe);
    if (!file.startsWith(CONTENT_ROOT)) {
      return reply.notFound();
    }

    let data;
    try {
      data = await fs.readFile(file);
    } catch {
      return reply.notFound();
    }

    const etag = `"${crypto.createHash('md5').update(data).digest('hex')}"`;
    const revalidate = path.basename(file) === 'manifest.json' || safe === 'index.json';

    reply.header('ETag', etag);
    reply.header(
      'Cache-Control',
      revalidate ? 'no-cache' : 'public, max-age=31536000, immutable'
    );
    reply.type(MIME[path.extname(file)] || 'application/octet-stream');

    if (req.headers['if-none-match'] === etag) {
      return reply.code(304).send();
    }
    return reply.send(data);
  });
};
