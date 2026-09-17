import { readFile, writeFile } from 'node:fs/promises';

const apiFile = new URL('../api/telegram.js', import.meta.url);
let source = await readFile(apiFile, 'utf8');

function mustReplace(from, to, label) {
  if (source.includes(to)) return;
  if (!source.includes(from)) throw new Error(`patch-recovery: marker not found: ${label}`);
  source = source.replace(from, to);
}

if (!source.includes("from '@vercel/functions'")) {
  source = `import { waitUntil } from '@vercel/functions';\n${source}`;
}

if (!source.includes("../src/recovery.js")) {
  const marker = "import { createRelayUrl } from '../src/relay.js';";
  const insertion = `${marker}\nimport {\n  beginUpdate,\n  captureJobFence,\n  isJobFenceActive,\n  isResetAdmin,\n  resetGlobalFence,\n  resetUserFence,\n} from '../src/recovery.js';\nimport { prepareTikTokTelegramRescue } from '../src/tiktok-rescue.js';`;
  mustReplace(marker, insertion, 'recovery imports');
}

mustReplace(
  "async function setMirrorWebhook(baseUrl, mirrorGroupId = '') {",
  "async function setMirrorWebhook(baseUrl, mirrorGroupId = '', dropPendingUpdates = false) {",
  'setMirrorWebhook signature',
);

mustReplace(
  '    drop_pending_updates: false,',
  '    drop_pending_updates: Boolean(dropPendingUpdates),',
  'setMirrorWebhook pending mode',
);

mustReplace(
  'async function processStatusFromLink(chatId, url, platform) {',
  'async function processStatusFromLink(chatId, url, platform, jobFence = null) {',
  'status link fence signature',
);

mustReplace(
  "    prepared = await prepareStatusFromSourceUrl(url, platform);\n    await progress.complete();",
  "    prepared = await prepareStatusFromSourceUrl(url, platform);\n    if (jobFence && !isJobFenceActive(jobFence)) {\n      await progress.remove();\n      return;\n    }\n    await progress.complete();",
  'status link fence check',
);

mustReplace(
  "async function processStandardDownload(chatId, url, platform, baseUrl, mirrorGroupId = '', from = {}, sourceMessage = null) {",
  "async function processStandardDownload(chatId, url, platform, baseUrl, mirrorGroupId = '', from = {}, sourceMessage = null, jobFence = null) {",
  'standard download fence signature',
);

mustReplace(
  "  const title = safeTitle(media, platform);\n  const candidates = orderedVideoCandidates(media.videos || []);",
  "  if (jobFence && !isJobFenceActive(jobFence)) return;\n\n  const title = safeTitle(media, platform);\n  const candidates = orderedVideoCandidates(media.videos || []);",
  'post-resolve fence check',
);

mustReplace(
  "    for (const candidate of candidates.slice(0, 6)) {\n      sentVideo = await deliverVideo(chatId, candidate, title, baseUrl, {",
  "    for (const candidate of candidates.slice(0, 6)) {\n      if (jobFence && !isJobFenceActive(jobFence)) return;\n      sentVideo = await deliverVideo(chatId, candidate, title, baseUrl, {",
  'candidate fence check',
);

const fallbackMarker = `    if (!sentVideo) {\n      const best = chooseBestVideo(media.videos);\n      if (best) {\n        await sendDownloadButton(\n          chatId,\n          \`\${title}\\n\\nBot dah cuba direct URL, relay, server upload dan HQ compression tetapi fail ini masih tidak dapat dihantar melalui Telegram cloud.\`,\n          best.url,\n          \`⬇️ Download \${best.quality || 'video'}\`,\n        );\n      }\n    }`;

const rescueBlock = `    if (!sentVideo && platform === 'tiktok' && (!jobFence || isJobFenceActive(jobFence))) {\n      let rescued = null;\n      try {\n        rescued = await prepareTikTokTelegramRescue(url, configuredUploadLimit());\n        if (!jobFence || isJobFenceActive(jobFence)) {\n          sentVideo = await sendVideoFileUpload(\n            chatId,\n            rescued.filePath,\n            '',\n            mediaActionButtons(url),\n          );\n        }\n      } catch (error) {\n        console.warn('TikTok original-link rescue failed:', error?.code, error?.message);\n      } finally {\n        if (rescued?.cleanup) await rescued.cleanup().catch(() => {});\n      }\n    }\n\n    if (!sentVideo && (!jobFence || isJobFenceActive(jobFence))) {\n      const best = chooseBestVideo(media.videos);\n      if (best) {\n        await sendDownloadButton(\n          chatId,\n          \`\${title}\\n\\nBot dah cuba direct URL, relay, server upload dan HQ compression tetapi fail ini masih tidak dapat dihantar melalui Telegram cloud.\`,\n          best.url,\n          \`⬇️ Download \${best.quality || 'video'}\`,\n        );\n      }\n    }`;

mustReplace(fallbackMarker, rescueBlock, 'TikTok rescue block');

