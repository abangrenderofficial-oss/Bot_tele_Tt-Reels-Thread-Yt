import json
import math
import os
import subprocess
import tempfile
from pathlib import Path

import requests
from pyrogram import Client

MB = 1024 * 1024
BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN', '').strip()
API_ID = int(os.environ.get('TELEGRAM_API_ID', '0') or 0)
API_HASH = os.environ.get('TELEGRAM_API_HASH', '').strip()
CHAT_ID = int(os.environ.get('HEAVY_CHAT_ID', '0') or 0)
VIDEO_FILE_ID = os.environ.get('HEAVY_VIDEO_FILE_ID', '').strip()
FILE_SIZE = int(os.environ.get('HEAVY_FILE_SIZE', '0') or 0)
PROGRESS_MESSAGE_ID = int(os.environ.get('HEAVY_PROGRESS_MESSAGE_ID', '0') or 0)
SOURCE_MESSAGE_ID = int(os.environ.get('HEAVY_SOURCE_MESSAGE_ID', '0') or 0)
MAX_INPUT_MB = int(os.environ.get('HEAVY_VIDEO_MAX_MB', '500') or 500)
MAX_INPUT_BYTES = MAX_INPUT_MB * MB
BOT_API_BASE = os.environ.get('TELEGRAM_API_BASE_URL', 'https://api.telegram.org').rstrip('/')
MAX_PREVIEW_SECONDS = 9.8
MIN_PREVIEW_SECONDS = 1.0
OUTPUT_FPS = 30

try:
    SPEED = float(os.environ.get('HEAVY_SPEED', '1') or 1)
except ValueError:
    SPEED = 1.0
SPEED = max(0.5, min(2.0, SPEED))


def require_config():
    missing = []
    if not BOT_TOKEN:
        missing.append('TELEGRAM_BOT_TOKEN')
    if not API_ID:
        missing.append('TELEGRAM_API_ID')
    if not API_HASH:
        missing.append('TELEGRAM_API_HASH')
    if not CHAT_ID:
        missing.append('HEAVY_CHAT_ID')
    if not VIDEO_FILE_ID:
        missing.append('HEAVY_VIDEO_FILE_ID')
    if missing:
        raise RuntimeError('Missing required configuration: ' + ', '.join(missing))
    if FILE_SIZE > MAX_INPUT_BYTES:
        raise RuntimeError(f'Video exceeds {MAX_INPUT_MB}MB preview limit.')


def telegram_call(method, data=None, files=None, timeout=180):
    response = requests.post(
        f'{BOT_API_BASE}/bot{BOT_TOKEN}/{method}',
        data=data or {},
        files=files,
        timeout=timeout,
    )
    try:
        payload = response.json()
    except Exception as exc:
        raise RuntimeError(f'Telegram {method} returned HTTP {response.status_code}') from exc
    if not response.ok or not payload.get('ok'):
        raise RuntimeError(payload.get('description') or f'Telegram {method} failed ({response.status_code})')
    return payload.get('result')


