import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from telethon import TelegramClient
from telethon.sessions import MemorySession

MB = 1024 * 1024
MAX_INPUT_MB = 250


def required_env(name: str) -> str:
    value = str(os.environ.get(name, '')).strip()
    if not value:
        raise RuntimeError(f'Missing required environment variable: {name}')
    return value


def progress_text(percent: int) -> str:
    value = max(1, min(100, int(percent)))
    filled = 10 if value >= 100 else min(9, value // 10)
    return f"🔋 Status HQ sedang diproses...\n{'▰' * filled}{'▱' * (10 - filled)} {value}%"


def run(cmd, *, capture=False):
    kwargs = {'check': True}
    if capture:
        kwargs.update({'stdout': subprocess.PIPE, 'stderr': subprocess.PIPE, 'text': True})
    return subprocess.run(cmd, **kwargs)


def probe(path: Path) -> dict:
    result = run([
        'ffprobe', '-v', 'error', '-print_format', 'json',
        '-show_streams', '-show_format', str(path)
    ], capture=True)
    data = json.loads(result.stdout or '{}')
    streams = data.get('streams') or []
    video = next((s for s in streams if s.get('codec_type') == 'video'), None)
    audio = next((s for s in streams if s.get('codec_type') == 'audio'), None)
    if not video:
        raise RuntimeError('Video stream not found in uploaded media.')
    return {
        'video': video,
        'audio': audio,
        'format': data.get('format') or {},
    }


def dimensions_are_status_safe(width: int, height: int) -> bool:
    if not width or not height:
        return False
    if abs(width - height) / max(width, height) < 0.08:
        return width <= 1080 and height <= 1080
    if width > height:
        return width <= 1920 and height <= 1080
    return width <= 1080 and height <= 1920


def can_losslessly_remux(info: dict) -> bool:
    video = info['video']
    audio = info['audio']
    width = int(video.get('width') or 0)
    height = int(video.get('height') or 0)
    video_ok = str(video.get('codec_name') or '').lower() == 'h264'
    pixel_ok = str(video.get('pix_fmt') or '').lower() in {'yuv420p', 'yuvj420p'}
    audio_ok = audio is None or str(audio.get('codec_name') or '').lower() == 'aac'
    return video_ok and pixel_ok and audio_ok and dimensions_are_status_safe(width, height)


def prepare_status_video(source: Path, output: Path) -> str:
    info = probe(source)

    if can_losslessly_remux(info):
        # Preserve image/audio bits exactly when the source is already WhatsApp-friendly.
        run([
            'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-i', str(source), '-map', '0:v:0', '-map', '0:a:0?',
            '-c', 'copy', '-movflags', '+faststart', str(output)
        ])
        return 'lossless-remux'

    # Compatibility conversion only: no sharpen, denoise, AI enhancement or upscaling.
    # Large sources are reduced to a 1080p-class envelope while smaller sources stay small.
    scale = (
        "scale=w='if(gte(iw,ih),min(iw,1920),min(iw,1080))':"
        "h='if(gte(iw,ih),min(ih,1080),min(ih,1920))':"
        "force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,setsar=1"
    )
    run([
        'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-i', str(source),
        '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', scale,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-pix_fmt', 'yuv420p', '-profile:v', 'high',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
        '-movflags', '+faststart', '-map_metadata', '-1',
        str(output)
    ])
    return 'compatibility-transcode'


async def main():
    api_id = int(required_env('TELEGRAM_API_ID'))
    api_hash = required_env('TELEGRAM_API_HASH')
    bot_token = required_env('TELEGRAM_BOT_TOKEN')
    chat_id = int(required_env('HEAVY_CHAT_ID'))
    message_id = int(required_env('HEAVY_MESSAGE_ID'))
    progress_message_id = int(os.environ.get('HEAVY_PROGRESS_MESSAGE_ID') or 0)
    declared_size = int(os.environ.get('HEAVY_FILE_SIZE') or 0)
    max_bytes = MAX_INPUT_MB * MB

    if declared_size > max_bytes:
        raise RuntimeError(f'Video exceeds {MAX_INPUT_MB} MB heavy-worker limit.')

    client = TelegramClient(MemorySession(), api_id, api_hash)
    await client.start(bot_token=bot_token)

    peer = None
    temp_dir = Path(tempfile.mkdtemp(prefix='abangrender-heavy-status-'))
    source = temp_dir / 'source-video.mp4'
    output = temp_dir / 'status-hq.mp4'

    async def set_progress(percent: int):
        if not peer or progress_message_id <= 0:
            return
        try:
            await client.edit_message(peer, progress_message_id, progress_text(percent))
        except Exception as exc:
            print(f'progress edit ignored: {exc}', file=sys.stderr)

    try:
        # A fresh runner has no saved Telegram entity/session cache. Telethon supports
        # entity=None when fetching a known message ID, which is ideal for this worker.
        message = await client.get_messages(None, ids=message_id)
        if not message:
            raise RuntimeError(f'Telegram message {message_id} could not be recovered through MTProto.')

        peer = await message.get_input_chat()
        if not peer:
            raise RuntimeError(f'Telegram peer for chat {chat_id} could not be resolved.')
        await set_progress(8)

        downloaded = await client.download_media(message, file=str(source))
        if not downloaded:
            raise RuntimeError('MTProto media download returned no file.')
        source = Path(downloaded)
        actual_size = source.stat().st_size
        if actual_size > max_bytes:
            raise RuntimeError(f'Video is {actual_size / MB:.1f} MB; current limit is {MAX_INPUT_MB} MB.')

        await set_progress(40)
        mode = await asyncio.to_thread(prepare_status_video, source, output)
        if not output.exists() or output.stat().st_size <= 0:
            raise RuntimeError('FFmpeg completed without a Status HQ output.')

        print(json.dumps({
            'source_bytes': actual_size,
            'output_bytes': output.stat().st_size,
            'mode': mode,
        }))

        await set_progress(82)
        await client.send_file(
            peer,
            str(output),
            caption='Video ni dah ready untuk upload ke status ✅',
            supports_streaming=True,
            force_document=False,
        )
        await set_progress(100)
        if progress_message_id > 0:
            try:
                await client.delete_messages(peer, [progress_message_id], revoke=True)
            except Exception as exc:
                print(f'progress cleanup ignored: {exc}', file=sys.stderr)
    except Exception as exc:
        print(f'heavy Status HQ failed: {exc}', file=sys.stderr)
        if peer and progress_message_id > 0:
            try:
                await client.edit_message(
                    peer,
                    progress_message_id,
                    '❌ Status HQ tak dapat disiapkan untuk video ini. Cuba hantar video semula.'
                )
            except Exception:
                pass
        raise
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
        await client.disconnect()


if __name__ == '__main__':
    asyncio.run(main())
