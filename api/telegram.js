import { parseMedia, chooseBestVideo, needsCustomHeaders } from '../src/downloader.js';
import { parseThreadsPost } from '../src/threads.js';
import { parseTwitterVideo } from '../src/twitter.js';
import { prepareSocialVideoTelegramUpload } from '../src/social-video.js';
import { prepareYouTubeTelegramUpload } from '../src/youtube-upload.js';
import { prepareWhatsAppStatusHQ } from '../src/status-hq.js';
import {
  prepareTikTokSlideshowVideo,
  prepareTikTokSound,
  resolveTikTokSlideshow,
  sendTikTokSoundUpload,
} from '../src/tiktok-slideshow.js';
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
  telegram,
} from '../src/telegram.js';

const TELEGRAM_URL_FETCH_MAX = 20 * 1024 * 1024;
const TELEGRAM_CLOUD_UPLOAD_MAX = 50 * 1024 * 1024;
const TT_SLIDE_SPLIT = 'ttslide:split:v2';
const TT_SLIDE_VIDEO = 'ttslide:video:v2';
const MEDIA_DOWNLOAD = 'media:download:v1';
const MEDIA_STATUS_HQ = 'media:status:v1';

const START_TEXT = [
  '📥 Social Downloader Bot',
  '',
  'Hantar link daripada:',
  '• TikTok',
  '• Instagram Reels / Post',
  '• Threads',
  '• X / Twitter video',
  '• YouTube / Shorts / Unlisted',
  '',
  'Selepas hantar link, bot akan tanya:',
  '⬇️ Download Biasa atau 📱 Status HQ.',
  '',
  'YouTube: bot support video public dan unlisted yang boleh dibuka menggunakan link. Bot utamakan 1080p, kemudian 720p, kemudian 480p. Jika video dan audio berasingan, bot akan merge dahulu sebelum hantar ke Telegram.',
  'TikTok video: bot hantar video seperti biasa. TikTok photo/slideshow: selepas pilih Download Biasa, bot akan beri pilihan Split (Image + Audio) atau Video.',
  'TikTok / Instagram / Threads / X: jika video melebihi had Telegram, bot akan cuba compress HQ dahulu sambil mengekalkan aspect ratio asal.',
  '',
  '📱 Status HQ: video pendek guna 1080×1920 / 29s per part. Video panjang auto tukar ke 720×1280 / 59s per part supaya tak terlalu banyak bahagian. Ratio asal dikekalkan tanpa stretch. /status <link> masih boleh digunakan sebagai shortcut.',
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

async function deliverCompressedSocial(chatId, video, title, durationHint) {
  let prepared = null;
  try {
    prepared = await prepareSocialVideoTelegramUpload(video, configuredUploadLimit(), {
      duration: Number(video?.duration || durationHint || 0) || null,
    });

    const caption = prepared.compressed ? `${title}\n🎬 ${prepared.quality}` : title;
    await sendVideoFileUpload(chatId, prepared.filePath, caption);
    return true;
  } catch (error) {
    console.warn('Social HQ compression/upload failed:', error?.code, error?.message);
    return false;
  } finally {
    if (prepared?.cleanup) await prepared.cleanup().catch(() => {});
  }
}

async function deliverVideo(chatId, video, title, baseUrl, options = {}) {
  if (!video?.url) return false;

  const size = Number(video.filesize || 0);
  const customHeaders = needsCustomHeaders(video);
  const relay = relayItem(baseUrl, video);
  const uploadLimit = configuredUploadLimit();
  const allowSocialCompression = options.platform && options.platform !== 'youtube';

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

  if (size && size > uploadLimit) {
    if (allowSocialCompression) return deliverCompressedSocial(chatId, video, title, options.duration);
    console.warn(`Skipping ${video.quality || 'video'}: known size ${size} exceeds Telegram upload limit ${uploadLimit}.`);
    return false;
  }

  try {
    await sendVideoUpload(chatId, video, title);
    return true;
  } catch (error) {
    console.warn('Telegram server upload failed:', error?.code, error?.message);
    if (allowSocialCompression) return deliverCompressedSocial(chatId, video, title, options.duration);
    return false;
  }
}

async function deliverPreferredYouTube(chatId, url, title) {
  let prepared = null;
  try {
    prepared = await prepareYouTubeTelegramUpload(url, configuredUploadLimit());
    await sendVideoFileUpload(chatId, prepared.filePath, `${title}\n🎬 ${prepared.quality}`);
    return true;
  } catch (error) {
    console.warn('Preferred YouTube pipeline failed:', error?.code, error?.message);
    return false;
  } finally {
    if (prepared?.cleanup) await prepared.cleanup().catch(() => {});
  }
}

function emptyYouTubeMedia() {
  return {
    platform: 'YouTube',
    title: '',
    thumbnail: '',
    duration: null,
    images: [],
    videos: [],
    audios: [],
  };
}

async function sendMediaModeChoice(chatId, url, platform) {
  await sendMessage(
    chatId,
    `🔗 ${platformLabel(platform)} link dikesan.\nNak buat apa dengan video ni?\n\n${url}`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '⬇️ Download Biasa', callback_data: MEDIA_DOWNLOAD },
          { text: '📱 Status HQ', callback_data: MEDIA_STATUS_HQ },
        ]],
      },
    },
  );
}

