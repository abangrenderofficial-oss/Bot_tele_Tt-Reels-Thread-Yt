import {
  prepareTikTokSlideshowVideo,
  prepareTikTokSound,
  resolveTikTokSlideshow,
  sendTikTokSoundUpload,
} from '../tiktok-slideshow.js';
import { createRelayUrl } from '../relay.js';
import { detectPlatform, extractFirstUrl } from '../platform.js';
import { needsCustomHeaders } from '../bot/media-resolver.js';
import { mediaActionButtons } from '../bot/media-actions.js';
import { localMediaLane } from '../bot/job-lanes.js';
import { mirrorMediaToGroup } from '../bot/audit.js';
import { startStatusProgress } from '../bot/progress.js';
import {
  sendChatAction,
  sendMediaGroup,
  sendMessage,
  sendPhotoUrl,
  sendVideoFileUpload,
  telegram,
} from '../telegram.js';

export const TT_SLIDE_SPLIT = 'ttslide:split:v2';
export const TT_SLIDE_VIDEO = 'ttslide:video:v2';

function configuredUploadLimit() {
  const custom = Number(process.env.TELEGRAM_UPLOAD_MAX_MB || 0);
  const mb = Number.isFinite(custom) && custom > 0 ? custom : 50;
  return Math.floor(mb * 1024 * 1024);
}

function relayItem(baseUrl, item) {
  if (!baseUrl || !item?.url) return null;
  try { return { ...item, url: createRelayUrl(baseUrl, item), headers: null }; } catch { return null; }
}

async function sendImageFallback(chatId, images, title) {
  const buttons = images.slice(0, 20).map((image, index) => [
    { text: `⬇️ Download image ${index + 1}`, url: image.url },
  ]);
  await sendMessage(chatId, `${title}\n\nTelegram tak dapat masukkan album ini terus dalam chat. Guna butang di bawah:`, {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function deliverImages(chatId, images, title, baseUrl) {
  const prepared = images.map((item) => needsCustomHeaders(item) ? relayItem(baseUrl, item) : item);
  if (prepared.some((item) => !item)) return sendImageFallback(chatId, images, title);
  if (prepared.length === 1) {
    try { await sendPhotoUrl(chatId, prepared[0].url, title); return; } catch { return sendImageFallback(chatId, images, title); }
  }
  for (let offset = 0; offset < prepared.length; offset += 10) {
    const chunk = prepared.slice(offset, offset + 10).map((item, index) => ({
      type: 'photo',
      media: item.url,
      ...(offset === 0 && index === 0 ? { caption: title } : {}),
    }));
    try { await sendMediaGroup(chatId, chunk); } catch { await sendImageFallback(chatId, images, title); return; }
  }
}

export async function sendTikTokSlideshowChoice(chatId, url) {
  await sendMessage(chatId, `🖼️ TikTok photo/slideshow dikesan.\nPilih output yang anda mahu:\n\n${url}`, {
    reply_markup: {
      inline_keyboard: [[
        { text: '🖼️ Split • Image + Audio', callback_data: TT_SLIDE_SPLIT },
        { text: '🎬 Video', callback_data: TT_SLIDE_VIDEO },
      ]],
    },
  });
}

async function disableChoiceButtons(callbackQuery) {
  const chatId = callbackQuery?.message?.chat?.id;
  const messageId = callbackQuery?.message?.message_id;
  if (!chatId || !messageId) return;
  await telegram('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  }).catch(() => {});
}

async function resolveChoiceSource(callbackQuery) {
  const chatId = callbackQuery?.message?.chat?.id;
  const sourceText = callbackQuery?.message?.text || callbackQuery?.message?.caption || '';
  const url = extractFirstUrl(sourceText);
  if (!url || detectPlatform(url) !== 'tiktok') {
    if (chatId) await sendMessage(chatId, '❌ Link TikTok asal tak dapat dibaca. Hantar semula link slideshow itu.');
    return null;
  }
  try {
    return await resolveTikTokSlideshow(url);
  } catch (error) {
    console.error('[tiktok-slideshow] resolver failed:', error?.code, error?.message);
    if (chatId) await sendMessage(chatId, '❌ Tak berjaya baca semula TikTok slideshow itu. Cuba hantar link sekali lagi.');
    return null;
  }
}

async function processSplit(callbackQuery, context) {
  const chatId = callbackQuery?.message?.chat?.id;
  if (!chatId) return;
  await telegram('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Sedang sediakan gambar + audio berasingan…' }).catch(() => {});
  await disableChoiceButtons(callbackQuery);
  const slideshow = await resolveChoiceSource(callbackQuery);
  if (!slideshow) return;

  let preparedSound = null;
  try {
    await sendChatAction(chatId, 'upload_photo').catch(() => {});
    await deliverImages(chatId, slideshow.images, 'TikTok images', context.baseUrl);
    await sendChatAction(chatId, 'upload_document').catch(() => {});
    preparedSound = await prepareTikTokSound(slideshow.audio);
    await sendTikTokSoundUpload(chatId, preparedSound, `🎵 ${slideshow.audio.title}`);
  } catch (error) {
    console.error('[tiktok-slideshow/split] failed:', error?.code, error?.message);
    await sendMessage(chatId, '❌ Proses Image + Audio tak dapat disiapkan. Cuba semula.').catch(() => {});
  } finally {
    if (preparedSound?.cleanup) await preparedSound.cleanup().catch(() => {});
  }
}

async function processVideo(callbackQuery, context) {
  const chatId = callbackQuery?.message?.chat?.id;
  if (!chatId) return;
  await telegram('answerCallbackQuery', { callback_query_id: callbackQuery.id }).catch(() => {});
  await disableChoiceButtons(callbackQuery);

  const progress = await startStatusProgress(chatId);
  const slideshow = await resolveChoiceSource(callbackQuery);
  if (!slideshow) {
    await progress.remove();
    return;
  }

  let preparedVideo = null;
  try {
    await sendChatAction(chatId, 'upload_video').catch(() => {});
    preparedVideo = await localMediaLane(() => prepareTikTokSlideshowVideo(slideshow, configuredUploadLimit()));
    await progress.complete();

    const sourceUrl = extractFirstUrl(callbackQuery?.message?.text || '');
    const sent = await sendVideoFileUpload(chatId, preparedVideo.filePath, '', mediaActionButtons(sourceUrl));
    await progress.remove();

    await mirrorMediaToGroup(chatId, sent, context.mirrorGroupId, callbackQuery.from, {
      sourceUrl,
      platform: 'tiktok',
      sourceMessageId: callbackQuery?.message?.message_id,
      sourceTimestamp: callbackQuery?.message?.date,
    });
  } catch (error) {
    console.error('[tiktok-slideshow/video] failed:', error?.code, error?.message);
    await progress.remove();
    await sendMessage(chatId, '❌ Tak berjaya gabungkan slideshow + audio menjadi video. Cuba semula kemudian.');
  } finally {
    if (preparedVideo?.cleanup) await preparedVideo.cleanup().catch(() => {});
  }
}

export async function processTikTokSlideshowChoice(callbackQuery, context = {}) {
  const action = String(callbackQuery?.data || '');
  if (action === TT_SLIDE_SPLIT) { await processSplit(callbackQuery, context); return true; }
  if (action === TT_SLIDE_VIDEO) { await processVideo(callbackQuery, context); return true; }
  return false;
}
