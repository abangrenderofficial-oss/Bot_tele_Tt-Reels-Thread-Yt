import { telegram } from '../src/telegram.js';

function page(message = '', ok = false) {
  const status = message
    ? `<div style="margin:16px 0;padding:12px 14px;border-radius:10px;background:${ok ? '#e8fff0' : '#fff1f1'};color:${ok ? '#126b32' : '#9b1c1c'};font-family:system-ui">${message}</div>`
    : '';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>AR Downloader Setup</title>
</head>
<body style="margin:0;background:#0f1115;color:#f5f7fb;font-family:system-ui;display:grid;place-items:center;min-height:100vh">
  <main style="width:min(92vw,460px);background:#171a21;border:1px solid #2a2f3a;border-radius:16px;padding:24px;box-sizing:border-box">
    <h1 style="margin:0 0 8px;font-size:24px">AR Downloader Setup</h1>
    <p style="margin:0 0 18px;color:#aeb6c3;line-height:1.5">Masukkan SETUP_SECRET dari Vercel untuk register Telegram webhook.</p>
    ${status}
    <form method="post">
      <label style="display:block;margin-bottom:8px;color:#d8dde6">SETUP_SECRET</label>
      <input name="secret" type="password" autocomplete="off" required style="width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #394150;background:#0f1115;color:#fff;margin-bottom:14px" />
      <button type="submit" style="width:100%;padding:12px;border:0;border-radius:10px;background:#7c3aed;color:#fff;font-weight:700;cursor:pointer">Connect Telegram Webhook</button>
    </form>
  </main>
</body>
</html>`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    return res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(page());
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).send('Method Not Allowed');
  }

  const setupSecret = process.env.SETUP_SECRET;
  const submitted = String(req.body?.secret || '');
  if (!setupSecret || submitted !== setupSecret) {
    return res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8').send(page('SETUP_SECRET salah.', false));
  }

  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!process.env.TELEGRAM_BOT_TOKEN || !webhookSecret) {
    return res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8').send(page('TELEGRAM_BOT_TOKEN atau TELEGRAM_WEBHOOK_SECRET belum lengkap dalam Vercel.', false));
  }

  const explicitBase = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '');
  const hostBase = req.headers.host ? `https://${req.headers.host}` : '';
  const baseUrl = explicitBase || hostBase;
  if (!baseUrl) {
    return res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8').send(page('Tak dapat kesan public Vercel URL.', false));
  }

  try {
    await telegram('setWebhook', {
      url: `${baseUrl}/api/telegram`,
      secret_token: webhookSecret,
      allowed_updates: ['message', 'edited_message'],
      drop_pending_updates: true,
    });

    return res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(page(`Webhook berjaya disambungkan ke ${baseUrl}/api/telegram. Sekarang buka bot di Telegram dan tekan Start.`, true));
  } catch (error) {
    console.error('Browser webhook setup failed:', error?.message);
    return res.status(500).setHeader('Content-Type', 'text/html; charset=utf-8').send(page('Webhook setup gagal. Semak token bot dan cuba lagi.', false));
  }
}