async function sendTikTokSlideshowChoice(chatId, url) {
  await sendMessage(
    chatId,
    `🖼️ TikTok photo/slideshow dikesan.\nPilih output yang anda mahu:\n\n${url}`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🖼️ Split • Image + Audio', callback_data: TT_SLIDE_SPLIT },
          { text: '🎬 Video', callback_data: TT_SLIDE_VIDEO },
        ]],
      },
    },
  );
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
    console.error('TikTok slideshow resolver failed:', error?.code, error?.message);
    if (chatId) await sendMessage(chatId, '❌ Tak berjaya baca semula TikTok slideshow itu. Cuba hantar link sekali lagi.');
    return null;
  }
}

async function processTikTokSplit(callbackQuery, baseUrl) {
  const chatId = callbackQuery?.message?.chat?.id;
  if (!chatId) return;

  await telegram('answerCallbackQuery', {
    callback_query_id: callbackQuery.id,
    text: 'Sedang sediakan gambar + audio berasingan…',
  }).catch(() => {});
  await disableChoiceButtons(callbackQuery);

  const slideshow = await resolveChoiceSource(callbackQuery);
  if (!slideshow) return;

  let preparedSound = null;
  try {
    await sendChatAction(chatId, 'upload_photo').catch(() => {});
    await deliverImages(chatId, slideshow.images, 'TikTok images', baseUrl);

    await sendChatAction(chatId, 'upload_document').catch(() => {});
    preparedSound = await prepareTikTokSound(slideshow.audio);
    await sendTikTokSoundUpload(chatId, preparedSound, `🎵 ${slideshow.audio.title}`);
  } catch (error) {
    console.error('TikTok slideshow split_v2 failed:', error?.code, error?.message);
    await sendMessage(chatId, '❌ Proses Image + Audio tak dapat disiapkan. Cuba semula.').catch(() => {});
  } finally {
    if (preparedSound?.cleanup) await preparedSound.cleanup().catch(() => {});
  }
}

async function processTikTokVideo(callbackQuery) {
  const chatId = callbackQuery?.message?.chat?.id;
  if (!chatId) return;

  await telegram('answerCallbackQuery', {
    callback_query_id: callbackQuery.id,
    text: 'Sedang bina video dengan ratio asal…',
  }).catch(() => {});
  await disableChoiceButtons(callbackQuery);

  const slideshow = await resolveChoiceSource(callbackQuery);
  if (!slideshow) return;

  let preparedVideo = null;
  try {
    await sendChatAction(chatId, 'upload_video').catch(() => {});
    preparedVideo = await prepareTikTokSlideshowVideo(slideshow, configuredUploadLimit());
    await sendVideoFileUpload(chatId, preparedVideo.filePath, `TikTok slideshow\n🎬 ${preparedVideo.quality}`);
  } catch (error) {
    console.error('TikTok slideshow video_v2 failed:', error?.code, error?.message);
    await sendMessage(chatId, '❌ Tak berjaya gabungkan slideshow + audio menjadi video. Cuba semula kemudian.');
  } finally {
    if (preparedVideo?.cleanup) await preparedVideo.cleanup().catch(() => {});
  }
}

async function processTikTokSlideshowChoice(callbackQuery, baseUrl) {
  const action = String(callbackQuery?.data || '');
  if (action === TT_SLIDE_SPLIT) {
    await processTikTokSplit(callbackQuery, baseUrl);
    return true;
  }
  if (action === TT_SLIDE_VIDEO) {
    await processTikTokVideo(callbackQuery);
    return true;
  }
  return false;
}

