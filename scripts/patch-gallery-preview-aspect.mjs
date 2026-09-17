import { readFile, writeFile } from 'node:fs/promises';

const apiFile = new URL('../api/telegram.js', import.meta.url);
let source = await readFile(apiFile, 'utf8');

const oldBlock = `  try {\n    try {\n      await telegram('copyMessage', {\n        chat_id: chatId,\n        from_chat_id: chatId,\n        message_id: message.message_id,\n        caption: uploadedVideoCaption(video),\n        ...actions,\n      });\n    } catch (copyError) {\n      console.warn('Gallery preview copy failed; trying cached file_id:', copyError?.code, copyError?.message);\n      await telegram('sendVideo', {\n        chat_id: chatId,\n        video: video.file_id,\n        caption: uploadedVideoCaption(video),\n        supports_streaming: true,\n        ...actions,\n      });\n    }\n  } finally {`;

const newBlock = `  try {\n    await telegram('sendVideo', {\n      chat_id: chatId,\n      video: video.file_id,\n      caption: uploadedVideoCaption(video),\n      supports_streaming: true,\n      ...(Number(video?.width || 0) > 0 ? { width: Number(video.width) } : {}),\n      ...(Number(video?.height || 0) > 0 ? { height: Number(video.height) } : {}),\n      ...(Number(video?.duration || 0) > 0 ? { duration: Number(video.duration) } : {}),\n      ...actions,\n    });\n  } finally {`;

if (!source.includes(oldBlock)) {
  throw new Error('Gallery preview aspect patch marker missing.');
}

source = source.replace(oldBlock, newBlock);
await writeFile(apiFile, source);
console.log('Applied Gallery preview aspect-ratio preservation patch');
