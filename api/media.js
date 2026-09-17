import { Readable } from 'node:stream';
import { verifyRelayToken } from '../src/relay.js';

const COPY_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
];

function fetchWithHeaderTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(timeoutMs) || 30000));
  return fetch(url, { ...options, signal: controller.signal })
    .then((response) => {
      clearTimeout(timer);
      return response;
    })
    .catch((error) => {
      clearTimeout(timer);
      throw error;
    });
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).end('Method Not Allowed');
  }

  let verified;
  try {
    verified = verifyRelayToken(String(req.query?.t || ''), String(req.query?.s || ''));
  } catch (error) {
    return res.status(403).json({ ok: false, error: error?.message || 'invalid_relay' });
  }

  const headers = {
    ...verified.headers,
    Accept: req.headers.accept || verified.headers.Accept || verified.headers.accept || '*/*',
  };
  if (req.headers.range) headers.Range = req.headers.range;
  if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range'];

  let upstream;
  try {
    upstream = await fetchWithHeaderTimeout(
      verified.url,
      {
        method: req.method,
        headers,
        redirect: 'follow',
      },
      process.env.MEDIA_RELAY_HEADER_TIMEOUT_MS || 30000,
    );
  } catch (error) {
    console.error('[relay] upstream header fetch failed:', error?.message);
    return res.status(502).json({ ok: false, error: 'upstream_fetch_failed' });
  }

  res.statusCode = upstream.status;
  for (const name of COPY_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'HEAD' || !upstream.body) return res.end();

  try {
    const stream = Readable.fromWeb(upstream.body);
    stream.on('error', (error) => {
      console.error('[relay] stream failed:', error?.message);
      if (!res.headersSent) res.statusCode = 502;
      res.end();
    });
    stream.pipe(res);
  } catch (error) {
    console.error('[relay] pipe failed:', error?.message);
    if (!res.headersSent) return res.status(502).end('Relay failed');
    return res.end();
  }
}
