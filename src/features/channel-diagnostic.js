import { hasChannelGateRequired } from '../bot/stats.js';
import { isResetAdmin } from '../recovery.js';
import { sendMessage, telegram } from '../telegram.js';

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

function membershipAllowed(member = {}) {
  if (['creator', 'administrator', 'member'].includes(member?.status)) return true;
  return member?.status === 'restricted' && member?.is_member === true;
}

function targetUserId(message = {}) {
  const text = String(message?.text || '').trim();
  const raw = text.split(/\s+/)[1] || '';
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function handleCheckMemberCommand(message = {}) {
  const chatId = message?.chat?.id;
  const ownerId = message?.from?.id;
  if (!chatId || !ownerId) return true;

  if (!isResetAdmin(ownerId)) {
    await sendMessage(chatId, '❌ /checkmember hanya untuk owner bot.').catch(() => {});
    return true;
  }

  const userId = targetUserId(message);
  if (!userId) {
    await sendMessage(chatId, 'Guna format: /checkmember <telegram_user_id>');
    return true;
  }

  const channel = channelUsername();
  const gateRequired = await hasChannelGateRequired(userId).catch(() => false);

  try {
    const member = await telegram('getChatMember', {
      chat_id: channel,
      user_id: userId,
    });
    const allowed = membershipAllowed(member);
    await sendMessage(chatId, [
      '🔎 Channel Membership Diagnostic',
      '',
      `User ID: ${userId}`,
      `Channel checked: ${channel}`,
      `Telegram status: ${String(member?.status || 'unknown')}`,
      `is_member: ${member?.is_member === undefined ? 'n/a' : String(member.is_member)}`,
      `Gate required: ${gateRequired ? 'YES' : 'NO'}`,
      `Bot access result: ${allowed ? '✅ ALLOW' : '⛔ BLOCK'}`,
    ].join('\n'));
  } catch (error) {
    await sendMessage(chatId, [
      '🔎 Channel Membership Diagnostic',
      '',
      `User ID: ${userId}`,
      `Channel checked: ${channel}`,
      `Gate required: ${gateRequired ? 'YES' : 'NO'}`,
      'Telegram check: ❌ ERROR',
      `Error: ${String(error?.message || error).slice(0, 300)}`,
      '',
      'Nota: channel gate sebenar fail-open bila Telegram API error, jadi error API sahaja sepatutnya tidak block user.',
    ].join('\n')).catch(() => {});
  }

  return true;
}