async function resolveStatusMedia(platform, url) {
  if (platform === 'youtube') {
    try {
      return await parseMedia(url);
    } catch {
      return emptyYouTubeMedia();
    }
  }
  if (platform === 'threads') return parseThreadsPost(url);
  if (platform === 'twitter') return parseTwitterVideo(url);
  return parseMedia(url);
}

async function processStatusMessage(chatId, url, platform) {
  let prepared = null;
  try {
    await sendMessage(
      chatId,
      '📱 Status HQ sedang disediakan…\nBot akan pilih profile automatik: 1080×1920 / 29s untuk video pendek, atau 720×1280 / 59s untuk video panjang. Ratio asal kekal tanpa stretch.',
    );
    await sendChatAction(chatId, 'upload_video').catch(() => {});

    const media = await resolveStatusMedia(platform, url);
    if (platform === 'tiktok' && Array.isArray(media.images) && media.images.length && !media.videos?.length) {
      await sendMessage(chatId, '❌ Status HQ sekarang fokus pada video. TikTok slideshow/photo belum disokong untuk mode ini.');
      return;
    }

    const best = platform === 'youtube' ? null : chooseBestVideo(media.videos || []);
    if (platform !== 'youtube' && !best) {
      await sendMessage(chatId, '❌ Tak jumpa video yang sesuai untuk dibina sebagai Status HQ.');
      return;
    }

    prepared = await prepareWhatsAppStatusHQ({ sourceUrl: url, platform, video: best });

    if (prepared.switchedForLength) {
      await sendMessage(
        chatId,
        'ℹ️ Video panjang dikesan. Bot auto guna mode Long 720×1280 / 59s per part supaya jumlah bahagian berkurang dan proses lebih stabil.',
      ).catch(() => {});
    }

    for (const clip of prepared.clips) {
      await sendChatAction(chatId, 'upload_video').catch(() => {});
      const caption = [
        `📱 Status HQ • ${platformLabel(platform)}`,
        `Part ${clip.index}/${clip.count}`,
        `${prepared.profile.width}×${prepared.profile.height} • H.264/AAC • ratio asal`,
      ].join('\n');
      await sendVideoFileUpload(chatId, clip.filePath, caption);
    }

    await sendMessage(
      chatId,
      [
        `✅ ${prepared.quality} siap.`,
        '',
        'Cara test yang paling penting:',
        '1. Save part daripada Telegram ke phone.',
        '2. Buka WhatsApp dan hantar file itu ke chat sendiri melalui Gallery.',
        '3. Pilih HD quality sebelum send.',
        '4. Pada copy baru dalam chat itu, pilih Forward → My Status.',
        '5. Jangan trim/edit lagi dalam WhatsApp.',
        '',
        'WhatsApp masih boleh recompress mengikut device/app version, jadi compare hasil ini dengan upload biasa.',
      ].join('\n'),
    );
  } catch (error) {
    console.error('Status HQ failed:', error?.code, error?.message);
    if (error?.code === 'STATUS_TOO_MANY_CLIPS') {
      await sendMessage(chatId, `❌ ${error.message}`).catch(() => {});
    } else {
      await sendMessage(chatId, '❌ Status HQ tak dapat disiapkan untuk link ini. Cuba video lebih pendek atau cuba semula kemudian.').catch(() => {});
    }
  } finally {
    if (prepared?.cleanup) await prepared.cleanup().catch(() => {});
  }
}

