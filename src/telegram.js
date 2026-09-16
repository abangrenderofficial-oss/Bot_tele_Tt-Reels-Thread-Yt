function botToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    const err = new Error('Telegram bot token is not configured.');
    err.code = 'TELEGRAM_NOT_CONFIGURED';
    throw err;
  }
  return token;
}

export async function telegram(method, payload = {}) {
  const response = await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25000),
  });

  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    const err = new Error(result?.description || `Telegram ${method} failed (${response.status}).`);
    err.code = 'TELEGRAM_API_ERROR';
    err.status = response.status;
    throw err;
  }
  return result.result;
}

export function sendMessage(chatId, text, extra = {}) {
  return telegram('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...extra,
  });
}

export function sendChatAction(chatId, action = 'typing') {
  return telegram('sendChatAction', { chat_id: chatId, action });
}

export function sendVideoUrl(chatId, url, caption = '') {
  return telegram('sendVideo', {
    chat_id: chatId,
    video: url,
    caption: caption.slice(0, 1024),
    supports_streaming: true,
  });
}

export function sendPhotoUrl(chatId, url, caption = '') {
  return telegram('sendPhoto', {
    chat_id: chatId,
    photo: url,
    caption: caption.slice(0, 1024),
  });
}

export function sendMediaGroup(chatId, items) {
  return telegram('sendMediaGroup', {
    chat_id: chatId,
    media: items.slice(0, 10),
  });
}

export function sendDownloadButton(chatId, text, url, label = '⬇️ Download') {
  return sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [[{ text: label, url }]],
    },
  });
}
