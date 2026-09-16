import { telegram } from '../src/telegram.js';

function bearerToken(req) {
  const value = req.headers.authorization || '';
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const setupSecret = process.env.SETUP_SECRET;
  if (!setupSecret || bearerToken(req) !== setupSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!process.env.TELEGRAM_BOT_TOKEN || !webhookSecret) {
    return res.status(400).json({
      ok: false,
      error: 'missing_configuration',
      required: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'],
    });
  }

  const explicitBase = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '');
  const hostBase = req.headers.host ? `https://${req.headers.host}` : '';
  const baseUrl = explicitBase || hostBase;
  if (!baseUrl) {
    return res.status(400).json({ ok: false, error: 'cannot_determine_public_url' });
  }

  try {
    const result = await telegram('setWebhook', {
      url: `${baseUrl}/api/telegram`,
      secret_token: webhookSecret,
      allowed_updates: ['message', 'edited_message', 'callback_query'],
      drop_pending_updates: true,
    });

    return res.status(200).json({
      ok: true,
      webhook: `${baseUrl}/api/telegram`,
      result,
    });
  } catch (error) {
    console.error('Webhook setup failed:', error?.message);
    return res.status(500).json({ ok: false, error: 'webhook_setup_failed' });
  }
}
