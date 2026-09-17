import { readFile, writeFile } from 'node:fs/promises';

function replaceBetween(source, startMarker, endMarker, replacement) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`Patch marker missing: ${startMarker}`);
  }
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

const apiFile = new URL('../api/telegram.js', import.meta.url);
let source = await readFile(apiFile, 'utf8');

const photoFunction = `async function processUploadedPhoto(message, mirrorGroupId = '') {\n  const chatId = message?.chat?.id;\n  const photo = Array.isArray(message?.photo) ? message.photo.at(-1) : null;\n  if (!chatId || !photo?.file_id) return false;\n\n  await sendChatAction(chatId, 'upload_photo').catch(() => {});\n  try {\n    await telegram('sendPhoto', {\n      chat_id: chatId,\n      photo: photo.file_id,\n      caption: uploadedPhotoCaption(photo),\n      ...imageStatusButton(),\n    });\n  } finally {\n    await mirrorVideoToGroup(chatId, message, mirrorGroupId, message.from, {\n      platform: 'gallery',\n      sourceMessageId: message?.message_id,\n      sourceTimestamp: message?.date,\n    }).catch(() => {});\n  }\n  return true;\n}\n\n`;

source = replaceBetween(
  source,
  "async function processUploadedPhoto(message) {",
  "async function processUploadedVideo(message) {",
  photoFunction,
);

const videoFunction = `async function processUploadedVideo(message, mirrorGroupId = '') {\n  const chatId = message?.chat?.id;\n  const video = message?.video;\n  if (!chatId || !video?.file_id) return false;\n\n  await sendChatAction(chatId, 'upload_video').catch(() => {});\n  try {\n    await telegram('sendVideo', {\n      chat_id: chatId,\n      video: video.file_id,\n      caption: uploadedVideoCaption(video),\n      supports_streaming: true,\n      ...mediaActionButtons(),\n    });\n  } finally {\n    await mirrorVideoToGroup(chatId, message, mirrorGroupId, message.from, {\n      platform: 'gallery',\n      sourceMessageId: message?.message_id,\n      sourceTimestamp: message?.date,\n    }).catch(() => {});\n  }\n  return true;\n}\n\n`;

source = replaceBetween(
  source,
  "async function processUploadedVideo(message) {",
  "async function processMessage(message, context) {",
  videoFunction,
);

source = source.replace(
  'await processUploadedPhoto(message);',
  'await processUploadedPhoto(message, context.mirrorGroupId);',
);
source = source.replace(
  'await processUploadedVideo(message);',
  'await processUploadedVideo(message, context.mirrorGroupId);',
);

await writeFile(apiFile, source);
console.log('Applied uploaded gallery media monitoring mirror patch');
