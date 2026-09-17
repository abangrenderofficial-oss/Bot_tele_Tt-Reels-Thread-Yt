import { readFile, writeFile } from 'node:fs/promises';

const apiFile = new URL('../api/telegram.js', import.meta.url);
let source = await readFile(apiFile, 'utf8');

const menuFunction = `function commandMenuText(userId) {\n  const lines = [\n    '📋 Command Menu',\n    '',\n    '/start — Info bot',\n    '/help — Bantuan ringkas',\n    '/menu — Senarai command',\n    '/status <link> — Buat Status HQ dari link',\n    '/reset — Reset sesi sendiri jika bot tersangkut',\n  ];\n\n  if (isResetAdmin(userId)) {\n    lines.push(\n      '',\n      '👑 Owner',\n      '/resetadmin — Reset & recovery semua user',\n      '/connect — Sambung group pemantauan',\n      '/disconnect — Putus group pemantauan',\n    );\n  }\n\n  return lines.join('\\\\n');\n}\n\n`;

if (!source.includes('function commandMenuText(userId) {')) {
  const marker = 'async function runWebhookUpdate(update, context) {';
  if (!source.includes(marker)) throw new Error('patch-menu: runWebhookUpdate marker not found');
  source = source.replace(marker, `${menuFunction}${marker}`);
}

if (!source.includes("command === '/menu'")) {
  const marker = `    if (command === '/reset') {`;
  const block = `    if (command === '/menu') {\n      const userId = message?.from?.id;\n      waitUntil(sendMessage(\n        message.chat.id,\n        commandMenuText(userId),\n      ).catch((error) => console.warn('Menu reply failed:', error?.message)));\n      return json(res, 200, { ok: true, menu: isResetAdmin(userId) ? 'owner' : 'user' });\n    }\n\n`;
  if (!source.includes(marker)) throw new Error('patch-menu: reset command marker not found');
  source = source.replace(marker, `${block}${marker}`);
}

await writeFile(apiFile, source);
console.log('Applied owner-aware /menu command patch');
