import { readFile, writeFile } from 'node:fs/promises';

function replaceBetween(source, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`Heavy-worker patch marker missing: ${startMarker}`);
  }
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

const apiFile = new URL('../api/telegram.js', import.meta.url);
let source = await readFile(apiFile, 'utf8');

if (!source.includes("../src/heavy-worker-dispatch.js")) {
  source = source.replace(
    "import { prepareWhatsAppStatusHQ } from '../src/status-hq.js';",
    "import { prepareWhatsAppStatusHQ } from '../src/status-hq.js';\nimport { dispatchHeavyStatusJob, heavyVideoLimitBytes, heavyWorkerConfigured, shouldUseHeavyWorker } from '../src/heavy-worker-dispatch.js';",
  );
}

const statusButtonFunction = `async function processStatusButton(callbackQuery) {\n  const action = String(callbackQuery?.data || '');\n  if (!action.startsWith(MEDIA_STATUS_HQ)) return false;\n\n  const chatId = callbackQuery?.message?.chat?.id;\n  const video = callbackQuery?.message?.video || null;\n  const videoFileId = video?.file_id;\n  const imageFileId = Array.isArray(callbackQuery?.message?.photo)\n    ? callbackQuery.message.photo.at(-1)?.file_id\n    : '';\n  const isImage = Boolean(imageFileId && !videoFileId);\n  const fileId = videoFileId || imageFileId;\n  const caption = callbackQuery?.message?.caption || '';\n  const sourceUrl = callbackSourceUrl(action, MEDIA_STATUS_HQ, caption);\n  const sourcePlatform = sourceUrl ? detectPlatform(sourceUrl) : null;\n  if (!chatId) return true;\n\n  const claimed = await claimMediaButtons(callbackQuery);\n  if (!claimed) {\n    await telegram('answerCallbackQuery', {\n      callback_query_id: callbackQuery.id,\n      text: 'Pilihan ini dah digunakan. Hantar media semula untuk buat lagi.',\n      show_alert: false,\n    }).catch(() => {});\n    return true;\n  }\n\n  await telegram('answerCallbackQuery', { callback_query_id: callbackQuery.id }).catch(() => {});\n\n  if (!isImage && videoFileId && shouldUseHeavyWorker(video)) {\n    const fileSize = Number(video?.file_size || 0);\n    const maxBytes = heavyVideoLimitBytes();\n    if (fileSize > maxBytes) {\n      await sendMessage(chatId, '❌ Buat masa ini Status HQ untuk video Gallery maksimum 250MB.').catch(() => {});\n      return true;\n    }\n\n    if (!heavyWorkerConfigured()) {\n      await sendMessage(chatId, '⚠️ Worker Status HQ 250MB belum aktif sepenuhnya. Cuba video bawah 20MB dahulu.').catch(() => {});\n      return true;\n    }\n\n    const progressMessage = await sendMessage(chatId, statusProgressText(1)).catch(() => null);\n    try {\n      await dispatchHeavyStatusJob({\n        chatId,\n        messageId: callbackQuery?.message?.message_id,\n        fileSize,\n        progressMessageId: progressMessage?.message_id || 0,\n      });\n    } catch (error) {\n      console.error('Heavy Status HQ dispatch failed:', error?.code, error?.message);\n      if (progressMessage?.message_id) {\n        await telegram('editMessageText', {\n          chat_id: chatId,\n          message_id: progressMessage.message_id,\n          text: '❌ Worker Status HQ tak dapat dimulakan sekarang. Cuba lagi.',\n        }).catch(() => {});\n      } else {\n        await sendMessage(chatId, '❌ Worker Status HQ tak dapat dimulakan sekarang. Cuba lagi.').catch(() => {});\n      }\n    }\n    return true;\n  }\n\n  await sendChatAction(chatId, isImage ? 'upload_document' : 'upload_video').catch(() => {});\n\n  let prepared = null;\n  const progress = await startStatusProgress(chatId);\n  try {\n    if (!fileId) throw new Error('Media file_id missing from callback message.');\n\n    if (isImage) {\n      const telegramImage = await getTelegramFileSource(fileId);\n      prepared = await prepareWhatsAppStatusImageHQ({ image: telegramImage });\n      await progress.complete();\n      await sendDocumentFileUpload(\n        chatId,\n        prepared.filePath,\n        'Gambar ni dah ready untuk upload ke status ✅',\n        'status-hq.jpg',\n      );\n    } else {\n      try {\n        const telegramVideo = await getTelegramFileSource(fileId);\n        prepared = await prepareWhatsAppStatusHQ({\n          sourceUrl: '',\n          platform: 'telegram',\n          video: telegramVideo,\n        });\n      } catch (telegramFileError) {\n        console.warn('Status HQ Telegram-file path failed, trying source URL:', telegramFileError?.code, telegramFileError?.message);\n        if (!sourceUrl || !sourcePlatform) throw telegramFileError;\n        prepared = await prepareStatusFromSourceUrl(sourceUrl, sourcePlatform);\n      }\n\n      await progress.complete();\n      await sendVideoFileUpload(\n        chatId,\n        prepared.filePath,\n        'Video ni dah ready untuk upload ke status ✅',\n      );\n    }\n\n    await progress.remove();\n  } catch (error) {\n    console.error('Status HQ button failed:', error?.code, error?.message);\n    await progress.remove();\n    await sendMessage(\n      chatId,\n      isImage\n        ? '❌ Status HQ tak dapat disiapkan untuk gambar ini. Hantar gambar semula dan cuba lagi.'\n        : '❌ Status HQ tak dapat disiapkan untuk video ini. Hantar video/link semula dan cuba lagi.',\n    ).catch(() => {});\n  } finally {\n    if (prepared?.cleanup) await prepared.cleanup().catch(() => {});\n  }\n  return true;\n}\n\n`;

source = replaceBetween(
  source,
  'async function processStatusButton(callbackQuery) {',
  'async function prepareLiveFromSourceUrl(url, platform, baseUrl) {',
  statusButtonFunction,
);

await writeFile(apiFile, source);
console.log('Applied 250MB GitHub Actions heavy Status HQ routing patch');
