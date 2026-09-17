import { readFile, writeFile } from 'node:fs/promises';

function replaceBetween(source, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) return source;
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

// Existing downloader cloud patches.
const downloaderFile = new URL('../src/downloader.js', import.meta.url);
let s = await readFile(downloaderFile, 'utf8');

if (!s.includes("./youtube-free.js")) s = "import { parseYouTubeFree } from './youtube-free.js';\n" + s;
s = s.replace("'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',", "'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',");
s = s.replace("'--remote-components', 'ejs:github',\n      '--',", "'--remote-components', 'ejs:github',\n      '--extractor-args', 'youtube:player_client=tv_simply,web_embedded',\n      '--force-ipv4',\n      '--',");
s = s.replace('return parseYouTubeWithPiped(url).catch((fallbackError) => {', 'return parseYouTubeFree(url).catch((fallbackError) => {');
await writeFile(downloaderFile, s);

// Add a file-upload helper so Status HQ images are not recompressed by Telegram.
const telegramFile = new URL('../src/telegram.js', import.meta.url);
let telegramSource = await readFile(telegramFile, 'utf8');
if (!telegramSource.includes('export async function sendDocumentFileUpload(')) {
  telegramSource += `\n\nexport async function sendDocumentFileUpload(chatId, filePath, caption = '', fileName = '') {\n  if (!filePath) throw new Error('Local document path is missing.');\n\n  const fileStat = await stat(filePath);\n  const limit = uploadLimitBytes();\n  if (fileStat.size > limit) {\n    const err = new Error(\`Document is too large for the configured Telegram upload limit (\${fileStat.size} bytes).\`);\n    err.code = 'TELEGRAM_FILE_TOO_LARGE';\n    throw err;\n  }\n\n  const buffer = await readFile(filePath);\n  const extension = path.extname(filePath).replace(/^\\./, '').toLowerCase() || 'bin';\n  const contentType = extension === 'jpg' || extension === 'jpeg'\n    ? 'image/jpeg'\n    : extension === 'png'\n      ? 'image/png'\n      : 'application/octet-stream';\n  const form = new FormData();\n  form.set('chat_id', String(chatId));\n  form.set('caption', caption.slice(0, 1024));\n  form.set('document', new Blob([buffer], { type: contentType }), fileName || \`file.\${extension}\`);\n\n  const response = await fetch(telegramEndpoint('sendDocument'), {\n    method: 'POST',\n    body: form,\n    signal: AbortSignal.timeout(Number(process.env.TELEGRAM_UPLOAD_TIMEOUT_MS || 55000)),\n  });\n  return parseTelegramResponse(response, 'sendDocument');\n}\n`;
  await writeFile(telegramFile, telegramSource);
}

// Patch the webhook entrypoint with photo preview + Status HQ image support.
const apiFile = new URL('../api/telegram.js', import.meta.url);
let apiSource = await readFile(apiFile, 'utf8');

if (!apiSource.includes("../src/status-image-hq.js")) {
  apiSource = apiSource.replace(
    "import { prepareWhatsAppStatusHQ } from '../src/status-hq.js';",
    "import { prepareWhatsAppStatusHQ } from '../src/status-hq.js';\nimport { prepareWhatsAppStatusImageHQ } from '../src/status-image-hq.js';",
  );
}

if (!apiSource.includes('  sendDocumentFileUpload,')) {
  apiSource = apiSource.replace(
    '  sendChatAction,\n  sendDownloadButton,',
    '  sendChatAction,\n  sendDocumentFileUpload,\n  sendDownloadButton,',
  );
}

if (!apiSource.includes('function imageStatusButton()')) {
  const marker = "function auditDeleteButton(profileMessageId = '') {";
  const insertion = `function imageStatusButton() {\n  return {\n    reply_markup: {\n      inline_keyboard: [[{ text: '📱 Status HQ', callback_data: MEDIA_STATUS_HQ }]],\n    },\n  };\n}\n\n`;
  apiSource = apiSource.replace(marker, `${insertion}${marker}`);
}

