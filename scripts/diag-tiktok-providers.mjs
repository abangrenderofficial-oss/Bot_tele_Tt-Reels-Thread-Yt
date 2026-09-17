// Temporary Railway lab: send one valid public TikTok link through the real Telegram webhook.
const endpoint = 'https://bottelett-reels-thread-yt-production.up.railway.app/api/telegram';
const owner = Number(process.env.TEST_OWNER_ID || process.env.BOT_OWNER_ID || 0);
const secret = process.env.TEST_WEBHOOK_SECRET || '';
const link = 'https://vt.tiktok.com/ZSq2ay9yC/';

if (!owner) {
  console.error('SELFTEST_MISSING_OWNER');
  process.exit(2);
}
if (!secret) {
  console.error('SELFTEST_MISSING_SECRET');
  process.exit(3);
}

const now = Math.floor(Date.now() / 1000);
const nonce = Number(String(Date.now()).slice(-8));
const update = {
  update_id: 900000000 + (nonce % 90000000),
  message: {
    message_id: 800000000 + (nonce % 90000000),
    date: now,
    chat: { id: owner, type: 'private' },
    from: { id: owner, is_bot: false, first_name: 'Owner' },
    text: link,
    entities: [{ offset: 0, length: link.length, type: 'url' }],
  },
};

const started = Date.now();
console.log('SELFTEST_TARGET', endpoint);
console.log('SELFTEST_LINK', link);

try {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': secret,
    },
    body: JSON.stringify(update),
    signal: AbortSignal.timeout(240000),
  });
  const body = await response.text();
  console.log('SELFTEST_HTTP', response.status, 'MS', Date.now() - started, 'BODY', body.slice(0, 2000));
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  console.error('SELFTEST_ERROR', error?.name || '', error?.message || error, 'MS', Date.now() - started);
  process.exitCode = 1;
}
