import { sendMessage, telegram } from '../telegram.js';

function videoProgressText(percent) {
  const value = Math.max(1, Math.min(100, Math.round(Number(percent) || 1)));
  const filled = value >= 100 ? 10 : Math.min(9, Math.floor(value / 10));
  const bar = `${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}`;
  const title = value >= 100 ? 'Your Video Is Ready ✅' : 'Your Video Is on Its Way...';
  return `${title}\n\n${bar} ${value}% 🔋`;
}

function imageProgressText(percent) {
  const value = Math.max(1, Math.min(100, Math.round(Number(percent) || 1)));
  const filled = value >= 100 ? 10 : Math.min(9, Math.floor(value / 10));
  const bar = `${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}`;
  return `📱 Status HQ sedang diproses...\n${bar} ${value}%`;
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

  // Telegram can throttle rapid message edits. The old 1.2s cadence commonly
  // froze visually around 40% even while FFmpeg was still working. Keep the
  // animation smooth but sparse enough to avoid edit-rate throttling.
  const timer = setInterval(() => {
    if (stopped || percent >= 99) return;
    const step = percent < 35 ? 4 : percent < 75 ? 2 : 1;
    queueEdit(Math.min(99, percent + step));
  }, 5000);
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
  return startProgress(chatId, videoProgressText);
}

export function startImageStatusProgress(chatId) {
  return startProgress(chatId, imageProgressText);
}

export async function startHeavyStatusProgress(chatId) {
  return sendMessage(chatId, videoProgressText(1)).catch(() => null);
}

export async function startHeavyLiveProgress(chatId) {
  return sendMessage(chatId, videoProgressText(1)).catch(() => null);
}

export async function removeHeavyProgress(chatId, messageId) {
  if (!chatId || !messageId) return;
  await telegram('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
}