const statusButtonFunction = `async function processStatusButton(callbackQuery) {\n  const action = String(callbackQuery?.data || '');\n  if (!action.startsWith(MEDIA_STATUS_HQ)) return false;\n\n  const chatId = callbackQuery?.message?.chat?.id;\n  const videoFileId = callbackQuery?.message?.video?.file_id;\n  const imageFileId = Array.isArray(callbackQuery?.message?.photo)\n    ? callbackQuery.message.photo.at(-1)?.file_id\n    : '';\n  const isImage = Boolean(imageFileId && !videoFileId);\n  const fileId = videoFileId || imageFileId;\n  const caption = callbackQuery?.message?.caption || '';\n  const sourceUrl = callbackSourceUrl(action, MEDIA_STATUS_HQ, caption);\n  const sourcePlatform = sourceUrl ? detectPlatform(sourceUrl) : null;\n  if (!chatId) return true;\n\n  const claimed = await claimMediaButtons(callbackQuery);\n  if (!claimed) {\n    await telegram('answerCallbackQuery', {\n      callback_query_id: callbackQuery.id,\n      text: 'Pilihan ini dah digunakan. Hantar media semula untuk buat lagi.',\n      show_alert: false,\n    }).catch(() => {});\n    return true;\n  }\n\n  await telegram('answerCallbackQuery', { callback_query_id: callbackQuery.id }).catch(() => {});\n  await sendChatAction(chatId, isImage ? 'upload_document' : 'upload_video').catch(() => {});\n\n  let prepared = null;\n  const progress = await startStatusProgress(chatId);\n  try {\n    if (!fileId) throw new Error('Media file_id missing from callback message.');\n\n    if (isImage) {\n      const telegramImage = await getTelegramFileSource(fileId);\n      prepared = await prepareWhatsAppStatusImageHQ({ image: telegramImage });\n      await progress.complete();\n      await sendDocumentFileUpload(\n        chatId,\n        prepared.filePath,\n        'Gambar ni dah ready untuk upload ke status ✅',\n        'status-hq.jpg',\n      );\n    } else {\n      try {\n        const telegramVideo = await getTelegramFileSource(fileId);\n        prepared = await prepareWhatsAppStatusHQ({\n          sourceUrl: '',\n          platform: 'telegram',\n          video: telegramVideo,\n        });\n      } catch (telegramFileError) {\n        console.warn('Status HQ Telegram-file path failed, trying source URL:', telegramFileError?.code, telegramFileError?.message);\n        if (!sourceUrl || !sourcePlatform) throw telegramFileError;\n        prepared = await prepareStatusFromSourceUrl(sourceUrl, sourcePlatform);\n      }\n\n      await progress.complete();\n      await sendVideoFileUpload(\n        chatId,\n        prepared.filePath,\n        'Video ni dah ready untuk upload ke status ✅',\n      );\n    }\n\n    await progress.remove();\n  } catch (error) {\n    console.error('Status HQ button failed:', error?.code, error?.message);\n    await progress.remove();\n    await sendMessage(\n      chatId,\n      isImage\n        ? '❌ Status HQ tak dapat disiapkan untuk gambar ini. Hantar gambar semula dan cuba lagi.'\n        : '❌ Status HQ tak dapat disiapkan untuk video ini. Hantar video/link semula dan cuba lagi.',\n    ).catch(() => {});\n  } finally {\n    if (prepared?.cleanup) await prepared.cleanup().catch(() => {});\n  }\n  return true;\n}\n\n`;
apiSource = replaceBetween(
  apiSource,
  'async function processStatusButton(callbackQuery) {',
  'async function prepareLiveFromSourceUrl(url, platform, baseUrl) {',
  statusButtonFunction,
);

// Remove the extra callback toast for Live Wallpaper; the progress message is the UI.
apiSource = apiSource.replace(
  `  await telegram('answerCallbackQuery', {\n    callback_query_id: callbackQuery.id,\n    text: 'Live Wallpaper iPhone sedang disediakan…',\n  }).catch(() => {});`,
  `  await telegram('answerCallbackQuery', { callback_query_id: callbackQuery.id }).catch(() => {});`,
);

if (!apiSource.includes('function uploadedPhotoCaption(photo = {})')) {
  const photoFunctions = `function uploadedPhotoCaption(photo = {}) {\n  const width = Number(photo.width || 0);\n  const height = Number(photo.height || 0);\n  return [\n    '🖼️ Gambar diterima',\n    width && height ? \`📐 \${width} × \${height}\` : null,\n    photo.file_size ? \`📦 \${formatFileSize(photo.file_size)}\` : null,\n    '',\n    'Pilih fungsi:',\n  ].filter((line) => line !== null).join('\\n').slice(0, 1024);\n}\n\nasync function processUploadedPhoto(message) {\n  const chatId = message?.chat?.id;\n  const photo = Array.isArray(message?.photo) ? message.photo.at(-1) : null;\n  if (!chatId || !photo?.file_id) return false;\n\n  await sendChatAction(chatId, 'upload_photo').catch(() => {});\n  await telegram('sendPhoto', {\n    chat_id: chatId,\n    photo: photo.file_id,\n    caption: uploadedPhotoCaption(photo),\n    ...imageStatusButton(),\n  });\n  return true;\n}\n\n`;
  apiSource = apiSource.replace('async function processUploadedVideo(message) {', `${photoFunctions}async function processUploadedVideo(message) {`);
}

if (!apiSource.includes('await processUploadedPhoto(message);')) {
  apiSource = apiSource.replace(
    `  if (message?.video?.file_id) {\n    await processUploadedVideo(message);\n    return;\n  }`,
    `  if (Array.isArray(message?.photo) && message.photo.length) {\n    await processUploadedPhoto(message);\n    return;\n  }\n\n  if (message?.video?.file_id) {\n    await processUploadedVideo(message);\n    return;\n  }`,
  );
}

apiSource = apiSource.replace(
  'Hantar satu link TikTok, Instagram, Threads, X/Twitter atau YouTube, atau upload video dari gallery.',
  'Hantar satu link TikTok, Instagram, Threads, X/Twitter atau YouTube, atau upload video/gambar dari gallery.',
);

await writeFile(apiFile, apiSource);
console.log('Applied cloud extractor + media action runtime patches');
