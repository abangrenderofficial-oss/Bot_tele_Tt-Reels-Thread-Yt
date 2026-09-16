import { parseMedia, chooseBestVideo } from '../src/downloader.js';
import { prepareWhatsAppStatusHQ } from '../src/status-hq.js';

const savedLink = process.env.STATUS_TEST_URL || 'https://vt.tiktok.com/ZSgbsv3MX';
const controlLink = process.env.STATUS_CONTROL_URL || 'https://vt.tiktok.com/ZSqqYxc13/';
const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';

async function checkSavedLink(url) {
  try {
    const r = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': ua, Accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(15000)
    });
    const loc = r.headers.get('location') || '';
    console.log('SAVED_LINK_REDIRECT', r.status, loc || '(none)');
    try { await r.body?.cancel(); } catch {}
    if (/\/video\/\d+/i.test(loc)) return { alive: true, canonical: new URL(loc, url).toString() };
    if (/^https:\/\/www\.tiktok\.com\/?\?_r=1/i.test(loc)) return { alive: false, reason: 'expired_or_removed_shortlink' };
  } catch (e) {
    console.log('SAVED_LINK_CHECK_ERROR', String(e?.message || e));
  }
  return { alive: true, canonical: url };
}

async function runStatus(url, label) {
  console.log('RUN_STATUS', label, url);
  const media = await parseMedia(url);
  console.log('MEDIA_OK', label, media?.platform, 'duration=', media?.duration, 'videos=', media?.videos?.length || 0);
  const best = chooseBestVideo(media?.videos || []);
  if (!best) throw new Error(`${label}: no video candidate`);
  console.log('BEST_OK', label, best.quality, best.width, best.height, new URL(best.url).host);
  let prepared;
  try {
    prepared = await prepareWhatsAppStatusHQ({ sourceUrl: url, platform: 'tiktok', video: best });
    console.log('STATUS_HQ_OK', label, prepared.quality, 'clips=', prepared.clips.length, 'profile=', prepared.profile?.mode);
    for (const c of prepared.clips) {
      console.log('CLIP_OK', c.index, '/', c.count, 'duration=', c.duration, 'bytes=', c.size);
      if (!c.filePath || !c.size) throw new Error(`${label}: invalid generated clip`);
    }
    return true;
  } finally {
    if (prepared?.cleanup) await prepared.cleanup();
  }
}

console.log('SAVED_LINK', savedLink);
const saved = await checkSavedLink(savedLink);
if (saved.alive) {
  await runStatus(saved.canonical || savedLink, 'saved-link');
} else {
  console.log('SAVED_LINK_DEAD', saved.reason);
  console.log('CONTROL_LINK', controlLink);
  await runStatus(controlLink, 'control-link');
}
