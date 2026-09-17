// Temporary Railway-only diagnostics for TikTok short-link resolution.
const exactLink = process.env.TEST_TIKTOK_URL || 'https://vt.tiktok.com/ZSqsKvFLE/';
const freshLink = 'https://vt.tiktok.com/ZSq2ay9yC/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function out(...args) {
  console.log(new Date().toISOString(), ...args);
}

function fmUrl(input) {
  const u = new URL(input);
  u.hostname = 'vt.fmtiktok.com';
  return u.toString();
}

async function testDirect(label, link) {
  try {
    const res = await fetch(link, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(15000),
    });
    out(label, 'DIRECT', res.status, 'loc=', res.headers.get('location') || '');
  } catch (error) {
    out(label, 'DIRECT_ERR', error?.message || error);
  }
}

async function testFmTikTok(label, link) {
  const proxy = fmUrl(link);
  try {
    const manual = await fetch(proxy, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(20000),
    });
    out(label, 'FMTIKTOK_MANUAL', manual.status, 'loc=', manual.headers.get('location') || '', 'url=', manual.url);
  } catch (error) {
    out(label, 'FMTIKTOK_MANUAL_ERR', error?.message || error);
  }

  try {
    const followed = await fetch(proxy, {
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(25000),
    });
    const body = await followed.text();
    out(label, 'FMTIKTOK_FOLLOW', followed.status, 'final=', followed.url, 'bytes=', body.length,
      'head=', body.replace(/\s+/g, ' ').slice(0, 500));
  } catch (error) {
    out(label, 'FMTIKTOK_FOLLOW_ERR', error?.message || error);
  }
}

async function testTikWM(label, link) {
  try {
    const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(link)}&hd=1`, {
      headers: { 'User-Agent': UA, Referer: 'https://www.tikwm.com/' },
      signal: AbortSignal.timeout(25000),
    });
    const text = await res.text();
    out(label, 'TIKWM', res.status, text.slice(0, 1100));
  } catch (error) {
    out(label, 'TIKWM_ERR', error?.message || error);
  }
}

async function testSSSTik(label, link) {
  const base = 'https://ssstik.io';
  try {
    const pageRes = await fetch(`${base}/en`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
    });
    const html = await pageRes.text();
    const tt = html.match(/s_tt\s*=\s*["']([^"']+)["']/)?.[1] || '';
    if (!tt) {
      out(label, 'SSSTIK_NO_TOKEN', pageRes.status, html.length);
      return;
    }
    const postRes = await fetch(`${base}/abc?url=dl`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Origin: base,
        Referer: `${base}/en`,
        'User-Agent': UA,
      },
      body: new URLSearchParams({ id: link, locale: 'en', tt }),
      signal: AbortSignal.timeout(25000),
    });
    const body = await postRes.text();
    const hrefs = [...body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((v) => /^https?:/i.test(v));
    const stripped = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    out(label, 'SSSTIK', postRes.status, 'hrefs=', hrefs.length, hrefs.slice(0, 4), 'text=', stripped.slice(0, 500));
  } catch (error) {
    out(label, 'SSSTIK_ERR', error?.message || error);
  }
}

for (const [label, link] of [['EXACT', exactLink], ['FRESH', freshLink]]) {
  out('TARGET', label, link);
  await testDirect(label, link);
  await testFmTikTok(label, link);
  await testTikWM(label, link);
  await testSSSTik(label, link);
}
out('DONE');
