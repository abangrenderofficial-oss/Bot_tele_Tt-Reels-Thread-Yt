import { readFile, writeFile } from 'node:fs/promises';

function replaceRequired(source, from, to, label) {
  if (source.includes(to)) return source;
  if (!source.includes(from)) throw new Error(`patch-tiktok-size-fallback: marker not found: ${label}`);
  return source.replace(from, to);
}

// 1) After all direct TikTok candidates fail, run exactly one bounded social-video
// compression attempt before the older yt-dlp rescue path. This avoids repeatedly
// re-encoding several TikWM candidates and uses the compressor that already has
// bounded ffmpeg threads.
const apiFile = new URL('../api/telegram.js', import.meta.url);
let api = await readFile(apiFile, 'utf8');

const rescueMarker = `    if (!sentVideo && platform === 'tiktok' && (!jobFence || isJobFenceActive(jobFence))) {\n      let rescued = null;`;
const compressionBlock = `    // TikTok oversize fallback: when Telegram URL fetch/server upload both fail,\n    // compress only the best resolved candidate once before invoking yt-dlp rescue.\n    if (!sentVideo && platform === 'tiktok' && (!jobFence || isJobFenceActive(jobFence))) {\n      const compressionCandidate = chooseBestVideo(media.videos || []);\n      if (compressionCandidate) {\n        try {\n          console.info('TikTok oversize fallback: compressing best resolved candidate once.');\n          sentVideo = await deliverCompressedSocial(\n            chatId,\n            compressionCandidate,\n            title,\n            media.duration,\n            media?.canonicalUrl || url,\n          );\n        } catch (error) {\n          console.warn('TikTok bounded compression fallback failed:', error?.code, error?.message);\n        }\n      }\n    }\n\n${rescueMarker}`;

if (!api.includes('TikTok oversize fallback: compressing best resolved candidate once.')) {
  api = replaceRequired(api, rescueMarker, compressionBlock, 'TikTok rescue insertion point');
}

// 2) Do not expose the old TikTok CDN URL as a misleading "Download HD" button
// after delivery has already failed. TikTok CDN links are short-lived and often
// unusable from the user's browser. Other platforms keep their existing fallback.
const legacyFallback = `    if (!sentVideo && (!jobFence || isJobFenceActive(jobFence))) {\n      const best = chooseBestVideo(media.videos);\n      if (best) {\n        await sendDownloadButton(\n          chatId,\n          \`\${title}\\n\\nBot dah cuba direct URL, relay, server upload dan HQ compression tetapi fail ini masih tidak dapat dihantar melalui Telegram cloud.\`,\n          best.url,\n          \`⬇️ Download \${best.quality || 'video'}\`,\n        );\n      }\n    }`;
const saferFallback = `    if (!sentVideo && (!jobFence || isJobFenceActive(jobFence))) {\n      if (platform === 'tiktok') {\n        await sendMessage(\n          chatId,\n          '❌ Video TikTok ini belum berjaya dihantar terus. Cuba hantar semula link yang sama sekali lagi.',\n        );\n      } else {\n        const best = chooseBestVideo(media.videos);\n        if (best) {\n          await sendDownloadButton(\n            chatId,\n            \`\${title}\\n\\nBot dah cuba direct URL, relay, server upload dan HQ compression tetapi fail ini masih tidak dapat dihantar melalui Telegram cloud.\`,\n            best.url,\n            \`⬇️ Download \${best.quality || 'video'}\`,\n          );\n        }\n      }\n    }`;
api = replaceRequired(api, legacyFallback, saferFallback, 'TikTok final fallback copy');

await writeFile(apiFile, api);

// 3) Keep the legacy TikTok rescue as a final fallback, but cap x264 threads and
// leave more size headroom. The previous runtime used dozens of x264 threads and
// stalled/crashed on a 1080x1920 60fps TikTok during our production test.
const rescueFile = new URL('../src/tiktok-rescue.js', import.meta.url);
let rescue = await readFile(rescueFile, 'utf8');

rescue = replaceRequired(
  rescue,
  '  const targetBytes = Math.floor(maxBytes * 0.90);',
  '  const targetBytes = Math.floor(maxBytes * 0.78);',
  'rescue size safety margin',
);

const codecMarker = `      '-c:v', 'libx264',\n      '-preset', String(process.env.TIKTOK_RESCUE_COMPRESS_PRESET || 'veryfast'),`;
const codecReplacement = `      '-c:v', 'libx264',\n      '-threads', String(process.env.TIKTOK_RESCUE_COMPRESS_THREADS || '4'),\n      '-preset', String(process.env.TIKTOK_RESCUE_COMPRESS_PRESET || 'veryfast'),`;
rescue = replaceRequired(rescue, codecMarker, codecReplacement, 'rescue ffmpeg thread cap');

rescue = replaceRequired(
  rescue,
  "    commandOptions(Number(process.env.TIKTOK_RESCUE_COMPRESS_TIMEOUT_MS || 50_000)),",
  "    commandOptions(Number(process.env.TIKTOK_RESCUE_COMPRESS_TIMEOUT_MS || 120_000)),",
  'rescue compression timeout',
);

await writeFile(rescueFile, rescue);
console.log('Applied bounded TikTok oversize compression fallback + safe final TikTok error');
