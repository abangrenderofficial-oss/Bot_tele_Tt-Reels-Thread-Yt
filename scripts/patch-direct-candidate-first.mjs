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

if (!api.includes('allowCompression: false')) {
  const loopStart = api.indexOf('for (const candidate of candidates.slice(0, 6)) {');
  if (loopStart < 0) throw new Error('main candidate loop start not found');

  const callStart = api.indexOf('sentVideo = await deliverVideo(chatId, candidate, title, baseUrl, {', loopStart);
  if (callStart < 0) throw new Error('main candidate deliverVideo call not found');

  // Find the options object's closing line for this deliverVideo call. Runtime patches may
  // add extra fields, so do not depend on the exact sourceUrl/fence/canonical-url layout.
  const closeMatch = /\n\s*\}\);/.exec(api.slice(callStart));
  if (!closeMatch) throw new Error('main candidate deliverVideo options close not found');
  const closeIndex = callStart + closeMatch.index;
  const closeLine = closeMatch[0];
  const indentMatch = closeLine.match(/\n(\s*)\}\);/);
  const closeIndent = indentMatch?.[1] || '      ';
  const fieldIndent = `${closeIndent}  `;

  api = `${api.slice(0, closeIndex)}\n${fieldIndent}// Try all resolved direct candidates before expensive compression.\n${fieldIndent}allowCompression: false,${api.slice(closeIndex)}`;
}

await writeFile(apiFile, api);

const socialFile = new URL('../src/social-video.js', import.meta.url);
let social = await readFile(socialFile, 'utf8');
const codecMarker = "    '-c:v', 'libx264',\n    '-preset', String(process.env.SOCIAL_COMPRESS_PRESET || 'fast'),";
const codecReplacement = "    '-c:v', 'libx264',\n    '-threads', String(process.env.SOCIAL_COMPRESS_THREADS || '2'),\n    '-preset', String(process.env.SOCIAL_COMPRESS_PRESET || 'veryfast'),";
if (social.includes(codecMarker)) {
  social = social.replace(codecMarker, codecReplacement);
} else if (!social.includes('SOCIAL_COMPRESS_THREADS')) {
  throw new Error('social-video ffmpeg codec marker not found');
}
await writeFile(socialFile, social);

console.log('Applied direct-candidate-first delivery + bounded ffmpeg threads patch');
