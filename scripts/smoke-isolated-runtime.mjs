import { resolveMedia, chooseBestVideo } from '../src/bot/media-resolver.js';
import { localMediaLane } from '../src/bot/job-lanes.js';
import { heavyWorkerConfigured } from '../src/heavy-worker-dispatch.js';
import { prepareWhatsAppStatusHQ } from '../src/status-hq.js';

const CASES = [
  ['tiktok', 'https://vt.tiktok.com/ZSqqYxc13/'],
  ['instagram', 'https://www.instagram.com/reel/DdVLsscjj2o/?stkn=MXV3a2hncmE3cWZheQ=='],
  ['threads', 'https://www.threads.com/share/BALVYg5Lmq/'],
  ['youtube', 'https://youtu.be/RKdxQwnRRqw?si=GJX9HDe4OBsxwBYQ'],
];
const STATUS_URL = 'https://www.tiktok.com/@j_k_123_7/video/7654589734496341262';

async function verifyResolver(platform, url) {
  const started = Date.now();
  const media = await resolveMedia(platform, url);
  const best = chooseBestVideo(media?.videos || []);
  const count = (media?.videos?.length || 0) + (media?.images?.length || 0) + (media?.audios?.length || 0);
  if (!count) throw new Error(`${platform}: resolver returned no media`);
  console.log('ISOLATION_SMOKE_RESOLVER', JSON.stringify({
    platform,
    ok: true,
    ms: Date.now() - started,
    videos: media?.videos?.length || 0,
    images: media?.images?.length || 0,
    audios: media?.audios?.length || 0,
    bestSource: best?.source || null,
  }));
}

async function verifyStatusHq() {
  const started = Date.now();
  let prepared = null;
  try {
    const media = await resolveMedia('tiktok', STATUS_URL);
    const best = chooseBestVideo(media?.videos || []);
    if (!best) throw new Error('Status HQ smoke could not resolve a source video');

    prepared = await localMediaLane(() => prepareWhatsAppStatusHQ({
      sourceUrl: media?.canonicalUrl || STATUS_URL,
      platform: 'tiktok',
      video: best,
    }));

    if (!prepared?.filePath || !prepared?.size) throw new Error('Status HQ smoke produced no output');
    console.log('ISOLATION_SMOKE_STATUS_HQ', JSON.stringify({
      ok: true,
      ms: Date.now() - started,
      size: prepared.size,
      tier: prepared.profile?.tier || null,
      videoKbps: prepared.profile?.videoKbps || null,
      attempt: prepared.attempt || null,
    }));
  } finally {
    await prepared?.cleanup?.().catch(() => {});
  }
}

async function main() {
  console.log('ISOLATION_SMOKE_START');
  if (!heavyWorkerConfigured()) throw new Error('GitHub heavy worker token is not configured');
  console.log('ISOLATION_SMOKE_HEAVY_WORKER', JSON.stringify({ ok: true }));

  for (const [platform, url] of CASES) {
    await verifyResolver(platform, url);
  }
  await verifyStatusHq();
  console.log('ISOLATION_SMOKE_PASSED');
}

main().catch((error) => {
  console.error('ISOLATION_SMOKE_FAILED', error?.stack || error?.message || error);
  process.exit(1);
});
