import { readFile, writeFile } from 'node:fs/promises';

const downloaderFile = new URL('../src/downloader.js', import.meta.url);
const apiFile = new URL('../api/telegram.js', import.meta.url);

let downloader = await readFile(downloaderFile, 'utf8');

function replaceRequired(source, from, to, label) {
  if (source.includes(to)) return source;
  if (!source.includes(from)) throw new Error(`patch-tiktok-cdn-rescue-v2: marker not found: ${label}`);
  return source.replace(from, to);
}

const constantMarker = "const TIKWM_ORIGIN = 'https://www.tikwm.com';";
const constantReplacement = `${constantMarker}\nconst TIKTOK_BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';`;
downloader = replaceRequired(downloader, constantMarker, constantReplacement, 'TikTok browser UA constant');

const dataMarker = `  const data = payload.data;\n  const videos = [];`;
const dataReplacement = `  const data = payload.data;\n  const authorHandle = String(data?.author?.unique_id || data?.author?.uniqueId || '').trim().replace(/^@/, '');\n  const videoId = String(data?.id || '').trim();\n  const canonicalUrl = videoId\n    ? \`https://www.tiktok.com/@\${encodeURIComponent(authorHandle || '_')}/video/\${encodeURIComponent(videoId)}\`\n    : url;\n  const tiktokCdnHeaders = {\n    'User-Agent': TIKTOK_BROWSER_USER_AGENT,\n    Referer: canonicalUrl || 'https://www.tiktok.com/',\n    Accept: 'video/webm,video/mp4,video/*;q=0.9,*/*;q=0.8',\n  };\n  const videos = [];`;
downloader = replaceRequired(downloader, dataMarker, dataReplacement, 'TikWM canonical URL metadata');

const videoMarker = `    videos.push({\n      url: direct,\n      sourceUrl: url,\n      quality,\n      width: data.width ?? null,\n      height: data.height ?? null,\n      ext: 'mp4',\n      hasAudio: true,\n      source: 'direct',\n      headers: null,\n      filesize: null,\n    });`;
const videoReplacement = `    videos.push({\n      url: direct,\n      sourceUrl: canonicalUrl,\n      quality,\n      width: data.width ?? null,\n      height: data.height ?? null,\n      ext: 'mp4',\n      hasAudio: true,\n      source: 'direct',\n      headers: tiktokCdnHeaders,\n      filesize: null,\n    });`;
downloader = replaceRequired(downloader, videoMarker, videoReplacement, 'TikTok CDN browser headers');

const returnMarker = `    thumbnail: absoluteUrl(data.cover || data.origin_cover),\n    duration: data.duration ?? null,\n    images,`;
const returnReplacement = `    thumbnail: absoluteUrl(data.cover || data.origin_cover),\n    duration: data.duration ?? null,\n    canonicalUrl,\n    images,`;
downloader = replaceRequired(downloader, returnMarker, returnReplacement, 'TikTok canonical URL return');

await writeFile(downloaderFile, downloader);

let api = await readFile(apiFile, 'utf8');
const rescueMarker = `        rescued = await prepareTikTokTelegramRescue(url, configuredUploadLimit());`;
const rescueReplacement = `        const rescueSourceUrl = media?.canonicalUrl || url;\n        rescued = await prepareTikTokTelegramRescue(rescueSourceUrl, configuredUploadLimit());`;
api = replaceRequired(api, rescueMarker, rescueReplacement, 'canonical TikTok rescue URL');
await writeFile(apiFile, api);

console.log('Applied TikTok CDN headers + canonical URL rescue v2');
