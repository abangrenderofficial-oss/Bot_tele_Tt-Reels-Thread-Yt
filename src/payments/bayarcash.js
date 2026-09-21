import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const LIVE_BASE_URL = 'https://api.console.bayar.cash/v3/';
const SANDBOX_BASE_URL = 'https://api.console.bayarcash-sandbox.com/v3/';

const TRANSACTION_CALLBACK_FIELDS = [
  'record_type',
  'transaction_id',
  'exchange_reference_number',
  'exchange_transaction_id',
  'order_number',
  'currency',
  'amount',
  'payer_name',
  'payer_email',
  'payer_bank_name',
  'status',
  'status_description',
  'datetime',
];

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    const error = new Error(`${name} is not configured.`);
    error.code = 'BAYARCASH_NOT_CONFIGURED';
    throw error;
  }
  return value;
}

function baseUrl() {
  return String(process.env.BAYARCASH_SANDBOX || '').toLowerCase() === 'true'
    ? SANDBOX_BASE_URL
    : LIVE_BASE_URL;
}

function normalizeAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error('Invalid support amount.');
    error.code = 'BAYARCASH_INVALID_AMOUNT';
    throw error;
  }
  return amount.toFixed(2);
}

function checksum(secret, payload) {
  const values = Object.keys(payload)
    .sort()
    .map((key) => String(payload[key] ?? ''));
  return createHmac('sha256', secret).update(values.join('|')).digest('hex');
}

function paymentIntentChecksum(secret, data) {
  return checksum(secret, {
    payment_channel: String(data.payment_channel ?? ''),
    order_number: data.order_number,
    amount: data.amount,
    payer_name: data.payer_name,
    payer_email: data.payer_email,
  });
}

export function createSupportOrderNumber() {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = randomBytes(5).toString('hex').toUpperCase();
  return `SUP-${stamp}-${random}`.slice(0, 30);
}

function payerName(user = {}) {
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return full || user.username || 'Telegram Supporter';
}

function payerEmail() {
  const configured = String(process.env.BAYARCASH_PAYER_EMAIL || '').trim();
  if (configured) return configured;
  const error = new Error('BAYARCASH_PAYER_EMAIL is required for Bayarcash payment intent.');
  error.code = 'BAYARCASH_PAYER_EMAIL_REQUIRED';
  throw error;
}

function paymentChannel() {
  const raw = String(process.env.BAYARCASH_PAYMENT_CHANNEL || '').trim();
  return /^\d+$/.test(raw) && Number(raw) > 0 ? raw : '';
}

function payerPhone() {
  return String(process.env.BAYARCASH_PAYER_PHONE || '').trim();
}

function publicUrls(publicBaseUrl) {
  const base = String(publicBaseUrl || process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (!base) {
    const error = new Error('PUBLIC_BASE_URL is required for Bayarcash callback.');
    error.code = 'BAYARCASH_PUBLIC_URL_MISSING';
    throw error;
  }
  return {
    callbackUrl: `${base}/api/bayarcash`,
    returnUrl: `${base}/api/support-return`,
  };
}

export function isBayarcashConfigured() {
  return Boolean(
    String(process.env.BAYARCASH_API_TOKEN || '').trim()
    && String(process.env.BAYARCASH_API_SECRET_KEY || '').trim()
    && String(process.env.BAYARCASH_PORTAL_KEY || '').trim(),
  );
}

export async function createSupportPayment({ amount, user, publicBaseUrl, orderNumber = '' }) {
  const apiToken = requiredEnv('BAYARCASH_API_TOKEN');
  const apiSecret = requiredEnv('BAYARCASH_API_SECRET_KEY');
  const portalKey = requiredEnv('BAYARCASH_PORTAL_KEY');
  const { callbackUrl, returnUrl } = publicUrls(publicBaseUrl);
  const normalizedAmount = normalizeAmount(amount);
  const channel = paymentChannel();

  const data = {
    portal_key: portalKey,
    order_number: String(orderNumber || createSupportOrderNumber()).slice(0, 30),
    amount: normalizedAmount,
    payer_name: payerName(user),
    payer_email: payerEmail(),
    callback_url: callbackUrl,
    return_url: returnUrl,
  };

  if (channel) data.payment_channel = channel;
  const phone = payerPhone();
  if (phone) data.payer_telephone_number = phone;

  data.checksum = paymentIntentChecksum(apiSecret, data);

  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === '') continue;
    form.set(key, String(value));
  }
  form.set('metadata[purpose]', 'telegram_bot_support');
  form.set('metadata[description]', 'Support for Telegram Bot Development & Server Costs');

  const response = await fetch(`${baseUrl()}payment-intents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(Number(process.env.BAYARCASH_TIMEOUT_MS || 30000)),
  });

  const raw = await response.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }

  if (!response.ok) {
    const message = body?.message || body?.error || raw || `Bayarcash HTTP ${response.status}`;
    const error = new Error(String(message));
    error.code = 'BAYARCASH_PAYMENT_INTENT_FAILED';
    error.status = response.status;
    error.details = body || raw;
    throw error;
  }

  const paymentUrl = body?.url || body?.data?.url;
  if (!paymentUrl) {
    const error = new Error('Bayarcash did not return a payment URL.');
    error.code = 'BAYARCASH_PAYMENT_URL_MISSING';
    error.details = body;
    throw error;
  }

  return {
    orderNumber: data.order_number,
    amount: normalizedAmount,
    url: paymentUrl,
    paymentIntentId: body?.id || body?.data?.id || null,
    raw: body,
  };
}

export function verifyTransactionCallback(payload = {}) {
  const secret = String(process.env.BAYARCASH_API_SECRET_KEY || '').trim();
  const provided = String(payload?.checksum || '').trim();
  if (!secret || !provided) return false;

  const signed = {};
  for (const field of TRANSACTION_CALLBACK_FIELDS) signed[field] = String(payload?.[field] ?? '');
  const expected = checksum(secret, signed);

  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}
