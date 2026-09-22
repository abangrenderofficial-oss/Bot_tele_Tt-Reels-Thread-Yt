import crypto from 'node:crypto';

function completionSecret() {
  return String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
}

export function heavyCompletionPayload({ chatId, completionId, action = 'status_hq' } = {}) {
  return `${String(chatId || '').trim()}|${String(completionId || '').trim()}|${String(action || '').trim()}`;
}

export function createHeavyCompletionSignature(input, secret = completionSecret()) {
  const key = String(secret || '').trim();
  if (!key) return '';
  return crypto.createHmac('sha256', key).update(heavyCompletionPayload(input)).digest('hex');
}

export function verifyHeavyCompletionSignature(input, signature, secret = completionSecret()) {
  const expected = createHeavyCompletionSignature(input, secret);
  const actual = String(signature || '').trim().toLowerCase();
  if (!expected || !/^[a-f0-9]{64}$/.test(actual)) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}
