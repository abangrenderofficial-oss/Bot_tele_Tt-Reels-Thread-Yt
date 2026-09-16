const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const testUrl = process.env.STATUS_TEST_URL || 'https://vt.tiktok.com/ZSgbsv3MX';

function convertBase(value, fromBase, toBase) {
  const digits = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/';
  const fromChars = digits.slice(0, fromBase);
  const toChars = digits.slice(0, toBase);
  let number = 0;
  for (const ch of String(value)) {
    const idx = fromChars.indexOf(ch);
    if (idx >= 0) number = number * fromBase + idx;
  }
  if (!number) return '0';
  let out = '';
  while (number > 0) {
    out = toChars[number % toBase] + out;
    number = Math.floor(number / toBase);
  }
  return out;
}

function deobfuscate(h, n, t, e) {
  let out = '';
  let i = 0;
  while (i < h.length) {
    let chunk = '';
    while (i < h.length && h[i] !== n[e]) {
      chunk += h[i];
      i += 1;
    }
    const numeric = [...chunk].map((c) => n.indexOf(c)).join('');
    if (numeric) out += String.fromCharCode(Number(convertBase(numeric, e, 10)) - t);
    i += 1;
  }
  return out;
}

async function probeDirect(url, referer) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) },
    redirect: 'follow', signal: AbortSignal.timeout(30000),
  });
  console.log('DIRECT', res.status, res.url, res.headers.get('content-type'), res.headers.get('content-length'));
  await res.body?.cancel().catch(() => {});
  return res.ok && /video|octet-stream/i.test(res.headers.get('content-type') || '');
}

async function trySnapTik(link) {
  const base = 'https://snaptik.app';
  const home = await fetch(base, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*' },
    redirect: 'follow', signal: AbortSignal.timeout(20000),
  });
  const html = await home.text();
  console.log('SNAPTIK_HOME', home.status, 'bytes', html.length);
  const token = html.match(/name=["']token["']\s+value=["']([^"']+)["']/i)?.[1]
    || html.match(/value=["']([^"']+)["']\s+name=["']token["']/i)?.[1]
    || '';
  console.log('SNAPTIK_TOKEN', token.length);
  if (!token) return null;

  const cookies = typeof home.headers.getSetCookie === 'function'
    ? home.headers.getSetCookie().map((v) => String(v).split(';', 1)[0]).filter(Boolean).join('; ')
    : '';
  const post = await fetch(`${base}/abc2.php`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Accept: '*/*',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Origin: base,
      Referer: `${base}/`,
      'X-Requested-With': 'XMLHttpRequest',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: new URLSearchParams({ url: link, token }),
    redirect: 'follow', signal: AbortSignal.timeout(30000),
  });
  const text = await post.text();
  console.log('SNAPTIK_POST', post.status, 'bytes', text.length, 'head', text.slice(0, 1000).replace(/\s+/g, ' '));
  if (!post.ok) return null;

  // Older/current SnapTik responses wrap HTML in a Dean-Edwards-style encoded function call.
  const m = text.match(/\(["']([\w+/]+)["']\s*,\s*\d+\s*,\s*["']([\w+/]+)["']\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*\d+\s*\)/);
  let decoded = text;
  if (m) {
    try {
      decoded = deobfuscate(m[1], m[2], Number(m[3]), Number(m[4]));
      console.log('SNAPTIK_DECODED', 'bytes', decoded.length, 'head', decoded.slice(0, 1400).replace(/\s+/g, ' '));
    } catch (error) {
      console.log('SNAPTIK_DECODE_FAIL', error?.message || error);
    }
  }

  const candidates = [...decoded.matchAll(/href=\\?["']([^"']+)\\?["']/gi)].map((x) => x[1].replaceAll('\\/', '/'));
  console.log('SNAPTIK_HREFS', candidates.slice(0, 12));
  const direct = candidates.find((x) => /^https?:\/\//i.test(x) && /snaptik|tiktok|cdn|video|\.mp4/i.test(x)) || '';
  return direct || null;
}

async function tryLoveTik(link) {
  const res = await fetch('https://lovetik.com/api/ajax/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://lovetik.com',
      Referer: 'https://lovetik.com/', 'User-Agent': UA, Accept: 'application/json,text/plain,*/*',
    },
    body: new URLSearchParams({ query: link }), redirect: 'follow', signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  console.log('LOVETIK', res.status, 'bytes', text.length, 'head', text.slice(0, 500).replace(/\s+/g, ' '));
  if (!res.ok) return null;
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  const links = Array.isArray(data?.links) ? data.links : [];
  const mp4 = links.filter((x) => /mp4/i.test(String(x?.t || '')));
  const chosen = mp4.find((x) => /1080|hd/i.test(String(x?.t || ''))) || mp4[0];
  return chosen?.a || chosen?.url || null;
}

console.log('TEST_URL', testUrl);
for (const [name, fn, referer] of [
  ['snaptik', trySnapTik, 'https://snaptik.app/'],
  ['lovetik', tryLoveTik, 'https://lovetik.com/'],
]) {
  try {
    const direct = await fn(testUrl);
    console.log('PROVIDER_RESULT', name, direct || 'NONE');
    if (direct && await probeDirect(direct, referer)) {
      console.log('PROBE_SUCCESS', name, direct);
      process.exit(0);
    }
  } catch (error) {
    console.log('PROVIDER_FAIL', name, error?.message || error);
  }
}
throw new Error('No provider resolved the exact TikTok link');
