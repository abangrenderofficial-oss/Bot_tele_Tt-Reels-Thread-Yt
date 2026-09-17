const baseUrl = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const botToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const webhookSecret = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();

if (!baseUrl || !botToken) {
  console.error('Webhook registration skipped: PUBLIC_BASE_URL or TELEGRAM_BOT_TOKEN is missing.');
  process.exit(1);
}

const apiBase = `https://api.telegram.org/bot${botToken}`;
const currentResponse = await fetch(`${apiBase}/getWebhookInfo`);
const currentJson = await currentResponse.json().catch(() => ({}));
const current = currentJson?.result || {};

const next = new URL(`${baseUrl}/api/telegram`);
if (current?.url) {
  try {
    const existing = new URL(current.url);
    const mirrorGroup = existing.searchParams.get('mirror_group');
    if (mirrorGroup) next.searchParams.set('mirror_group', mirrorGroup);
  } catch {}
}

const payload = {
  url: next.toString(),
  allowed_updates: ['message', 'edited_message', 'callback_query'],
  drop_pending_updates: false,
  ...(webhookSecret ? { secret_token: webhookSecret } : {}),
};

const response = await fetch(`${apiBase}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(25000),
});

const result = await response.json().catch(() => ({}));
if (!response.ok || !result?.ok) {
  console.error('Telegram webhook registration failed:', result?.description || `HTTP ${response.status}`);
  process.exit(1);
}

const verifyResponse = await fetch(`${apiBase}/getWebhookInfo`);
const verifyJson = await verifyResponse.json().catch(() => ({}));
const registeredUrl = verifyJson?.result?.url || '';

if (registeredUrl !== next.toString()) {
  console.error('Telegram webhook verification failed.');
  process.exit(1);
}

console.log(`Telegram webhook registered: ${next.origin}${next.pathname}`);
