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
  getTelegramFileSource,
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
const MEDIA_STATUS_HQ = 'media:status:v2';

const START_TEXT = [
  '📥 Social Downloader Bot',
  '',
  'Hantar link TikTok, Instagram, Threads, X/Twitter atau YouTube.',
  'Bot akan terus hantar video high quality seperti biasa.',
  '',
  'Di bawah video ada butang 📱 Status HQ.',
  'Tekan butang itu jika mahu versi khas WhatsApp Status: satu fail sahaja, H.264/AAC, ratio asal kekal dan bitrate disesuaikan supaya lebih tahan compression Status.',
  '',
  'Untuk sambung bot ke group:',
  '1. Invite bot ke group.',
  '2. Pastikan bot boleh send media/message.',
  '3. Admin group taip /connect.',
  'Selepas connect, setiap video yang bot hantar kepada user akan dicopy terus ke group bersama username user. Tiada Supabase digunakan.',
  '',
  'YouTube public/unlisted yang boleh dibuka dengan link disokong.',
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

function mirrorGroupFromRequest(req) {
  const raw = Array.isArray(req?.query?.mirror_group) ? req.query.mirror_group[0] : req?.query?.mirror_group;
  const value = String(raw || '').trim();
  return /^-?\d+$/.test(value) ? value : '';
}

function safeTitle(media, platform) {
  const title = String(media?.title || '').trim();
  return title ? `${platformLabel(platform)} • ${title}`.slice(0, 760) : `${platformLabel(platform)} download`;
}

function sourceCaption(title, url, quality = '') {
  const suffix = [quality ? `🎬 ${quality}` : '', url ? `🔗 ${url}` : ''].filter(Boolean).join('\n');
  const budget = Math.max(80, 1020 - suffix.length);
  const head = String(title || 'Video').slice(0, budget);
  return suffix ? `${head}\n${suffix}`.slice(0, 1024) : head.slice(0, 1024);
}

function statusButton() {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: '📱 Status HQ', callback_data: MEDIA_STATUS_HQ }]],
    },
  };
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

function userLabel(from = {}) {
  if (from.username) return `@${from.username}`;
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  return name || (from.id ? `Telegram ID ${from.id}` : 'Unknown user');
}

async function mirrorVideoToGroup(sourceChatId, sentMessage, mirrorGroupId, from) {
  if (!mirrorGroupId || !sentMessage?.message_id) return false;
  if (String(sourceChatId) === String(mirrorGroupId)) return false;

  const originalCaption = String(sentMessage.caption || '').trim();
  const caption = [`👤 User: ${userLabel(from)}`, originalCaption].filter(Boolean).join('\n').slice(0, 1024);

  try {
    await telegram('copyMessage', {
      chat_id: mirrorGroupId,
      from_chat_id: sourceChatId,
      message_id: sentMessage.message_id,
      caption,
      ...statusButton(),
    });
    return true;
  } catch (error) {
    console.warn('Group mirror failed:', error?.code, error?.message);
    return false;
  }
}

async function isGroupAdmin(chatId, userId) {
  if (!chatId || !userId) return false;
  try {
    const member = await telegram('getChatMember', { chat_id: chatId, user_id: userId });
    return member?.status === 'creator' || member?.status === 'administrator';
  } catch {
    return false;
  }
}

async function setMirrorWebhook(baseUrl, mirrorGroupId = '') {
  if (!baseUrl) throw new Error('Public webhook base URL is unavailable.');
  const endpoint = new URL(`${baseUrl}/api/telegram`);
  if (mirrorGroupId) endpoint.searchParams.set('mirror_group', String(mirrorGroupId));

  await telegram('setWebhook', {
    url: endpoint.toString(),
    ...(process.env.TELEGRAM_WEBHOOK_SECRET ? { secret_token: process.env.TELEGRAM_WEBHOOK_SECRET } : {}),
    allowed_updates: ['message', 'edited_message', 'callback_query'],
    drop_pending_updates: false,
  });
}

