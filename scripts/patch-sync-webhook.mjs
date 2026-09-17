import { readFile, writeFile } from 'node:fs/promises';

const apiFile = new URL('../api/telegram.js', import.meta.url);
let source = await readFile(apiFile, 'utf8');

function replaceRequired(from, to, label) {
  if (source.includes(to)) return;
  if (!source.includes(from)) throw new Error(`patch-sync-webhook: marker not found: ${label}`);
  source = source.replace(from, to);
}

source = source.replace("import { waitUntil } from '@vercel/functions';\n", '');
source = source.replace("recovery: 'fast-ack-v1'", "recovery: 'sync-recovery-v2'");

replaceRequired(
`      waitUntil(sendMessage(
        message.chat.id,
        commandMenuText(userId),
      ).catch((error) => console.warn('Menu reply failed:', error?.message)));
      return json(res, 200, { ok: true, menu: isResetAdmin(userId) ? 'owner' : 'user' });`,
`      await sendMessage(
        message.chat.id,
        commandMenuText(userId),
      ).catch((error) => console.warn('Menu reply failed:', error?.message));
      return json(res, 200, { ok: true, menu: isResetAdmin(userId) ? 'owner' : 'user' });`,
'menu synchronous reply',
);

replaceRequired(
`      waitUntil(sendMessage(
        message.chat.id,
        '♻️ Sesi anda telah direset.\\nSemua proses lama untuk sesi ini dibatalkan. Bot kembali normal.\\nSila hantar link atau video semula.',
      ).catch((error) => console.warn('User reset reply failed:', error?.message)));
      return json(res, 200, { ok: true, reset: 'user' });`,
`      await sendMessage(
        message.chat.id,
        '♻️ Sesi anda telah direset.\\nSemua proses lama untuk sesi ini dibatalkan. Bot kembali normal.\\nSila hantar link atau video semula.',
      ).catch((error) => console.warn('User reset reply failed:', error?.message));
      return json(res, 200, { ok: true, reset: 'user' });`,
'user reset synchronous reply',
);

replaceRequired(
`        waitUntil(sendMessage(message.chat.id, '❌ /resetadmin hanya untuk owner bot.').catch(() => {}));
        return json(res, 200, { ok: true, reset: false, reason: 'not_owner' });`,
`        await sendMessage(message.chat.id, '❌ /resetadmin hanya untuk owner bot.').catch(() => {});
        return json(res, 200, { ok: true, reset: false, reason: 'not_owner' });`,
'admin denial synchronous reply',
);

replaceRequired(
`      resetGlobalFence(update);
      waitUntil((async () => {
        await setMirrorWebhook(context.baseUrl, context.mirrorGroupId, true);
        await sendMessage(
          message.chat.id,
          '♻️ ADMIN RESET selesai.\\nPending update lama dibuang dan semua proses lama ditandakan batal. Bot kembali ke keadaan bersih.',
        );
      })().catch(async (error) => {
        console.error('Admin reset failed:', error?.message);
        await sendMessage(message.chat.id, '❌ Admin reset tak dapat disiapkan sepenuhnya. Cuba sekali lagi.').catch(() => {});
      }));
      return json(res, 200, { ok: true, reset: 'admin' });`,
`      resetGlobalFence(update);
      try {
        await setMirrorWebhook(context.baseUrl, context.mirrorGroupId, true);
        await sendMessage(
          message.chat.id,
          '♻️ ADMIN RESET selesai.\\nPending update lama dibuang dan semua proses lama ditandakan batal. Bot kembali ke keadaan bersih.',
        );
      } catch (error) {
        console.error('Admin reset failed:', error?.message);
        await sendMessage(message.chat.id, '❌ Admin reset tak dapat disiapkan sepenuhnya. Cuba sekali lagi.').catch(() => {});
      }
      return json(res, 200, { ok: true, reset: 'admin' });`,
'admin reset synchronous execution',
);

replaceRequired(
`    context.fence = captureJobFence(update);
    waitUntil(runWebhookUpdate(update, context).catch((error) => {
      console.error('Background webhook processing failed:', error);
    }));

    // ACK Telegram immediately. Heavy download/compression continues in the
    // Vercel background lifetime so Telegram has no reason to replay the update.
    return json(res, 200, { ok: true, accepted: true });`,
`    context.fence = captureJobFence(update);
    await runWebhookUpdate(update, context);
    return json(res, 200, { ok: true, accepted: true });`,
'synchronous webhook execution',
);

if (source.includes('waitUntil(')) {
  throw new Error('patch-sync-webhook: waitUntil call remains in final runtime');
}

await writeFile(apiFile, source);
console.log('Restored synchronous webhook execution while keeping scoped reset/menu/rescue protections');
