export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(`<!doctype html>
<html lang="ms">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Support Bot</title>
  <style>
    body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#111;color:#fff;margin:0;display:grid;min-height:100vh;place-items:center;padding:24px;box-sizing:border-box}
    .card{max-width:520px;background:#1b1b1b;border:1px solid #333;border-radius:22px;padding:28px;text-align:center;box-shadow:0 18px 60px rgba(0,0,0,.35)}
    h1{font-size:28px;margin:0 0 12px}p{color:#d2d2d2;line-height:1.6;margin:8px 0}.heart{font-size:44px;margin-bottom:12px}
  </style>
</head>
<body>
  <main class="card">
    <div class="heart">❤️</div>
    <h1>Terima kasih!</h1>
    <p>Payment dah dihantar untuk diproses.</p>
    <p>Boleh kembali ke Telegram. Bila Bayarcash sahkan payment berjaya, bot akan hantar confirmation secara automatik.</p>
  </main>
</body>
</html>`);
}
