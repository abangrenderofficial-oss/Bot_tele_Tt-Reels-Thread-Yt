import { parseMedia, chooseBestVideo, needsCustomHeaders } from '../src/downloader.js';
import { parseThreadsPost } from '../src/threads.js';
import { prepareYouTubeTelegramUpload } from '../src/youtube-upload.js';
import { detectPlatform, extractFirstUrl, platformLabel } from '../src/platform.js';
import { createRelayUrl } from '../src/relay.js';
import {
  sendChatAction,
  sendDownloadButton,
  sendMediaGroup,
  sendMessage,
  sendPhotoUrl,
  sendVideoFileUpload,
  sendVideoUpload,
  sendVideoUrl,
} from '../src/telegram.js';

const TELEGRAM_URL_FETCH_MAX = 20 * 1024 * 1024;
const TELEGRAM_CLOUD_UPLOAD_MAX = 50 * 1024 * 1024;

const START_TEXT = [
  '📥 Social Downloader Bot',
  '',
  'Hantar link public daripada:',
  '• TikTok',
  '• Instagram Reels / Post',
  '• Threads',
  '• YouTube / Shorts',
  '',
  'YouTube: bot utamakan 1080p, kemudian 720p, kemudian 480p. Jika video dan audio berasingan, bot akan merge dahulu sebelum hantar ke Telegram.',
  '',
  'Bot akan cuba hantar media terus dalam chat. Untuk CDN yang perlukan header khas, bot akan relay media melalui server sendiri dan cuba upload terus ke Telegram.',
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

function requestBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return String(process.env.PUBLIC_BASE_URL).replace(/\/$/, '');
  const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!forwardedHost) return '';
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim() || 'https';
  return `${proto}://${forwardedHost}`;
}

function safeTitle(media, platform) {
  const title = String(media?.title || '').trim();
  return title ? `${platformLabel(platform)} • ${title}`.slice(0, 900) : `${platformLabel(platform)} download`;
}

function relayItem(baseUrl, item) {
  if (!baseUrl || !item?.url) return null;
  try {
    return { ...item, url: createRelayUrl(baseUrl, item), headers: null };
  } catch (error) {
    console.warn('Relay URL unavailable:', error?.message);
    return null;
  }
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
  const prepared = images.map((item) => {
    if (!needsCustomHeaders(item)) return item;
    return relayItem(baseUrl, item);
  });

  if (prepared.some((item) => !item)) {
    await sendImageFallback(chatId, images, title);
    return;
  }

  if (prepared.length === 1) {
    try {
      await sendPhotoUrl(chatId, prepared[0].url, title);
      return;
    } catch {
      await sendImageFallback(chatId, images, title);
      return;
    }
  }

  for (let offset = 0; offset < prepared.length; offset += 10) {
    const chunk = prepared.slice(offset, offset + 10).map((item, index) => ({
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

function configuredUploadLimit() {
  const custom = Number(process.env.TELEGRAM_UPLOAD_MAX_MB || 0);
  if (Number.isFinite(custom) && custom > 0) return Math.floor(custom * 1024 * 1024);
  return TELEGRAM_CLOUD_UPLOAD_MAX;
}

function orderedVideoCandidates(videos = []) {
  const pool = videos.filter((item) => item?.url);
  const ordered = [];
  while (pool.length) {
    const best = chooseBestVideo(pool);
    if (!best) break;
    ordered.push(best);
    const index = pool.indexOf(best);
    if (index >= 0) pool.splice(index, 1);
    else break;
  }

  const limit = configuredUploadLimit();
  const likelySendable = ordered.filter((item) => !item.filesize || Number(item.filesize) <= limit);
  const knownTooLarge = ordered.filter((item) => item.filesize && Number(item.filesize) > limit);
  return [...likelySendable, ...knownTooLarge];
}

async function deliverVideo(chatId, video, title, baseUrl) {
  if (!video?.url) return false;

  const size = Number(video.filesize || 0);
  const customHeaders = needsCustomHeaders(video);
  const relay = relayItem(baseUrl, video);

  if (!size || size <= TELEGRAM_URL_FETCH_MAX) {
    const fetchUrl = customHeaders ? relay?.url : video.url;
    if (fetchUrl) {
      try {
        await sendVideoUrl(chatId, fetchUrl, title);
        return true;
      } catch (error) {
        console.warn('Telegram URL fetch failed, trying server upload:', error?.message);
      }
    }
  }

  const uploadLimit = configuredUploadLimit();
  if (size && size > uploadLimit) {
    console.warn(`Skipping ${video.quality || 'video'}: known size ${size} exceeds Telegram upload limit ${uploadLimit}.`);
    return false;
  }

  try {
    await sendVideoUpload(chatId, video, title);
    return true;
  } catch (error) {
    console.warn('Telegram server upload failed:', error?.code, error?.message);
    return false;
  }
}

async function deliverPreferredYouTube(chatId, url, title) {
  let prepared = null;
  try {
    prepared = await prepareYouTubeTelegramUpload(url, configuredUploadLimit());
    const caption = `${title}\n🎬 ${prepared.quality}`;
    await sendVideoFileUpload(chatId, prepared.filePath, caption);
    return true;
  } catch (error) {
    console.warn('Preferred YouTube pipeline failed:', error?.code, error?.message);
    return false;
  } finally {
    if (prepared?.cleanup) await prepared.cleanup().catch(() => {});
  }
}

async function processMessage(message, baseUrl) {
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
    media = platform === 'threads'
      ? await parseThreadsPost(url)
      : await parseMedia(url);
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
  const candidates = orderedVideoCandidates(media.videos);
  let videoSent = false;

  if (platform === 'youtube') {
    await sendChatAction(chatId, 'upload_video').catch(() => {});
    videoSent = await deliverPreferredYouTube(chatId, url, title);
  }

  if (candidates.length && !videoSent) {
    await sendChatAction(chatId, 'upload_video').catch(() => {});
    for (const candidate of candidates.slice(0, 6)) {
      if (await deliverVideo(chatId, candidate, title, baseUrl)) {
        videoSent = true;
        break;
      }
    }

    if (!videoSent) {
      const best = chooseBestVideo(media.videos);
      if (best) {
        await sendDownloadButton(
          chatId,
          `${title}\n\nBot dah cuba 1080p/720p/480p, direct URL, relay dan server upload, tapi fail ini masih melebihi had Telegram cloud atau CDN menolak transfer.`,
          best.url,
          `⬇️ Download ${best.quality || 'video'}`,
        );
      }
    }
  }

  if (media.images.length) {
    await sendChatAction(chatId, 'upload_photo').catch(() => {});
    await deliverImages(chatId, media.images, videoSent ? `${platformLabel(platform)} images` : title, baseUrl);
  }

  if (!candidates.length && !media.images.length && media.audios.length) {
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
    if (message) await processMessage(message, requestBaseUrl(req));
    return json(res, 200, { ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return json(res, 200, { ok: false, handled: true });
  }
}
