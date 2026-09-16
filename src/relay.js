import crypto from 'node:crypto';

const DEFAULT_TTL_SECONDS = 15 * 60;

function relaySecret() {
  return process.env.TELEGRAM_WEBHOOK_SECRET || process.env.SETUP_SECRET || '';
}

function sign(value) {
  const secret = relaySecret();
  if (!secret) throw new Error('Relay secret is not configured.');
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function safeHeaders(headers) {
  const source = headers && typeof headers === 'object' ? headers : {};
  const out = {};
  const allowed = new Set([
    'user-agent',
    'referer',
    'origin',
    'accept',
    'accept-language',
  ]);
  for (const [key, value] of Object.entries(source)) {
    if (!allowed.has(String(key).toLowerCase())) continue;
    if (typeof value !== 'string' || !value) continue;
    out[key] = value.slice(0, 1200);
  }
  return out;
}

export function createRelayUrl(baseUrl, item, ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (!baseUrl || !item?.url) throw new Error('Relay URL requires base URL and media URL.');
  const payload = {
    u: item.url,
    h: safeHeaders(item.headers),
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const token = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = sign(token);
  return `${String(baseUrl).replace(/\/$/, '')}/api/media?t=${encodeURIComponent(token)}&s=${encodeURIComponent(sig)}`;
}

function isAllowedMediaHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  const allowedSuffixes = [
    'cdninstagram.com',
    'fbcdn.net',
    'instagram.com',
    'threads.net',
    'threads.com',
    'tiktokcdn.com',
    'tiktokcdn-us.com',
    'googlevideo.com',
    'weirddl.sbs',
  ];
  return allowedSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function verifyRelayToken(token, signature) {
  if (!token || !signature) throw new Error('missing_relay_signature');
  const expected = sign(token);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('invalid_relay_signature');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid_relay_payload');
  }

  if (!payload?.u || !payload?.e || Number(payload.e) < Math.floor(Date.now() / 1000)) {
    throw new Error('expired_relay_payload');
  }

  const url = new URL(payload.u);
  if (url.protocol !== 'https:' || !isAllowedMediaHost(url.hostname)) {
    throw new Error('relay_host_not_allowed');
  }

  return {
    url: url.toString(),
    headers: safeHeaders(payload.h),
  };
}
