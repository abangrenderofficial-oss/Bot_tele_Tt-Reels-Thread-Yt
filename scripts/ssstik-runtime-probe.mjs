const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
const pageUrl = 'https://ssstik.io/en-1';

function snippet(text, index, radius = 900) {
  if (index < 0) return '';
  return text.slice(Math.max(0, index - radius), Math.min(text.length, index + radius)).replace(/\s+/g, ' ');
}

function dumpNeedles(label, text) {
  for (const needle of ['s_tt', 's_furl', 'hx-vals', '_gcaptcha_pt', 'atob(', 'eval(', 'fromCharCode', 'window[', 'window.', 'document.cookie']) {
    let from = 0;
    let count = 0;
    const lower = text.toLowerCase();
    const target = needle.toLowerCase();
    while (count < 8) {
      const idx = lower.indexOf(target, from);
      if (idx < 0) break;
      console.log(`PROBE ${label} ${needle} #${count + 1}`, snippet(text, idx));
      from = idx + target.length;
      count += 1;
    }
  }
}

const res = await fetch(pageUrl, {
  headers: {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  redirect: 'follow',
  signal: AbortSignal.timeout(30000),
});
const html = await res.text();
console.log('HOME', res.status, res.url, 'bytes', html.length);
dumpNeedles('HTML', html);

const inlineScripts = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
console.log('INLINE_SCRIPT_COUNT', inlineScripts.length);
inlineScripts.forEach((js, i) => {
  if (/s_tt|s_furl|hx-vals|_gcaptcha_pt|atob\(|eval\(|fromCharCode/i.test(js)) {
    console.log('INLINE_INTERESTING', i, 'bytes', js.length, js.slice(0, 800).replace(/\s+/g, ' '));
    dumpNeedles(`INLINE_${i}`, js);
  }
});

const srcs = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
  .map((m) => { try { return new URL(m[1], res.url).toString(); } catch { return ''; } })
  .filter(Boolean);
console.log('EXTERNAL_SCRIPT_COUNT', srcs.length, srcs.join(' | '));
for (const src of srcs) {
  try {
    const jsRes = await fetch(src, { headers: { 'User-Agent': UA, Accept: '*/*', Referer: res.url }, signal: AbortSignal.timeout(20000) });
    const js = await jsRes.text();
    if (/s_tt|s_furl|hx-vals|_gcaptcha_pt|atob\(|eval\(|fromCharCode/i.test(js)) {
      console.log('EXTERNAL_INTERESTING', src, jsRes.status, 'bytes', js.length);
      dumpNeedles(`EXTERNAL_${new URL(src).pathname}`, js);
    }
  } catch (e) {
    console.log('EXTERNAL_FAIL', src, e?.message || e);
  }
}
