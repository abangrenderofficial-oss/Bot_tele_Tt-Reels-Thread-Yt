import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const PATCHES = [
  'scripts/patch-runtime.mjs',
  'scripts/patch-upload-mirror.mjs',
  'scripts/patch-start-copy.mjs',
  'scripts/patch-status-preserve.mjs',
  'scripts/patch-heavy-worker.mjs',
  'scripts/patch-heavy-limit-500.mjs',
  'scripts/patch-apple-live-routing.mjs',
  'scripts/patch-gallery-preview-aspect.mjs',
  'scripts/patch-recovery.mjs',
  'scripts/patch-tiktok-cdn-rescue-v2.mjs',
  'scripts/patch-menu.mjs',
  'scripts/patch-sync-webhook.mjs',
  'scripts/patch-direct-candidate-first.mjs',
  'scripts/patch-tikwm-post-fallback.mjs',
];

for (const script of PATCHES) {
  const result = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Railway runtime patch failed: ${script} exited with ${result.status}`);
  }
}

const [api, social] = await Promise.all([
  readFile(new URL('../api/telegram.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/social-video.js', import.meta.url), 'utf8'),
]);

const required = [
  ['sync webhook recovery', api.includes('sync-recovery-v2')],
  ['direct candidate before compression', api.includes('allowCompression: false')],
  ['TikTok canonical rescue', api.includes('canonicalTikTokUrl') || api.includes('tiktokCanonicalUrl')],
  ['bounded social-video threads', social.includes("SOCIAL_COMPRESS_THREADS || '2'")],
  ['Railway-safe social-video preset', social.includes("SOCIAL_COMPRESS_PRESET || 'veryfast'")],
];

const missing = required.filter(([, ok]) => !ok).map(([name]) => name);
if (missing.length) {
  throw new Error(`Railway runtime patch verification failed: ${missing.join(', ')}`);
}

console.log('Railway runtime patches verified: sync webhook, candidate fallback, TikTok rescue, bounded ffmpeg.');
