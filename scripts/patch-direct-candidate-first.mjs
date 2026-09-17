import { readFile, writeFile } from 'node:fs/promises';

const apiFile = new URL('../api/telegram.js', import.meta.url);
let api = await readFile(apiFile, 'utf8');

const oldCompressionGuard = "  const allowSocialCompression = options.platform && options.platform !== 'youtube';";
const newCompressionGuard = "  const allowSocialCompression = options.allowCompression !== false && options.platform && options.platform !== 'youtube';";
if (api.includes(oldCompressionGuard)) {
  api = api.replace(oldCompressionGuard, newCompressionGuard);
} else if (!api.includes(newCompressionGuard)) {
  throw new Error('deliverVideo compression guard marker not found');
}

const oldLoop = `    for (const candidate of candidates.slice(0, 6)) {\n      sentVideo = await deliverVideo(chatId, candidate, title, baseUrl, {\n        platform,\n        duration: media.duration,\n        sourceUrl: url,\n      });\n      if (sentVideo) break;\n    }`;
const newLoop = `    for (const candidate of candidates.slice(0, 6)) {\n      sentVideo = await deliverVideo(chatId, candidate, title, baseUrl, {\n        platform,\n        duration: media.duration,\n        sourceUrl: url,\n        // Exhaust TikWM/other direct candidates first. Do not spend CPU compressing\n        // the first oversized HD candidate before trying a smaller alternative.\n        allowCompression: false,\n      });\n      if (sentVideo) break;\n    }`;
if (api.includes(oldLoop)) {
  api = api.replace(oldLoop, newLoop);
} else if (!api.includes('allowCompression: false')) {
  throw new Error('main candidate delivery loop marker not found');
}

await writeFile(apiFile, api);

const socialFile = new URL('../src/social-video.js', import.meta.url);
let social = await readFile(socialFile, 'utf8');
const codecMarker = "    '-c:v', 'libx264',\n    '-preset', String(process.env.SOCIAL_COMPRESS_PRESET || 'fast'),";
const codecReplacement = "    '-c:v', 'libx264',\n    '-threads', String(process.env.SOCIAL_COMPRESS_THREADS || '2'),\n    '-preset', String(process.env.SOCIAL_COMPRESS_PRESET || 'veryfast'),";
if (social.includes(codecMarker)) {
  social = social.replace(codecMarker, codecReplacement);
} else if (!social.includes("SOCIAL_COMPRESS_THREADS")) {
  throw new Error('social-video ffmpeg codec marker not found');
}
await writeFile(socialFile, social);

console.log('Applied direct-candidate-first delivery + bounded ffmpeg threads patch');
