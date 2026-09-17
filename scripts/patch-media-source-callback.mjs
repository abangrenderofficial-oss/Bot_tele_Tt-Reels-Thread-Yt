import { readFile, writeFile } from 'node:fs/promises';

const apiFile = new URL('../api/telegram.js', import.meta.url);
let source = await readFile(apiFile, 'utf8');

function replaceRequired(from, to, label) {
  if (source.includes(to)) return;
  if (!source.includes(from)) throw new Error(`patch-media-source-callback: marker not found: ${label}`);
  source = source.replace(from, to);
}

const oldCallbackData = `function callbackData(prefix, sourceUrl = '') {\n  const raw = String(sourceUrl || '').trim();\n  if (!raw) return prefix;\n\n  try {\n    const compact = new URL(raw);\n    compact.search = '';\n    compact.hash = '';\n    const data = \`\${prefix}|\${compact.toString()}\`;\n    if (Buffer.byteLength(data, 'utf8') <= 64) return data;\n  } catch {}\n\n  return prefix;\n}`;

const newCallbackData = `function compactMediaSourceToken(sourceUrl = '') {\n  const raw = String(sourceUrl || '').trim();\n  if (!raw) return '';\n\n  try {\n    const parsed = new URL(raw);\n    const host = parsed.hostname.toLowerCase();\n    if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {\n      const videoId = parsed.pathname.match(/\\/video\\/(\\d+)/)?.[1] || '';\n      if (videoId) return \`tt:\${videoId}\`;\n\n      if (host === 'vt.tiktok.com' || host === 'vm.tiktok.com') {\n        const token = parsed.pathname.split('/').filter(Boolean)[0] || '';\n        if (/^[A-Za-z0-9_-]{4,40}$/.test(token)) return \`vt:\${token}\`;\n      }\n    }\n  } catch {}\n\n  return '';\n}\n\nfunction callbackData(prefix, sourceUrl = '') {\n  const raw = String(sourceUrl || '').trim();\n  if (!raw) return prefix;\n\n  const token = compactMediaSourceToken(raw);\n  if (token) {\n    const tokenData = \`\${prefix}|\${token}\`;\n    if (Buffer.byteLength(tokenData, 'utf8') <= 64) return tokenData;\n  }\n\n  try {\n    const compact = new URL(raw);\n    compact.search = '';\n    compact.hash = '';\n    const data = \`\${prefix}|\${compact.toString()}\`;\n    if (Buffer.byteLength(data, 'utf8') <= 64) return data;\n  } catch {}\n\n  return prefix;\n}`;

replaceRequired(oldCallbackData, newCallbackData, 'compact callback source token');

const oldCallbackSource = `function callbackSourceUrl(action, prefix, caption = '') {\n  const embedded = action.startsWith(\`\${prefix}|\`)\n    ? action.slice(prefix.length + 1)\n    : '';\n  return extractFirstUrl(caption) || extractFirstUrl(embedded);\n}`;

const newCallbackSource = `function callbackSourceUrl(action, prefix, caption = '') {\n  const captionUrl = extractFirstUrl(caption);\n  if (captionUrl) return captionUrl;\n\n  const embedded = action.startsWith(\`\${prefix}|\`)\n    ? action.slice(prefix.length + 1)\n    : '';\n\n  const tikTokId = embedded.match(/^tt:(\\d{10,25})$/)?.[1] || '';\n  if (tikTokId) return \`https://www.tiktok.com/@_/video/\${tikTokId}\`;\n\n  const shortToken = embedded.match(/^vt:([A-Za-z0-9_-]{4,40})$/)?.[1] || '';\n  if (shortToken) return \`https://vt.tiktok.com/\${shortToken}/\`;\n\n  return extractFirstUrl(embedded);\n}`;

replaceRequired(oldCallbackSource, newCallbackSource, 'callback source decoder');

// patch-heavy-worker owns the current Status HQ handler. Preserve its image/gallery/
// heavy-worker logic and only replace the normal video retrieval block.
const oldStatusVideoPath = `      try {\n        const telegramVideo = await getTelegramFileSource(fileId);\n        prepared = await prepareWhatsAppStatusHQ({ sourceUrl: '', platform: 'telegram', video: telegramVideo });\n      } catch (telegramFileError) {\n        console.warn('Status HQ Telegram-file path failed, trying source URL:', telegramFileError?.code, telegramFileError?.message);\n        if (!sourceUrl || !sourcePlatform) throw telegramFileError;\n        prepared = await prepareStatusFromSourceUrl(sourceUrl, sourcePlatform);\n      }`;

const newStatusVideoPath = `      let sourceError = null;\n      if (sourceUrl && sourcePlatform) {\n        try {\n          // Downloader messages carry a compact source token. Re-fetch the public source\n          // instead of Telegram getFile, which refuses larger bot-hosted files.\n          prepared = await prepareStatusFromSourceUrl(sourceUrl, sourcePlatform);\n        } catch (error) {\n          sourceError = error;\n          console.warn('Status HQ source path failed, trying Telegram file:', error?.code, error?.message);\n        }\n      }\n\n      if (!prepared) {\n        try {\n          const telegramVideo = await getTelegramFileSource(fileId);\n          prepared = await prepareWhatsAppStatusHQ({ sourceUrl: '', platform: 'telegram', video: telegramVideo });\n        } catch (telegramFileError) {\n          if (sourceError) throw sourceError;\n          throw telegramFileError;\n        }\n      }`;

replaceRequired(oldStatusVideoPath, newStatusVideoPath, 'Status HQ source-first video path');

await writeFile(apiFile, source);
console.log('Applied compact media source callbacks + source-first Status HQ routing');
