import { mirrorMediaToGroup } from '../bot/audit.js';
import { galleryMediaActionButtons, MEDIA_STATUS_HQ } from '../bot/media-actions.js';
import { sendChatAction, sendMessage, telegram } from '../telegram.js';

export const MAX_GALLERY_VIDEO_BYTES = 200 * 1024 * 1024;

export function isGalleryVideoTooLarge(fileSize = 0) {
  const bytes = Number(fileSize || 0);
  return Number.isFinite(bytes) && bytes > MAX_GALLERY_VIDEO_BYTES;
}

function formatFileSize(bytes) {
  const value = Number(bytes || 0);
  if (!value) return '-';
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function uploadedVideoCaption(video = {}) {
  const width = Number(video.width || 0);
  const height = Number(video.height || 0);
  const duration = Number(video.duration || 0);
  return [
    '🎬 Video diterima',
    width && height ? `📐 ${width} × ${height}` : null,
    duration ? `⏱️ ${duration}s` : null,
    video.file_size ? `📦 ${formatFileSize(video.file_size)}` : null,
    '',
    'Pilih fungsi:',
  ].filter((line) => line !== null).join('\n').slice(0, 1024);
}

function uploadedPhotoCaption(photo = {}) {
  const width = Number(photo.width || 0);
  const height = Number(photo.height || 0);
  return [
    '🖼️ Gambar diterima',
    width && height ? `📐 ${width} × ${height}` : null,
    photo.file_size ? `📦 ${formatFileSize(photo.file_size)}` : null,
    '',
    'Pilih fungsi:',
  ].filter((line) => line !== null).join('\n').slice(0, 1024);
}

function uploadedPhotoActions() {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: '✨ Premium+ 𝗛𝗤', callback_data: MEDIA_STATUS_HQ },
      ]],
    },
  };
}

export async function processUploadedPhoto(message, context = {}) {
  const chatId = message?.chat?.id;
  const photo = Array.isArray(message?.photo) ? message.photo.at(-1) : null;
  if (!chatId || !photo?.file_id) return false;

  await sendChatAction(chatId, 'upload_photo').catch(() => {});
  try {
    await telegram('sendPhoto', {
      chat_id: chatId,
      photo: photo.file_id,
      caption: uploadedPhotoCaption(photo),
      ...uploadedPhotoActions(),
    });
  } finally {
    await mirrorMediaToGroup(chatId, message, context.mirrorGroupId, message.from, {
      platform: 'gallery',
      sourceMessageId: message?.message_id,
      sourceTimestamp: message?.date,
    }).catch(() => {});
  }
  return true;
}

export async function processUploadedVideo(message, context = {}) {
  const chatId = message?.chat?.id;
  const video = message?.video;
  if (!chatId || !video?.file_id) return false;

  const fileSize = Number(video?.file_size || 0);
  if (isGalleryVideoTooLarge(fileSize)) {
    await sendMessage(chatId, '❌ Video terlalu besar. Maksimum upload dari gallery ialah 200MB.');
    return true;
  }

  const actions = galleryMediaActionButtons(message?.message_id, video?.file_size);
  await sendChatAction(chatId, 'upload_video').catch(() => {});
  try {
    await telegram('sendVideo', {
      chat_id: chatId,
      video: video.file_id,
      caption: uploadedVideoCaption(video),
      supports_streaming: true,
      ...(Number(video?.width || 0) > 0 ? { width: Number(video.width) } : {}),
      ...(Number(video?.height || 0) > 0 ? { height: Number(video.height) } : {}),
      ...(Number(video?.duration || 0) > 0 ? { duration: Number(video.duration) } : {}),
      ...actions,
    });
  } finally {
    await mirrorMediaToGroup(chatId, message, context.mirrorGroupId, message.from, {
      platform: 'gallery',
      sourceMessageId: message?.message_id,
      sourceTimestamp: message?.date,
    }).catch(() => {});
  }
  return true;
}