mustReplace(
  "  if (sentVideo) {\n    await mirrorVideoToGroup(chatId, sentVideo, mirrorGroupId, from, {",
  "  if (jobFence && !isJobFenceActive(jobFence)) return;\n\n  if (sentVideo) {\n    await mirrorVideoToGroup(chatId, sentVideo, mirrorGroupId, from, {",
  'pre-output fence check',
);

mustReplace(
  '    await processStatusFromLink(chatId, url, platform);',
  '    await processStatusFromLink(chatId, url, platform, context.fence);',
  'status call fence',
);

mustReplace(
  '  await processStandardDownload(chatId, url, platform, context.baseUrl, context.mirrorGroupId, message.from, message);',
  '  await processStandardDownload(chatId, url, platform, context.baseUrl, context.mirrorGroupId, message.from, message, context.fence);',
  'standard call fence',
);

const handlerStart = source.indexOf('export default async function handler(req, res) {');
if (handlerStart < 0) throw new Error('patch-recovery: webhook handler marker not found');

const handler = `async function runWebhookUpdate(update, context) {\n  const callbackQuery = update?.callback_query;\n  if (callbackQuery) {\n    if (await processAuditDelete(callbackQuery)) return;\n    if (await processStatusButton(callbackQuery)) return;\n    if (await processLiveWallpaperButton(callbackQuery, context.baseUrl)) return;\n    await processTikTokSlideshowChoice(callbackQuery, context.baseUrl, context.mirrorGroupId);\n    return;\n  }\n\n  const message = update?.message ?? update?.edited_message;\n  if (message) await processMessage(message, context);\n}\n\nexport default async function handler(req, res) {\n  if (req.method === 'GET') {\n    return json(res, 200, {\n      ok: true,\n      service: 'telegram-social-downloader',\n      endpoint: 'webhook',\n      mirror_connected: Boolean(mirrorGroupFromRequest(req)),\n      recovery: 'fast-ack-v1',\n    });\n  }\n\n  if (req.method !== 'POST') {\n    res.setHeader('Allow', 'GET, POST');\n    return json(res, 405, { ok: false, error: 'method_not_allowed' });\n  }\n\n  if (!isAuthorizedWebhook(req)) {\n    return json(res, 401, { ok: false, error: 'invalid_webhook_secret' });\n  }\n\n  try {\n    const update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;\n    const decision = beginUpdate(update);\n    if (!decision.accept) {\n      return json(res, 200, { ok: true, ignored: decision.reason });\n    }\n\n    const context = {\n      baseUrl: requestBaseUrl(req),\n      mirrorGroupId: mirrorGroupFromRequest(req),\n    };\n\n    const message = update?.message ?? update?.edited_message;\n    const text = String(message?.text || message?.caption || '').trim();\n    const token = text.split(/\\s+/)[0]?.toLowerCase() || '';\n    const command = token.split('@')[0];\n\n    if (command === '/reset') {\n      resetUserFence(update);\n      waitUntil(sendMessage(\n        message.chat.id,\n        '♻️ Sesi anda telah direset.\\nSemua proses lama untuk sesi ini dibatalkan. Bot kembali normal.\\nSila hantar link atau video semula.',\n      ).catch((error) => console.warn('User reset reply failed:', error?.message)));\n      return json(res, 200, { ok: true, reset: 'user' });\n    }\n\n    if (command === '/resetadmin') {\n      const userId = message?.from?.id;\n      if (!isResetAdmin(userId)) {\n        waitUntil(sendMessage(message.chat.id, '❌ /resetadmin hanya untuk owner bot.').catch(() => {}));\n        return json(res, 200, { ok: true, reset: false, reason: 'not_owner' });\n      }\n\n      resetGlobalFence(update);\n      waitUntil((async () => {\n        await setMirrorWebhook(context.baseUrl, context.mirrorGroupId, true);\n        await sendMessage(\n          message.chat.id,\n          '♻️ ADMIN RESET selesai.\\nPending update lama dibuang dan semua proses lama ditandakan batal. Bot kembali ke keadaan bersih.',\n        );\n      })().catch(async (error) => {\n        console.error('Admin reset failed:', error?.message);\n        await sendMessage(message.chat.id, '❌ Admin reset tak dapat disiapkan sepenuhnya. Cuba sekali lagi.').catch(() => {});\n      }));\n      return json(res, 200, { ok: true, reset: 'admin' });\n    }\n\n    context.fence = captureJobFence(update);\n    waitUntil(runWebhookUpdate(update, context).catch((error) => {\n      console.error('Background webhook processing failed:', error);\n    }));\n\n    // ACK Telegram immediately. Heavy download/compression continues in the\n    // Vercel background lifetime so Telegram has no reason to replay the update.\n    return json(res, 200, { ok: true, accepted: true });\n  } catch (error) {\n    console.error('Webhook error:', error);\n    return json(res, 200, { ok: false, handled: true });\n  }\n}\n`;

source = `${source.slice(0, handlerStart)}${handler}`;
await writeFile(apiFile, source);
console.log('Applied fast ACK, scoped reset and TikTok rescue patches');
