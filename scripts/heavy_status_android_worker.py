import json
import math
import os
import subprocess
import tempfile
from pathlib import Path

import requests
from pyrogram import Client

MB = 1024 * 1024
WHATSAPP_SAFE_MAX_BYTES = int(15.5 * MB)
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
        raise RuntimeError(f'Video exceeds {MAX_INPUT_MB}MB Android Beta limit.')


def telegram_call(method, data=None, files=None, timeout=300):
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
    return f'🤖 Status HQ Android Beta sedang diproses...\n{bar} {value}%'


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
        print(f'progress update failed: {exc}', flush=True)


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
        print(f'progress delete failed: {exc}', flush=True)


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


def run(cmd, timeout=1200):
    print('$ ' + ' '.join(str(x) for x in cmd), flush=True)
    return subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)


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
    streams = payload.get('streams') or []
    stream = streams[0] if streams else {}
    duration = float((payload.get('format') or {}).get('duration') or 0)
    width = int(stream.get('width') or 0)
    height = int(stream.get('height') or 0)
    if duration <= 0:
        raise RuntimeError('Tak dapat baca duration video Android Beta.')
    return {'duration': duration, 'width': width, 'height': height}


def android_plan(probe):
    duration = max(1.0, float(probe.get('duration') or 0))
    audio_kbps = 128
    total_kbps = max(320, int((WHATSAPP_SAFE_MAX_BYTES * 8 / duration / 1000) * 0.94))
    video_kbps = max(180, min(3800, total_kbps - audio_kbps - 80))
    return {'duration': duration, 'audio_kbps': audio_kbps, 'video_kbps': video_kbps}


def android_scale_filter():
    max_w = 'if(gte(iw,ih),1920,1080)'
    max_h = 'if(gte(iw,ih),1080,1920)'
    fit = f'min(1,min(({max_w})/iw,({max_h})/ih))'
    return (
        f"scale=w='max(2,trunc(iw*{fit}/2)*2)':"
        f"h='max(2,trunc(ih*{fit}/2)*2)':flags=lanczos"
    )


def encode_android(input_path, output_path, probe):
    plan = android_plan(probe)
    attempts = ((1.0, 23), (0.84, 24), (0.70, 25))

    for index, (rate_scale, crf) in enumerate(attempts, 1):
        if output_path.exists():
            output_path.unlink()
        maxrate = max(180, int(plan['video_kbps'] * rate_scale))
        bufsize = max(1000, int(maxrate * 1.5))
        filters = [android_scale_filter(), 'setsar=1', 'fps=30']
        cmd = [
            'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-nostats',
            '-filter_threads', '1', '-i', str(input_path),
            '-map', '0:v:0', '-map', '0:a:0?',
            '-vf', ','.join(filters),
            '-c:v', 'libx264', '-preset', 'faster', '-pix_fmt', 'yuv420p',
            '-crf', str(crf), '-maxrate', f'{maxrate}k', '-bufsize', f'{bufsize}k',
            '-profile:v', 'high', '-level:v', '4.0',
            '-g', '250', '-sc_threshold', '0',
            '-color_range', 'tv', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
            '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', f"{plan['audio_kbps']}k",
            '-brand', 'isom', '-movflags', '+faststart', '-metadata:s:v:0', 'rotate=0',
            '-map_metadata', '-1', '-f', 'mp4', '-threads', '2', str(output_path),
        ]
        run(cmd, timeout=1200)
        size = output_path.stat().st_size
        print(f'android beta attempt={index} size={size} maxrate={maxrate}k crf={crf}', flush=True)
        if size <= WHATSAPP_SAFE_MAX_BYTES:
            return

    raise RuntimeError('Output Android Beta masih melebihi 15.5MB WhatsApp-safe limit.')


def send_status_video(path):
    metadata = probe_video(path)
    data = {
        'chat_id': str(CHAT_ID),
        'caption': 'Video Android Beta ni dah ready untuk upload ke status ✅',
        'supports_streaming': 'true',
        'width': str(int(metadata.get('width') or 0)),
        'height': str(int(metadata.get('height') or 0)),
        'duration': str(max(1, int(round(metadata.get('duration') or 1)))),
    }
    with path.open('rb') as handle:
        telegram_call(
            'sendVideo',
            data,
            {'video': ('status-hq-android.mp4', handle, 'video/mp4')},
            timeout=300,
        )


def download_source(path):
    set_progress(5)
    app = Client('heavy_android_beta_worker', api_id=API_ID, api_hash=API_HASH, bot_token=BOT_TOKEN, in_memory=True)
    with app:
        downloaded = app.download_media(VIDEO_FILE_ID, file_name=str(path))
        if not downloaded and SOURCE_MESSAGE_ID:
            try:
                message = app.get_messages(CHAT_ID, SOURCE_MESSAGE_ID)
                downloaded = app.download_media(message, file_name=str(path))
            except Exception as exc:
                print(f'message fallback failed: {exc}', flush=True)
        if not downloaded:
            raise RuntimeError('MTProto tak dapat download video Android Beta ini.')
    if not path.exists() or path.stat().st_size <= 0:
        raise RuntimeError('Video Android Beta download kosong.')
    if path.stat().st_size > MAX_INPUT_BYTES:
        raise RuntimeError(f'Video melebihi limit {MAX_INPUT_MB}MB.')
    set_progress(30)


def main():
    require_config()
    print(f'android beta heavy worker input={FILE_SIZE} chat={CHAT_ID}', flush=True)
    with tempfile.TemporaryDirectory(prefix='abangrender-status-android-') as temp_dir:
        temp = Path(temp_dir)
        source = temp / 'source-video.bin'
        output = temp / 'status-hq-android.mp4'
        download_source(source)
        probe = probe_video(source)
        print(f'probe={probe}', flush=True)
        set_progress(42)
        encode_android(source, output, probe)
        set_progress(88)
        send_status_video(output)
        set_progress(100)
        finish_progress()
        print('android beta heavy worker complete', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'android beta heavy worker failed: {type(exc).__name__}: {exc}', flush=True)
        fail_progress('Android Compatibility Beta tak berjaya. Cuba hantar semula atau guna video yang lebih kecil.')
        raise
