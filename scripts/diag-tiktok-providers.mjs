// Temporary Railway-only diagnostics for the exact failing TikTok short link. Run after lab start-command reset.
const link = process.env.TEST_TIKTOK_URL || 'https://vt.tiktok.com/ZSqsKvFLE';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function out(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function testRedirect() {
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(link, {
        method,
        redirect: 'manual',
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(15000),
      });
      out('REDIRECT', method, res.status, res.headers.get('location'));
    } catch (error) {
      out('REDIRECT_ERR', method, error?.message || error);
    }
  }
}

async function testSSSTik() {
  const base = 'https://ssstik.io';
  try {
    const pageRes = await fetch(`${base}/en`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
    });
    const html = await pageRes.text();
    const tt = html.match(/s_tt\s*=\s*["']([^"']+)["']/)?.[1] || '';
    out('SSSTIK_PAGE', pageRes.status, 'token', Boolean(tt), 'bytes', html.length);
    if (!tt) return;

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
    const noWm =
      body.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*without_watermark[^"]*"/)?.[1] ||
      body.match(/<a[^>]+class="[^"]*without_watermark[^"]*"[^>]+href="([^"]+)"/)?.[1] || '';
    out('SSSTIK_POST', postRes.status, 'bytes', body.length, 'noWm', Boolean(noWm), noWm.slice(0, 350));
    if (!noWm) out('SSSTIK_BODY', body.replace(/\s+/g, ' ').slice(0, 1200));
  } catch (error) {
    out('SSSTIK_ERR', error?.message || error);
  }
}

async function testLoveTik() {
  try {
    const res = await fetch('https://lovetik.com/api/ajax/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://lovetik.com',
        Referer: 'https://lovetik.com/',
        'User-Agent': UA,
      },
      body: new URLSearchParams({ query: link }),
      signal: AbortSignal.timeout(25000),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    const links = Array.isArray(data?.links) ? data.links : [];
    const mp4 = links.filter((item) => String(item?.t || '').toUpperCase().includes('MP4'));
    out('LOVETIK', res.status, 'json', Boolean(data), 'links', links.length, 'mp4', mp4.length,
      JSON.stringify(mp4.slice(0, 3)).slice(0, 1200));
    if (!mp4.length) out('LOVETIK_BODY', text.slice(0, 1200));
  } catch (error) {
    out('LOVETIK_ERR', error?.message || error);
  }
}

async function testSlbjs() {
  try {
    const res = await fetch(`https://tdownv4.sl-bjs.workers.dev/?down=${encodeURIComponent(link)}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(25000),
    });
    const text = await res.text();
    out('SLBJS', res.status, text.slice(0, 900));
  } catch (error) {
    out('SLBJS_ERR', error?.message || error);
  }
}

async function testTikWM() {
  try {
    const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(link)}&hd=1`, {
      headers: { 'User-Agent': UA, Referer: 'https://www.tikwm.com/' },
      signal: AbortSignal.timeout(25000),
    });
    const text = await res.text();
    out('TIKWM', res.status, text.slice(0, 900));
  } catch (error) {
    out('TIKWM_ERR', error?.message || error);
  }
}

out('TARGET', link);
await testRedirect();
await testTikWM();
await testSSSTik();
await testLoveTik();
await testSlbjs();
out('DONE');
