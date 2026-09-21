import http from 'node:http';
import { URL } from 'node:url';

import healthHandler from './api/health.js';
import telegramHandler from './api/telegram.js';
import setupHandler from './api/setup.js';
import setupWebhookHandler from './api/setup-webhook.js';
import mediaHandler from './api/media.js';
import diagnosticHandler from './api/diagnostic.js';
import statusDiagnosticHandler from './api/status-diagnostic.js';
import bayarcashHandler from './api/bayarcash.js';

const MAX_BODY_BYTES = 5 * 1024 * 1024;

const routes = new Map([
  ['/api/health', healthHandler],
  ['/api/telegram', telegramHandler],
  ['/api/setup', setupHandler],
  ['/api/setup-webhook', setupWebhookHandler],
  ['/api/media', mediaHandler],
  ['/api/diagnostic', diagnosticHandler],
  ['/api/status-diagnostic', statusDiagnosticHandler],
  ['/api/bayarcash', bayarcashHandler],
]);

function addResponseHelpers(res) {
  res.status = function status(code) {
    this.statusCode = Number(code) || 200;
    return this;
  };

  res.json = function json(value) {
    if (!this.headersSent && !this.hasHeader('Content-Type')) {
      this.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    this.end(JSON.stringify(value));
    return this;
  };

  res.send = function send(value = '') {
    if (value !== null && typeof value === 'object' && !Buffer.isBuffer(value)) {
      return this.json(value);
    }
    this.end(value ?? '');
    return this;
  };
}

function parseQuery(url) {
  const query = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (Object.prototype.hasOwnProperty.call(query, key)) {
      query[key] = Array.isArray(query[key]) ? [...query[key], value] : [query[key], value];
    } else {
      query[key] = value;
    }
  }
  return query;
}

async function parseBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request_body_too_large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();

  if (type === 'application/json' || type.endsWith('+json')) {
    return raw ? JSON.parse(raw) : undefined;
  }

  if (type === 'application/x-www-form-urlencoded') {
    const out = {};
    const params = new URLSearchParams(raw);
    for (const [key, value] of params.entries()) {
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        out[key] = Array.isArray(out[key]) ? [...out[key], value] : [out[key], value];
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  return raw;
}

const server = http.createServer(async (req, res) => {
  addResponseHelpers(res);

  try {
    const host = req.headers.host || `127.0.0.1:${process.env.PORT || 3000}`;
    const url = new URL(req.url || '/', `http://${host}`);

    req.query = parseQuery(url);
    req.body = await parseBody(req);

    if (url.pathname === '/') {
      return res.status(200).json({
        ok: true,
        service: 'telegram-social-downloader',
        runtime: 'railway-node',
        architecture: 'isolated-features-v1',
      });
    }

    const handler = routes.get(url.pathname);
    if (!handler) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    await handler(req, res);
    if (!res.writableEnded) res.end();
  } catch (error) {
    console.error('Railway server request failed:', error);
    if (res.headersSent) return res.end();
    return res.status(error?.statusCode || 500).json({
      ok: false,
      error: error?.message || 'internal_error',
    });
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => {
  console.log(`Downloader bot listening on 0.0.0.0:${port}`);
});