import { readFile, writeFile } from 'node:fs/promises';

async function patchStatusHq() {
  const filePath = 'src/status-hq.js';
  let source = await readFile(filePath, 'utf8');
  let changed = false;

  if (!source.includes('STATUS_FFMPEG_THREADS')) {
    const needle = '    threads: 0,\n';
    if (!source.includes(needle)) throw new Error('Status HQ threads marker not found');
    source = source.replace(
      needle,
      "    threads: Math.max(1, Math.min(2, Number(process.env.STATUS_FFMPEG_THREADS || 2))),\n    filterThreads: Math.max(1, Math.min(2, Number(process.env.STATUS_FILTER_THREADS || 1))),\n",
    );
    changed = true;
  }

  if (!source.includes("'-filter_threads', String(plan.filterThreads ?? 1)")) {
    const needle = "    '-nostdin',\n    '-i', inputPath,\n";
    if (!source.includes(needle)) throw new Error('Status HQ ffmpeg input marker not found');
    source = source.replace(
      needle,
      "    '-nostdin',\n    '-filter_threads', String(plan.filterThreads ?? 1),\n    '-i', inputPath,\n",
    );
    changed = true;
  }

  if (!source.includes('Status HQ ffmpeg failed:')) {
    const needle = `  await execFileAsync(\n    ffmpegPath,\n    args,\n    commandOptions(Number(process.env.STATUS_ENCODE_TIMEOUT_MS || 260000)),\n  );\n`;
    if (!source.includes(needle)) throw new Error('Status HQ ffmpeg execution marker not found');
    source = source.replace(
      needle,
      `  try {\n    await execFileAsync(\n      ffmpegPath,\n      args,\n      commandOptions(Number(process.env.STATUS_ENCODE_TIMEOUT_MS || 260000)),\n    );\n  } catch (error) {\n    console.error('Status HQ ffmpeg failed:', {\n      code: error?.code ?? null,\n      signal: error?.signal ?? null,\n      killed: Boolean(error?.killed),\n      stderr: String(error?.stderr || '').slice(-4000),\n    });\n    throw error;\n  }\n`,
    );
    changed = true;
  }

  if (changed) await writeFile(filePath, source);
  return changed;
}

async function patchMediaRelay() {
  const filePath = 'api/media.js';
  let source = await readFile(filePath, 'utf8');
  let changed = false;

  if (!source.includes('MEDIA_RELAY_HEADER_TIMEOUT_MS')) {
    const marker = '  let upstream;\n  try {\n    upstream = await fetch(verified.url, {\n';
    if (!source.includes(marker)) throw new Error('Media relay fetch marker not found');
    source = source.replace(
      marker,
      "  const relayController = new AbortController();\n  const relayHeaderTimeoutMs = Math.max(5000, Number(process.env.MEDIA_RELAY_HEADER_TIMEOUT_MS || 30000));\n  const relayTimer = setTimeout(() => relayController.abort(), relayHeaderTimeoutMs);\n\n  let upstream;\n  try {\n    upstream = await fetch(verified.url, {\n",
    );

    const signalNeedle = '      signal: AbortSignal.timeout(45000),\n';
    if (!source.includes(signalNeedle)) throw new Error('Media relay timeout marker not found');
    source = source.replace(signalNeedle, '      signal: relayController.signal,\n');

    const finishNeedle = "    });\n  } catch (error) {\n    console.error('Media relay fetch failed:', error?.message);\n";
    if (!source.includes(finishNeedle)) throw new Error('Media relay completion marker not found');
    source = source.replace(
      finishNeedle,
      "    });\n    clearTimeout(relayTimer);\n  } catch (error) {\n    clearTimeout(relayTimer);\n    console.error('Media relay fetch failed:', error?.message);\n",
    );
    changed = true;
  }

  if (changed) await writeFile(filePath, source);
  return changed;
}

const statusChanged = await patchStatusHq();
const relayChanged = await patchMediaRelay();
console.log(`Applied Railway FFmpeg/relay safety patch (status=${statusChanged ? 'changed' : 'ok'}, relay=${relayChanged ? 'changed' : 'ok'})`);