async function processStandardDownload(chatId, url, platform, baseUrl) {
  await sendChatAction(chatId, 'typing').catch(() => {});

  let media;
  let initialDownloaderError = null;
  try {
    if (platform === 'threads') media = await parseThreadsPost(url);
    else if (platform === 'twitter') media = await parseTwitterVideo(url);
    else media = await parseMedia(url);
  } catch (error) {
    console.error('Downloader error:', error?.code, error?.message);

    if (platform === 'youtube') {
      initialDownloaderError = error;
      media = emptyYouTubeMedia();
    } else {
      if (error?.code === 'DOWNLOADER_NOT_CONFIGURED') {
        await sendMessage(chatId, '⚙️ Bot downloader belum lengkap dikonfigurasi oleh admin.');
        return;
      }
      if (error?.code === 'NO_MEDIA') {
        await sendMessage(chatId, 'Tak jumpa video/media yang boleh dimuat turun. Pastikan post itu boleh diakses dan masih wujud.');
        return;
      }
      await sendMessage(chatId, '❌ Tak berjaya proses link tu. Cuba link asal atau cuba semula kemudian.');
      return;
    }
  }

  if (platform === 'tiktok' && Array.isArray(media.images) && media.images.length) {
    await sendTikTokSlideshowChoice(chatId, url);
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
      if (await deliverVideo(chatId, candidate, title, baseUrl, { platform, duration: media.duration })) {
        videoSent = true;
        break;
      }
    }

    if (!videoSent) {
      const best = chooseBestVideo(media.videos);
      if (best) {
        await sendDownloadButton(
          chatId,
          `${title}\n\nBot dah cuba direct URL, relay, server upload dan HQ compression tanpa mengubah aspect ratio, tetapi fail ini masih tidak dapat dihantar melalui Telegram cloud.`,
          best.url,
          `⬇️ Download ${best.quality || 'video'}`,
        );
      }
    }
  }

  if (platform === 'youtube' && !videoSent && !candidates.length) {
    const detail = String(initialDownloaderError?.message || '');
    const loginRequired = /private|sign in|login|members.only|authentication|cookies/i.test(detail);
    await sendMessage(
      chatId,
      loginRequired
        ? '❌ Video ini perlukan login/permission akaun. Video YouTube unlisted biasa yang boleh dibuka oleh sesiapa dengan link adalah disokong, tetapi private atau account-restricted tidak boleh diambil tanpa akses akaun.'
        : '❌ YouTube tak dapat dimuat turun kali ini. Video public dan unlisted yang boleh dibuka menggunakan link adalah disokong; cuba pastikan link penuh masih aktif.',
    );
    return;
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

async function processMediaModeChoice(callbackQuery, baseUrl) {
  const action = String(callbackQuery?.data || '');
  if (action !== MEDIA_DOWNLOAD && action !== MEDIA_STATUS_HQ) return false;

  const chatId = callbackQuery?.message?.chat?.id;
  if (!chatId) return true;

  const sourceText = callbackQuery?.message?.text || callbackQuery?.message?.caption || '';
  const url = extractFirstUrl(sourceText);
  const platform = url ? detectPlatform(url) : null;

  await telegram('answerCallbackQuery', {
    callback_query_id: callbackQuery.id,
    text: action === MEDIA_STATUS_HQ ? 'Status HQ dipilih.' : 'Download biasa dipilih.',
  }).catch(() => {});
  await disableChoiceButtons(callbackQuery);

  if (!url || !platform) {
    await sendMessage(chatId, '❌ Link asal tak dapat dibaca. Hantar semula link video itu.');
    return true;
  }

  if (action === MEDIA_STATUS_HQ) {
    await processStatusMessage(chatId, url, platform);
  } else {
    await processStandardDownload(chatId, url, platform, baseUrl);
  }
  return true;
}

async function processMessage(message) {
  const chatId = message?.chat?.id;
  const text = message?.text || message?.caption || '';
  if (!chatId) return;

  const commandToken = text.trim().split(/\s+/)[0]?.toLowerCase() || '';
  const command = commandToken.split('@')[0];
  if (command === '/start' || command === '/help') {
    await sendMessage(chatId, START_TEXT);
    return;
  }

  const statusMode = command === '/status' || command === 'status';
  const url = extractFirstUrl(text);
  if (!url) {
    await sendMessage(
      chatId,
      statusMode
        ? 'Guna format: /status <link video>'
        : 'Hantar satu link TikTok, Instagram, Threads, X/Twitter atau YouTube.',
    );
    return;
  }

  const platform = detectPlatform(url);
  if (!platform) {
    await sendMessage(chatId, 'Link ni belum disokong. Buat masa sekarang: TikTok, Instagram, Threads, X/Twitter dan YouTube.');
    return;
  }

  if (statusMode) {
    await processStatusMessage(chatId, url, platform);
    return;
  }

  await sendMediaModeChoice(chatId, url, platform);
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
    const baseUrl = requestBaseUrl(req);
    const callbackQuery = update?.callback_query;
    if (callbackQuery) {
      if (await processMediaModeChoice(callbackQuery, baseUrl)) {
        return json(res, 200, { ok: true });
      }
      await processTikTokSlideshowChoice(callbackQuery, baseUrl);
      return json(res, 200, { ok: true });
    }

    const message = update?.message ?? update?.edited_message;
    if (message) await processMessage(message);
    return json(res, 200, { ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return json(res, 200, { ok: false, handled: true });
  }
}
