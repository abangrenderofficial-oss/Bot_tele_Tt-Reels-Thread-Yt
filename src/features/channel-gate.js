import { isResetAdmin } from '../recovery.js';
import { sendMessage, telegram } from '../telegram.js';
import {
  hasCompletedUse,
  hasJoinPromptBeenSent,
  markJoinPromptSent,
} from '../bot/stats.js';

export const CHANNEL_VERIFY_CALLBACK = 'channel:verify:v1';

function channelUsername() {
  const configured = String(process.env.REQUIRED_CHANNEL_USERNAME || '@ar_downloaderbot').trim();
  if (!configured) return '@ar_downloaderbot';
  if (configured.startsWith('@')) return configured;
  if (/^https?:\/\/t\.me\//i.test(configured)) {
    const slug = configured.replace(/^https?:\/\/t\.me\//i, '').split(/[/?#]/)[0];
    return slug ? `@${slug}` : '@ar_downloaderbot';
  }
  return `@${configured.replace(/^@/, '')}`;
}

function channelUrl() {
  return `https://t.me/${channelUsername().replace(/^@/, '')}`;
}

function membershipAllowed(member = {}) {
  if (['creator', 'administrator', 'member'].includes(member?.status)) return true;
  return member?.status === 'restricted' && member?.is_member === true;
}

async function getMembership(userId) {
  if (!userId) return null;
  try {
    const member = await telegram('getChatMember', {
      chat_id: channelUsername(),
      user_id: userId,
    });
    return membershipAllowed(member);
  } catch (error) {
    // Fail open if Telegram has a temporary membership-check issue. This avoids
    // unrelated downloader outages while still enforcing the gate normally.
    console.warn('[channel-gate] getChatMember failed:', error?.message);
    return null;
  }
}

export async function sendChannelGatePrompt(chatId) {
  if (!chatId) return false;
  await sendMessage(
    chatId,
    [
      '📢 Join Our Official Channel',
      '',
      `Your first free process is complete. Join ${channelUsername()} to continue using the bot.`,
      '',
      'Get bot updates, new features and announcements there.',
    ].join('\n'),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📢 Join Channel', url: channelUrl() }],
          [{ text: "I've Joined ✅", callback_data: CHANNEL_VERIFY_CALLBACK }],
        ],
      },
    },
  );
  return true;
}

export async function maybePromptChannelAfterSuccess(chatId, userId) {
  if (!chatId || !userId || isResetAdmin(userId)) return false;
  if (await hasJoinPromptBeenSent(userId)) return false;

  const member = await getMembership(userId);
  if (member !== false) return false;

  try {
    await sendChannelGatePrompt(chatId);
    await markJoinPromptSent(userId);
    return true;
  } catch (error) {
    console.warn('[channel-gate] first-use prompt failed:', error?.message);
    return false;
  }
}

export async function enforceChannelGateForMessage(message = {}) {
  const chatId = message?.chat?.id;
  const userId = message?.from?.id;
  const chatType = message?.chat?.type;
  if (!chatId || !userId || chatType !== 'private' || isResetAdmin(userId)) return false;
  if (!(await hasCompletedUse(userId))) return false;

  const member = await getMembership(userId);
  if (member !== false) return false;

  await sendChannelGatePrompt(chatId).catch((error) => {
    console.warn('[channel-gate] message gate prompt failed:', error?.message);
  });
  return true;
}

export async function enforceChannelGateForCallback(callbackQuery = {}) {
  const chatId = callbackQuery?.message?.chat?.id;
  const chatType = callbackQuery?.message?.chat?.type;
  const userId = callbackQuery?.from?.id;
  if (!chatId || !userId || chatType !== 'private' || isResetAdmin(userId)) return false;
  if (!(await hasCompletedUse(userId))) return false;

  const member = await getMembership(userId);
  if (member !== false) return false;

  await telegram('answerCallbackQuery', {
    callback_query_id: callbackQuery.id,
    text: 'Join the official channel to continue.',
    show_alert: false,
  }).catch(() => {});
  await sendChannelGatePrompt(chatId).catch((error) => {
    console.warn('[channel-gate] callback gate prompt failed:', error?.message);
  });
  return true;
}

export async function processChannelGateCallback(callbackQuery = {}) {
  if (String(callbackQuery?.data || '') !== CHANNEL_VERIFY_CALLBACK) return false;

  const chatId = callbackQuery?.message?.chat?.id;
  const userId = callbackQuery?.from?.id;
  if (!chatId || !userId) return true;

  const member = await getMembership(userId);
  if (member === true) {
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: 'Verified ✅',
      show_alert: false,
    }).catch(() => {});

    await telegram('editMessageText', {
      chat_id: chatId,
      message_id: callbackQuery.message.message_id,
      text: `✅ Access unlocked.\n\nThanks for joining ${channelUsername()}. You can continue using the bot.`,
      disable_web_page_preview: true,
    }).catch(async () => {
      await sendMessage(chatId, '✅ Channel membership verified. You can continue using the bot.').catch(() => {});
    });
    return true;
  }

  if (member === false) {
    await telegram('answerCallbackQuery', {
      callback_query_id: callbackQuery.id,
      text: `I still can't verify your membership in ${channelUsername()}. Join first, then tap again.`,
      show_alert: true,
    }).catch(() => {});
    return true;
  }

  await telegram('answerCallbackQuery', {
    callback_query_id: callbackQuery.id,
    text: 'Telegram could not verify membership right now. Please try again shortly.',
    show_alert: true,
  }).catch(() => {});
  return true;
}
