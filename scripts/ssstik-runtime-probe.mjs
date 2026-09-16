const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
const testUrl = process.env.STATUS_TEST_URL || 'https://vt.tiktok.com/ZSgbsv3MX';

async function fetchHead(url, referer = '') {
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': UA, ...(referer ? { Referer: referer } : {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  console.log('MEDIA_FETCH', res.status, res.url, res.headers.get('content-type'), res.headers.get('content-length'));
  await res.body?.cancel().catch(() => {});
  return res.ok;
}

async function tryLoveTik(link) {
  const res = await fetch('https://lovetik.com/api/ajax/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://lovetik.com',
      Referer: 'https://lovetik.com/',
      'User-Agent': UA,
      Accept: 'application/json,text/plain,*/*',
    },
    body: new URLSearchParams({ query: link }),
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  console.log('LOVETIK', res.status, 'bytes', text.length, 'head', text.slice(0, 800).replace(/\s+/g, ' '));
  if (!res.ok) return null;
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  const links = Array.isArray(data?.links) ? data.links : [];
  console.log('LOVETIK_LINKS', links.length, links.map((x) => ({ t: x?.t, a: x?.a || x?.url })).slice(0, 8));
  const mp4 = links.filter((x) => /mp4/i.test(String(x?.t || '')));
  const chosen = mp4.find((x) => /1080|hd/i.test(String(x?.t || ''))) || mp4[0];
  const direct = chosen?.a || chosen?.url || '';
  return /^https?:\/\//i.test(direct) ? direct : null;
}

async function tryHostedResolver(link) {
  const endpoints = [
    'https://link-unshortener.vercel.app/api/tiktok',
    'https://link-unshortener.vercel.app/api/media',
  ];
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Accept: 'application/json' },
        body: JSON.stringify({ url: link }),
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
      });
      const text = await res.text();
      console.log('HOSTED', endpoint, res.status, 'bytes', text.length, 'head', text.slice(0, 700).replace(/\s+/g, ' '));
      if (!res.ok) continue;
      let data;
      try { data = JSON.parse(text); } catch { continue; }
      const direct = data?.downloadUrl || data?.url || data?.video_url || data?.data?.url || data?.data?.downloadUrl || '';
      if (/^https?:\/\//i.test(direct)) return direct;
    } catch (error) {
      console.log('HOSTED_FAIL', endpoint, error?.message || error);
    }
  }
  return null;
}

console.log('TEST_URL', testUrl);
let direct = await tryLoveTik(testUrl);
if (direct) {
  console.log('LOVETIK_DIRECT', direct);
  if (await fetchHead(direct, 'https://lovetik.com/')) {
    console.log('PROBE_SUCCESS', 'lovetik');
    process.exit(0);
  }
}

direct = await tryHostedResolver(testUrl);
if (direct) {
  console.log('HOSTED_DIRECT', direct);
  if (await fetchHead(direct)) {
    console.log('PROBE_SUCCESS', 'hosted-resolver');
    process.exit(0);
  }
}

throw new Error('No provider resolved the exact TikTok link');
