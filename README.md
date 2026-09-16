# Telegram Social Downloader Bot

A lightweight Telegram webhook bot for public media links from:

- TikTok
- Instagram Reels / posts
- Threads
- YouTube / Shorts

The bot runs as Vercel Functions. It does not keep a media library or database. It asks a downloader API for a temporary/direct media URL, then asks Telegram to fetch the media into the chat. If Telegram cannot fetch the media directly, the bot falls back to a download button.

> Use only for content you own or have permission to download.

## Architecture

`Telegram user -> /api/telegram -> EasyDown API -> direct media URL -> Telegram`

No Supabase is required for V1.

## Required environment variables

Copy `.env.example` and configure these in Vercel:

- `TELEGRAM_BOT_TOKEN` - token from BotFather
- `TELEGRAM_WEBHOOK_SECRET` - random secret used to validate Telegram webhook requests
- `SETUP_SECRET` - random secret used only to protect `/api/setup-webhook`
- `EASYDOWN_API_TOKEN` - downloader API token

Optional:

- `PUBLIC_BASE_URL` - production URL such as `https://your-project.vercel.app`; normally the setup endpoint can detect the host automatically
- `EASYDOWN_API_URL` - defaults to `https://api.easydown.org/api/v1/parse`
- `DOWNLOADER_TIMEOUT_MS` - defaults to `20000`

Never commit real tokens to GitHub.

## Vercel endpoints

- `GET /api/health` - health/config status
- `GET /api/telegram` - webhook endpoint status
- `POST /api/telegram` - Telegram webhook receiver
- `POST /api/setup-webhook` - protected one-time webhook registration helper

## Register Telegram webhook

Recommended after deployment and environment variables are configured:

```bash
curl -X POST "https://<YOUR_VERCEL_DOMAIN>/api/setup-webhook" \
  -H "Authorization: Bearer <SETUP_SECRET>"
```

The setup endpoint registers `/api/telegram` with Telegram and uses `TELEGRAM_WEBHOOK_SECRET` to authenticate incoming webhook requests.

You can also register the webhook directly with Telegram's `setWebhook` API if preferred.

## User flow

1. User sends a supported public social-media URL.
2. Bot detects the platform.
3. Bot resolves downloadable media through the configured downloader API.
4. Bot tries to send the media directly into Telegram.
5. If Telegram cannot fetch it because of URL/CDN/file-size restrictions, bot sends a direct download button instead.

## Notes

Telegram's cloud Bot API has stricter limits when Telegram itself fetches a file by HTTP URL. Large YouTube videos will often need the fallback download button unless a different media-delivery architecture is added later.
