import { verifyTransactionCallback } from '../src/payments/bayarcash.js';

function json(res, status, body) {
  res.status(status).json(body);
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      service: 'bayarcash-callback',
      configured: Boolean(
        process.env.BAYARCASH_API_TOKEN
        && process.env.BAYARCASH_API_SECRET_KEY
        && process.env.BAYARCASH_PORTAL_KEY,
      ),
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const valid = verifyTransactionCallback(payload);

  if (!valid) {
    console.warn('[bayarcash] rejected callback with invalid checksum', {
      order_number: payload?.order_number || null,
      status: payload?.status || null,
    });
    return json(res, 400, { ok: false, error: 'invalid_checksum' });
  }

  console.log('[bayarcash] verified transaction callback', {
    order_number: payload?.order_number || null,
    transaction_id: payload?.transaction_id || null,
    amount: payload?.amount || null,
    status: payload?.status || null,
    status_description: payload?.status_description || null,
  });

  return json(res, 200, { ok: true });
}