def progress_text(percent):
    value = max(1, min(100, int(round(percent))))
    filled = 10 if value >= 100 else min(9, value // 10)
    bar = '▰' * filled + '▱' * (10 - filled)
    return f'👀 Preview motion sedang dibuat...\n{bar} {value}%'


def set_progress(percent):
    if not PROGRESS_MESSAGE_ID:
        return
    try:
        telegram_call(
            'editMessageText',
            {
                'chat_id': str(CHAT_ID),
                'message_id': str(PROGRESS_MESSAGE_ID),
                'text': progress_text(percent),
            },
            timeout=30,
        )
    except Exception as exc:
        print(f'preview progress update failed: {exc}', flush=True)


def finish_progress():
    if not PROGRESS_MESSAGE_ID:
        return
    try:
        telegram_call(
            'deleteMessage',
            {'chat_id': str(CHAT_ID), 'message_id': str(PROGRESS_MESSAGE_ID)},
            timeout=30,
        )
    except Exception as exc:
        print(f'preview progress delete failed: {exc}', flush=True)


def fail_progress(message):
    text = f'❌ {message}'[:4096]
    if PROGRESS_MESSAGE_ID:
        try:
            telegram_call(
                'editMessageText',
                {'chat_id': str(CHAT_ID), 'message_id': str(PROGRESS_MESSAGE_ID), 'text': text},
                timeout=30,
            )
            return
        except Exception:
            pass
    try:
        telegram_call('sendMessage', {'chat_id': str(CHAT_ID), 'text': text}, timeout=30)
    except Exception:
        pass


def run(cmd, timeout=900):
    print('$ ' + ' '.join(str(x) for x in cmd), flush=True)
    result = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        if result.stderr:
            print(result.stderr[-8000:], flush=True)
        raise RuntimeError(f'Command failed ({result.returncode}): {cmd[0]}')
    return result


def probe_video(path):
    result = run(
        [
            'ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height:format=duration',
            '-of', 'json', str(path),
        ],
        timeout=60,
    )
    payload = json.loads(result.stdout or '{}')
    stream = (payload.get('streams') or [{}])[0]
    duration = float((payload.get('format') or {}).get('duration') or 0)
    width = int(stream.get('width') or 0)
    height = int(stream.get('height') or 0)
    if duration <= 0 or width <= 0 or height <= 0:
        raise RuntimeError('Tak dapat baca metadata video untuk preview motion.')
    return {'duration': duration, 'width': width, 'height': height}


def even_floor(value):
    return max(2, int(math.floor(value / 2.0) * 2))


def preview_filter(probe):
    ratio = probe['width'] / max(1, probe['height'])
    speed_expr = f'(PTS-STARTPTS)/{SPEED:.4f}'
    if ratio > 0.78:
        return (
            'scale=720:1280:force_original_aspect_ratio=increase:flags=lanczos,'
            f'crop=720:1280,setsar=1,setpts={speed_expr},fps={OUTPUT_FPS}'
        )

    scale = min(1.0, 720 / probe['width'], 1280 / probe['height'])
    width = even_floor(probe['width'] * scale)
    height = even_floor(probe['height'] * scale)
    return f'scale={width}:{height}:flags=lanczos,setsar=1,setpts={speed_expr},fps={OUTPUT_FPS}'


def encode_preview(source, output, probe):
    adjusted_duration = probe['duration'] / SPEED
    if adjusted_duration < MIN_PREVIEW_SECONDS:
        raise RuntimeError(
            'Speed yang dipilih jadikan motion kurang 1 saat. Pilih speed yang lebih perlahan.'
        )
    duration = min(adjusted_duration, MAX_PREVIEW_SECONDS)

    run(
        [
            'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
            '-i', str(source),
            '-t', f'{duration:.4f}',
            '-map', '0:v:0', '-an',
            '-vf', preview_filter(probe),
            '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
            '-profile:v', 'high', '-level:v', '4.0',
            '-b:v', '2200k', '-maxrate', '2600k', '-bufsize', '5200k',
            '-movflags', '+faststart', '-map_metadata', '-1',
            str(output),
        ],
        timeout=600,
    )
    if not output.exists() or output.stat().st_size <= 0:
        raise RuntimeError('Preview motion tidak terhasil.')
    return duration


def download_source(path):
    set_progress(5)
    app = Client(
        'live_preview_worker',
        api_id=API_ID,
        api_hash=API_HASH,
        bot_token=BOT_TOKEN,
        in_memory=True,
    )
    with app:
        downloaded = None
        last_error = None
        try:
            downloaded = app.download_media(VIDEO_FILE_ID, file_name=str(path))
        except Exception as exc:
            last_error = exc
            print(f'preview file_id download failed: {exc}', flush=True)

        if not downloaded and SOURCE_MESSAGE_ID:
            try:
                message = app.get_messages(CHAT_ID, SOURCE_MESSAGE_ID)
                downloaded = app.download_media(message, file_name=str(path))
            except Exception as exc:
                last_error = exc
                print(f'preview message fallback failed: {exc}', flush=True)

        if not downloaded:
            raise RuntimeError(f'MTProto tak dapat download video preview. last_error={last_error}')

    if not path.exists() or path.stat().st_size <= 0:
        raise RuntimeError('Video preview download kosong.')
    if path.stat().st_size > MAX_INPUT_BYTES:
        raise RuntimeError(f'Video melebihi limit {MAX_INPUT_MB}MB.')
    set_progress(30)


def send_preview(path, duration):
    speed_label = f'{SPEED:g}×'
    caption = (
        f'👀 Preview Motion • Speed {speed_label}\n'
        f'⏱️ {duration:.1f}s preview\n\n'
        'Kalau motion dah ngam, tekan Create Live Wallpaper pada video asal.'
    )
    with path.open('rb') as handle:
        telegram_call(
            'sendVideo',
            {
                'chat_id': str(CHAT_ID),
                'caption': caption,
                'supports_streaming': 'true',
            },
            {'video': ('live-motion-preview.mp4', handle, 'video/mp4')},
            timeout=300,
        )


def main():
    require_config()
    print(f'live preview speed={SPEED:g} input={FILE_SIZE} chat={CHAT_ID}', flush=True)

    with tempfile.TemporaryDirectory(prefix='abangrender-live-preview-') as temp_dir:
        temp = Path(temp_dir)
        source = temp / 'source-video.bin'
        output = temp / 'motion-preview.mp4'

        download_source(source)
        probe = probe_video(source)
        print(f'preview probe={probe}', flush=True)

        set_progress(48)
        duration = encode_preview(source, output, probe)
        set_progress(88)
        send_preview(output, duration)
        set_progress(100)
        finish_progress()
        print('live preview worker complete', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'live preview worker failed: {type(exc).__name__}: {exc}', flush=True)
        fail_progress(str(exc) if str(exc) else 'Preview motion tak berjaya diproses.')
        raise
