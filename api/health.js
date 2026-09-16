export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    service: 'telegram-social-downloader',
    telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    downloaderConfigured: Boolean(process.env.EASYDOWN_API_TOKEN),
  });
}