async function handleConnectCommand(message, baseUrl, disconnect = false) {
  const chatId = message?.chat?.id;
  const chatType = message?.chat?.type;
  const userId = message?.from?.id;

  if (!['group', 'supergroup'].includes(chatType)) {
    await sendMessage(chatId, '❌ /connect hanya boleh digunakan di dalam group Telegram.');
    return;
  }

  if (!(await isGroupAdmin(chatId, userId))) {
    await sendMessage(chatId, '❌ Hanya admin group boleh guna command ini.');
    return;
  }

  try {
    await setMirrorWebhook(baseUrl, disconnect ? '' : chatId);
    if (disconnect) {
      await sendMessage(chatId, '✅ Group ini sudah disconnect daripada mirror bot.');
    } else {
      await sendMessage(chatId, '✅ Connected. Mulai sekarang video yang user download melalui bot akan dicopy terus ke group ini bersama username user.');
    }
  } catch (error) {
    console.error('Connect webhook failed:', error?.message);
    await sendMessage(chatId, '❌ Tak berjaya connect group sekarang. Cuba sekali lagi.');
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

  if (prepared.some((item) => !item)) return sendImageFallback(chatId, images, title);

  if (prepared.length === 1) {
    try {
      await sendPhotoUrl(chatId, prepared[0].url, title);
      return;
    } catch {
      return sendImageFallback(chatId, images, title);
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

async function deliverCompressedSocial(chatId, video, title, durationHint, sourceUrl) {
  let prepared = null;
  try {
    prepared = await prepareSocialVideoTelegramUpload(video, configuredUploadLimit(), {
      duration: Number(video?.duration || durationHint || 0) || null,
    });
    const caption = sourceCaption(title, sourceUrl, prepared.compressed ? prepared.quality : '');
    return await sendVideoFileUpload(chatId, prepared.filePath, caption, statusButton());
  } catch (error) {
    console.warn('Social HQ compression/upload failed:', error?.code, error?.message);
    return null;
  } finally {
    if (prepared?.cleanup) await prepared.cleanup().catch(() => {});
  }
}

async function deliverVideo(chatId, video, title, baseUrl, options = {}) {
  if (!video?.url) return null;

  const size = Number(video.filesize || 0);
  const customHeaders = needsCustomHeaders(video);
  const relay = relayItem(baseUrl, video);
  const uploadLimit = configuredUploadLimit();
  const allowSocialCompression = options.platform && options.platform !== 'youtube';
  const caption = sourceCaption(title, options.sourceUrl || '', video.quality || '');

  if (!size || size <= TELEGRAM_URL_FETCH_MAX) {
    const fetchUrl = customHeaders ? relay?.url : video.url;
    if (fetchUrl) {
      try {
        return await sendVideoUrl(chatId, fetchUrl, caption, statusButton());
      } catch (error) {
        console.warn('Telegram URL fetch failed, trying server upload:', error?.message);
      }
    }
  }

  if (size && size > uploadLimit) {
    if (allowSocialCompression) {
      return deliverCompressedSocial(chatId, video, title, options.duration, options.sourceUrl);
    }
    console.warn(`Skipping ${video.quality || 'video'}: known size ${size} exceeds Telegram upload limit ${uploadLimit}.`);
    return null;
  }

  try {
    return await sendVideoUpload(chatId, video, caption, statusButton());
  } catch (error) {
    console.warn('Telegram server upload failed:', error?.code, error?.message);
    if (allowSocialCompression) {
      return deliverCompressedSocial(chatId, video, title, options.duration, options.sourceUrl);
    }
    return null;
  }
}

async function deliverPreferredYouTube(chatId, url, title) {
  let prepared = null;
  try {
    prepared = await prepareYouTubeTelegramUpload(url, configuredUploadLimit());
    const caption = sourceCaption(title, url, prepared.quality);
    return await sendVideoFileUpload(chatId, prepared.filePath, caption, statusButton());
  } catch (error) {
    console.warn('Preferred YouTube pipeline failed:', error?.code, error?.message);
    return null;
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
    console.error('TikTok slideshow split failed:', error?.code, error?.message);
    await sendMessage(chatId, '❌ Proses Image + Audio tak dapat disiapkan. Cuba semula.').catch(() => {});
  } finally {
    if (preparedSound?.cleanup) await preparedSound.cleanup().catch(() => {});
  }
}

async function processTikTokVideo(callbackQuery, mirrorGroupId = '') {
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
    const sent = await sendVideoFileUpload(
      chatId,
      preparedVideo.filePath,
      sourceCaption('TikTok slideshow', extractFirstUrl(callbackQuery?.message?.text || ''), preparedVideo.quality),
      statusButton(),
    );
    await mirrorVideoToGroup(chatId, sent, mirrorGroupId, callbackQuery.from);
  } catch (error) {
    console.error('TikTok slideshow video failed:', error?.code, error?.message);
    await sendMessage(chatId, '❌ Tak berjaya gabungkan slideshow + audio menjadi video. Cuba semula kemudian.');
  } finally {
    if (preparedVideo?.cleanup) await preparedVideo.cleanup().catch(() => {});
  }
}

async function processTikTokSlideshowChoice(callbackQuery, baseUrl, mirrorGroupId = '') {
  const action = String(callbackQuery?.data || '');
  if (action === TT_SLIDE_SPLIT) {
    await processTikTokSplit(callbackQuery, baseUrl);
    return true;
  }
  if (action === TT_SLIDE_VIDEO) {
    await processTikTokVideo(callbackQuery, mirrorGroupId);
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

async function prepareStatusFromSourceUrl(url, platform) {
  const media = await resolveStatusMedia(platform, url);
  const best = platform === 'youtube' ? null : chooseBestVideo(media.videos || []);
  if (platform !== 'youtube' && !best) {
    const err = new Error('No suitable source video for Status HQ.');
    err.code = 'STATUS_SOURCE_NOT_FOUND';
    throw err;
  }
  return prepareWhatsAppStatusHQ({ sourceUrl: url, platform, video: best });
}

async function processStatusFromLink(chatId, url, platform, mirrorGroupId = '', from = {}) {
  let prepared = null;
  try {
    await sendMessage(chatId, '📱 Status HQ sedang disediakan… satu fail sahaja, ratio asal dikekalkan.');
    await sendChatAction(chatId, 'upload_video').catch(() => {});
    prepared = await prepareStatusFromSourceUrl(url, platform);
    const sent = await sendVideoFileUpload(
      chatId,
      prepared.filePath,
      `📱 ${prepared.quality}\n✅ Satu fail • ratio asal kekal`,
    );
    await mirrorVideoToGroup(chatId, sent, mirrorGroupId, from);
  } catch (error) {
    console.error('Status HQ from link failed:', error?.code, error?.message);
    await sendMessage(chatId, '❌ Status HQ tak dapat disiapkan untuk link ini. Cuba semula kemudian.').catch(() => {});
  } finally {
    if (prepared?.cleanup) await prepared.cleanup().catch(() => {});
  }
}

async function processStatusButton(callbackQuery, mirrorGroupId = '') {
  if (String(callbackQuery?.data || '') !== MEDIA_STATUS_HQ) return false;

  const chatId = callbackQuery?.message?.chat?.id;
  const fileId = callbackQuery?.message?.video?.file_id;
  const caption = callbackQuery?.message?.caption || '';
  const sourceUrl = extractFirstUrl(caption);
  const sourcePlatform = sourceUrl ? detectPlatform(sourceUrl) : null;
  if (!chatId) return true;

  await telegram('answerCallbackQuery', {
    callback_query_id: callbackQuery.id,
    text: 'Status HQ sedang diproses…',
  }).catch(() => {});
  await disableChoiceButtons(callbackQuery);
  await sendMessage(chatId, '📱 Sedang tukar video ini ke Status HQ… satu fail, ratio asal kekal.').catch(() => {});
  await sendChatAction(chatId, 'upload_video').catch(() => {});

  let prepared = null;
  try {
    if (!fileId) throw new Error('Video file_id missing from callback message.');

    try {
      const telegramVideo = await getTelegramFileSource(fileId);
      prepared = await prepareWhatsAppStatusHQ({
        sourceUrl: '',
        platform: 'telegram',
        video: telegramVideo,
      });
    } catch (telegramFileError) {
      console.warn('Status HQ Telegram-file path failed, trying source URL:', telegramFileError?.code, telegramFileError?.message);
      if (!sourceUrl || !sourcePlatform) throw telegramFileError;
      prepared = await prepareStatusFromSourceUrl(sourceUrl, sourcePlatform);
    }

    const sent = await sendVideoFileUpload(
      chatId,
      prepared.filePath,
      `📱 ${prepared.quality}\n✅ Satu fail • ratio asal kekal`,
    );
    await mirrorVideoToGroup(chatId, sent, mirrorGroupId, callbackQuery.from);
  } catch (error) {
    console.error('Status HQ button failed:', error?.code, error?.message);
    await sendMessage(chatId, '❌ Status HQ tak dapat disiapkan untuk video ini. Cuba hantar semula link dan tekan Status HQ sekali lagi.').catch(() => {});
  } finally {
    if (prepared?.cleanup) await prepared.cleanup().catch(() => {});
  }
  return true;
}

async function processStandardDownload(chatId, url, platform, baseUrl, mirrorGroupId = '', from = {}) {
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
  const candidates = orderedVideoCandidates(media.videos || []);
  let sentVideo = null;

  if (platform === 'youtube') {
    await sendChatAction(chatId, 'upload_video').catch(() => {});
    sentVideo = await deliverPreferredYouTube(chatId, url, title);
  }

  if (candidates.length && !sentVideo) {
    await sendChatAction(chatId, 'upload_video').catch(() => {});
    for (const candidate of candidates.slice(0, 6)) {
      sentVideo = await deliverVideo(chatId, candidate, title, baseUrl, {
        platform,
        duration: media.duration,
        sourceUrl: url,
      });
      if (sentVideo) break;
    }

    if (!sentVideo) {
      const best = chooseBestVideo(media.videos);
      if (best) {
        await sendDownloadButton(
          chatId,
          `${title}\n\nBot dah cuba direct URL, relay, server upload dan HQ compression tetapi fail ini masih tidak dapat dihantar melalui Telegram cloud.`,
          best.url,
          `⬇️ Download ${best.quality || 'video'}`,
        );
      }
    }
  }

  if (sentVideo) {
    await mirrorVideoToGroup(chatId, sentVideo, mirrorGroupId, from);
  }

  if (platform === 'youtube' && !sentVideo && !candidates.length) {
    const detail = String(initialDownloaderError?.message || '');
    const loginRequired = /private|sign in|login|members.only|authentication|cookies/i.test(detail);
    await sendMessage(
      chatId,
      loginRequired
        ? '❌ Video ini perlukan login/permission akaun. Unlisted biasa yang boleh dibuka oleh sesiapa dengan link adalah disokong.'
        : '❌ YouTube tak dapat dimuat turun kali ini. Cuba pastikan link penuh masih aktif.',
    );
    return;
  }

  if (media.images?.length) {
    await sendChatAction(chatId, 'upload_photo').catch(() => {});
    await deliverImages(chatId, media.images, sentVideo ? `${platformLabel(platform)} images` : title, baseUrl);
  }

  if (!candidates.length && !media.images?.length && media.audios?.length) {
    const audio = media.audios[0];
    await sendDownloadButton(chatId, `${title}\n\nAudio tersedia:`, audio.url, '🎵 Download audio');
  }
}

async function processMessage(message, context) {
  const chatId = message?.chat?.id;
  const text = message?.text || message?.caption || '';
  if (!chatId) return;

  const commandToken = text.trim().split(/\s+/)[0]?.toLowerCase() || '';
  const command = commandToken.split('@')[0];

  if (command === '/connect') {
    await handleConnectCommand(message, context.baseUrl, false);
    return;
  }
  if (command === '/disconnect') {
    await handleConnectCommand(message, context.baseUrl, true);
    return;
  }
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
    await processStatusFromLink(chatId, url, platform, context.mirrorGroupId, message.from);
    return;
  }

  await processStandardDownload(chatId, url, platform, context.baseUrl, context.mirrorGroupId, message.from);
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      service: 'telegram-social-downloader',
      endpoint: 'webhook',
      mirror_connected: Boolean(mirrorGroupFromRequest(req)),
    });
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
    const context = {
      baseUrl: requestBaseUrl(req),
      mirrorGroupId: mirrorGroupFromRequest(req),
    };

    const callbackQuery = update?.callback_query;
    if (callbackQuery) {
      if (await processStatusButton(callbackQuery, context.mirrorGroupId)) {
        return json(res, 200, { ok: true });
      }
      await processTikTokSlideshowChoice(callbackQuery, context.baseUrl, context.mirrorGroupId);
      return json(res, 200, { ok: true });
    }

    const message = update?.message ?? update?.edited_message;
    if (message) await processMessage(message, context);
    return json(res, 200, { ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return json(res, 200, { ok: false, handled: true });
  }
}
