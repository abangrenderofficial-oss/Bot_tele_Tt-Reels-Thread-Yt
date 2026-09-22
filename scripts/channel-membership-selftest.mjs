const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const configured = String(process.env.REQUIRED_CHANNEL_USERNAME || '@ar_downloaderbot').trim();
const channel = configured.startsWith('@')
  ? configured
  : `@${configured.replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '').split(/[/?#]/)[0]}`;

if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required.');
if (!channel || channel === '@') throw new Error('Required channel username is invalid.');

async function telegram(method, payload = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(body?.description || `Telegram ${method} failed with HTTP ${response.status}`);
  }
  return body.result;
}

const me = await telegram('getMe');
const membership = await telegram('getChatMember', {
  chat_id: channel,
  user_id: me.id,
});

if (!['creator', 'administrator'].includes(membership?.status)) {
  throw new Error(`Bot must be an administrator in ${channel}; current status=${membership?.status || 'unknown'}`);
}

console.log('CHANNEL_MEMBERSHIP_SELFTEST_OK', JSON.stringify({
  channel,
  botId: me.id,
  botStatus: membership.status,
  canReliablyVerifyOtherMembers: true,
}));
