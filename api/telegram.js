import { parseMedia, chooseBestVideo, needsCustomHeaders } from '../src/downloader.js';
import { detectPlatform, extractFirstUrl, platformLabel } from '../src/platform.js';
import {
  sendChatAction,
  sendDownloadButton,
  sendMediaGroup,
  sendMessage,
  sendPhotoUrl,
  sendVideoUrl,
} from '../src/telegram.js';

const START_TEXT = [
  '📥 Social Downloader Bot',
  '',
  'Hantar link public daripada:',
  '• TikTok',
  '• Instagram Reels / Post',
  '• Threads',
  '• YouTube / Shorts',
  '',
  'Bot akan cuba hantar media terus dalam chat. Jika fail kerana had Telegram atau link media perlukan header khas, bot akan beri butang download terus.',
  '',
  'Gunakan hanya untuk media yang anda miliki atau dibenarkan untuk dimuat turun.',
].join('\n');

function json(res, status, body) {
  res.status(status).json(body);
}

function isAuthorizedWebhook(req) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return true;
  return req.headers['x-telegram-bot-api-secret-token'] === expected;
}

function safeTitle(media, platform) {
  const title = String(media?.title || '').trim();
  return title ? `${platformLabel(platform)} • ${title}`.slice(0, 900) : `${platformLabel(platform)} download`;
}

async function sendImageFallback(chatId, images, title) {
  const buttons = images.slice(0, 20).map((image, index) => [
    { text: `⬇️ Download image ${index + 1}`, url: image.url },
  ]);

  await sendMessage(chatId, `${title}\n\nTelegram tak dapat fetch album ini secara terus. Guna butang di bawah:`, {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function deliverImages(chatId, images, title) {
  const direct = images.filter((item) => !needsCustomHeaders(item));
  if (!direct.length || direct.length !== images.length) {
    await sendImageFallback(chatId, images, title);
    return;
  }

  if (direct.length === 1) {
    try {
      await sendPhotoUrl(chatId, direct[0].url, title);
      return;
    } catch {
      await sendImageFallback(chatId, images, title);
      return;
    }
  }

  for (let offset = 0; offset < direct.length; offset += 10) {
    const chunk = direct.slice(offset, offset + 10).map((item, index) => ({
      type: 'photo',
      media: item.url,
      ...(offset === 0 && index === 0 ? { caption: title } : {}),
    }));

    try {
      await sendMediaGroup(chatId, chunk);
    } catch {
      await sendImageFallback(chatId, images, title);
      return;
    }
  }
}

async function deliverVideo(chatId, video, title) {
  if (!video) return false;

  if (needsCustomHeaders(video)) {
    await sendDownloadButton(
      chatId,
      `${title}\n\nMedia ini perlukan request header khas, jadi Telegram tak boleh fetch terus.`,
      video.url,
      `⬇️ Download ${video.quality || 'video'}`,
    );
    return true;
  }

  try {
    await sendVideoUrl(chatId, video.url, title);
  } catch (error) {
    await sendDownloadButton(
      chatId,
      `${title}\n\nTelegram tak dapat masukkan fail ini terus dalam chat (selalunya sebab saiz/format/CDN).`,
      video.url,
      `⬇️ Download ${video.quality || 'video'}`,
    );
  }
  return true;
}

async function processMessage(message) {
  const chatId = message?.chat?.id;
  const text = message?.text || message?.caption || '';
  if (!chatId) return;

  const command = text.trim().split(/\s+/)[0]?.toLowerCase();
  if (command === '/start' || command === '/help') {
    await sendMessage(chatId, START_TEXT);
    return;
  }

  const url = extractFirstUrl(text);
  if (!url) {
    await sendMessage(chatId, 'Hantar satu link TikTok, Instagram, Threads atau YouTube.');
    return;
  }

  const platform = detectPlatform(url);
  if (!platform) {
    await sendMessage(chatId, 'Link ni belum disokong. Buat masa sekarang: TikTok, Instagram, Threads dan YouTube.');
    return;
  }

  await sendChatAction(chatId, 'typing').catch(() => {});

  let media;
  try {
    media = await parseMedia(url);
  } catch (error) {
    console.error('Downloader error:', error?.code, error?.message);

    if (error?.code === 'DOWNLOADER_NOT_CONFIGURED') {
      await sendMessage(chatId, '⚙️ Bot downloader belum lengkap dikonfigurasi oleh admin.');
      return;
    }

    if (error?.code === 'NO_MEDIA') {
      await sendMessage(chatId, 'Tak jumpa media yang boleh dimuat turun. Pastikan post itu public dan masih wujud.');
      return;
    }

    await sendMessage(chatId, '❌ Tak berjaya proses link tu. Cuba link public yang asal atau cuba semula kemudian.');
    return;
  }

  const title = safeTitle(media, platform);
  const video = chooseBestVideo(media.videos);

  if (video) {
    await sendChatAction(chatId, 'upload_video').catch(() => {});
    await deliverVideo(chatId, video, title);
  }

  if (media.images.length) {
    await sendChatAction(chatId, 'upload_photo').catch(() => {});
    await deliverImages(chatId, media.images, video ? `${platformLabel(platform)} images` : title);
  }

  if (!video && !media.images.length && media.audios.length) {
    const audio = media.audios[0];
    await sendDownloadButton(chatId, `${title}\n\nAudio tersedia:`, audio.url, '🎵 Download audio');
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return json(res, 200, { ok: true, service: 'telegram-social-downloader', endpoint: 'webhook' });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  if (!isAuthorizedWebhook(req)) {
    return json(res, 401, { ok: false, error: 'invalid_webhook_secret' });
  }

  try {
    const update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const message = update?.message ?? update?.edited_message;
    if (message) await processMessage(message);
    return json(res, 200, { ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    // Telegram should receive 200 so a bad update does not get retried repeatedly.
    return json(res, 200, { ok: false, handled: true });
  }
}
