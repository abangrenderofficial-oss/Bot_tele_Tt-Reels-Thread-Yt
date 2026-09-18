import { sendMessage, telegram } from '../telegram.js';

function statusProgressText(percent) {
  const value = Math.max(1, Math.min(100, Math.round(Number(percent) || 1)));
  const filled = value >= 100 ? 10 : Math.min(9, Math.floor(value / 10));
  const bar = `${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}`;
  return `🔋 Status HQ sedang diproses...\n${bar} ${value}%`;
}

function liveProgressText(percent) {
  const value = Math.max(1, Math.min(100, Math.round(Number(percent) || 1)));
  const filled = value >= 100 ? 10 : Math.min(9, Math.floor(value / 10));
  const bar = `${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}`;
  return `🍎 Live Wallpaper sedang diproses...\n${bar} ${value}%`;
}

async function startProgress(chatId, textBuilder) {
  const progressMessage = await sendMessage(chatId, textBuilder(1)).catch(() => null);
  const messageId = progressMessage?.message_id;
  if (!messageId) {
    return { complete: async () => {}, remove: async () => {} };
  }

  let percent = 1;
  let stopped = false;
  let editChain = Promise.resolve();
  const queueEdit = (nextPercent) => {
    percent = Math.max(percent, Math.min(99, nextPercent));
    const text = textBuilder(percent);
    editChain = editChain
      .then(() => telegram('editMessageText', { chat_id: chatId, message_id: messageId, text }))
      .catch(() => {});
    return editChain;
  };

  const timer = setInterval(() => {
    if (stopped || percent >= 99) return;
    queueEdit(Math.min(99, percent + (percent < 35 ? 2 : 1)));
  }, 1200);
  timer.unref?.();

  return {
    async complete() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await editChain.catch(() => {});
      await telegram('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: textBuilder(100),
      }).catch(() => {});
    },
    async remove() {
      stopped = true;
      clearInterval(timer);
      await editChain.catch(() => {});
      await telegram('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
    },
  };
}

export function startStatusProgress(chatId) {
  return startProgress(chatId, statusProgressText);
}

export async function startHeavyStatusProgress(chatId) {
  return sendMessage(chatId, statusProgressText(1)).catch(() => null);
}

export async function startHeavyLiveProgress(chatId) {
  return sendMessage(chatId, liveProgressText(1)).catch(() => null);
}

export async function removeHeavyProgress(chatId, messageId) {
  if (!chatId || !messageId) return;
  await telegram('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
}
