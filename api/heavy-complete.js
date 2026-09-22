import { markPremiumHqCompleted, recordUsage } from '../src/bot/stats.js';
import { maybePromptChannelAfterSuccess } from '../src/features/channel-gate.js';
import { verifyHeavyCompletionSignature } from '../src/heavy-completion.js';

function json(res, status, body) {
  return res.status(status).json(body);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const chatId = Number(body.chat_id || 0);
  const completionId = String(body.completion_id || '').trim().slice(0, 160);
  const action = String(body.action || '').trim();
  const signature = String(body.signature || '').trim();

  if (!Number.isSafeInteger(chatId) || chatId <= 0 || !completionId || action !== 'status_hq') {
    return json(res, 400, { ok: false, error: 'invalid_completion' });
  }

  const signedInput = { chatId, completionId, action };
  if (!verifyHeavyCompletionSignature(signedInput, signature)) {
    return json(res, 401, { ok: false, error: 'invalid_signature' });
  }

  const marked = await markPremiumHqCompleted(chatId, completionId);
  if (marked) {
    await recordUsage(chatId, 'status_hq');
    await maybePromptChannelAfterSuccess(chatId, chatId);
  }

  return json(res, 200, { ok: true, marked });
}
