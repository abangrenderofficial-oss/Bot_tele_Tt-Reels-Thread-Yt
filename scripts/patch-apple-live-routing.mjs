import { readFile, writeFile } from 'node:fs/promises';

function replaceBetween(source, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`Apple Live routing patch marker missing: ${startMarker}`);
  }
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

const apiFile = new URL('../api/telegram.js', import.meta.url);
let source = await readFile(apiFile, 'utf8');

const liveButtonFunction = `async function processLiveWallpaperButton(callbackQuery, baseUrl) {\n  const action = String(callbackQuery?.data || '');\n  if (!action.startsWith(MEDIA_LIVE_WALLPAPER)) return false;\n\n  const chatId = callbackQuery?.message?.chat?.id;\n  const video = callbackQuery?.message?.video || null;\n  const fileId = video?.file_id;\n  const gallery = galleryMediaMeta(action, MEDIA_LIVE_WALLPAPER);\n  const fileSize = Number(video?.file_size || gallery?.fileSize || 0);\n  if (!chatId) return true;\n\n  if (!fileId) {\n    await telegram('answerCallbackQuery', {\n      callback_query_id: callbackQuery.id,\n      text: '❌ Video untuk Apple Live Photo tak dijumpai. Hantar video/link semula.',\n      show_alert: true,\n    }).catch(() => {});\n    return true;\n  }\n\n  if (gallery && fileSize > heavyVideoLimitBytes()) {\n    await telegram('answerCallbackQuery', {\n      callback_query_id: callbackQuery.id,\n      text: '❌ Buat masa ini video Gallery maksimum 500MB.',\n      show_alert: true,\n    }).catch(() => {});\n    return true;\n  }\n\n  if (!heavyWorkerConfigured()) {\n    await telegram('answerCallbackQuery', {\n      callback_query_id: callbackQuery.id,\n      text: '⚠️ Apple Live Photo worker belum aktif sepenuhnya.',\n      show_alert: true,\n    }).catch(() => {});\n    return true;\n  }\n\n  const claimed = await claimMediaButtons(callbackQuery);\n  if (!claimed) {\n    await telegram('answerCallbackQuery', {\n      callback_query_id: callbackQuery.id,\n      text: 'Pilihan ini dah digunakan. Hantar video/link semula untuk buat lagi.',\n      show_alert: false,\n    }).catch(() => {});\n    return true;\n  }\n\n  await telegram('answerCallbackQuery', { callback_query_id: callbackQuery.id }).catch(() => {});\n  const progressMessage = await startHeavyProgress(chatId, liveProgressText);\n  try {\n    await dispatchHeavyMediaJob({\n      chatId,\n      videoFileId: fileId,\n      fileSize,\n      action: 'live_wallpaper',\n      progressMessageId: progressMessage?.message_id || 0,\n      sourceMessageId: gallery?.sourceMessageId || 0,\n    });\n  } catch (error) {\n    console.error('Apple Live Photo dispatch failed:', error?.code, error?.message);\n    await removeHeavyProgress(chatId, progressMessage?.message_id);\n    await sendMessage(chatId, '❌ Apple Live Photo worker tak dapat dimulakan sekarang. Cuba lagi.').catch(() => {});\n  }\n  return true;\n}\n\n`;

source = replaceBetween(
  source,
  'async function processLiveWallpaperButton(callbackQuery, baseUrl) {',
  "async function processStandardDownload(chatId, url, platform, baseUrl, mirrorGroupId = '', from = {}, sourceMessage = null) {",
  liveButtonFunction,
);

await writeFile(apiFile, source);
console.log('Routed all Live Wallpaper actions to native Apple Live Photo worker');
