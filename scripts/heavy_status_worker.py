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
ACTION = os.environ.get('HEAVY_ACTION', 'status_hq').strip() or 'status_hq'
PROGRESS_MESSAGE_ID = int(os.environ.get('HEAVY_PROGRESS_MESSAGE_ID', '0') or 0)
SOURCE_MESSAGE_ID = int(os.environ.get('HEAVY_SOURCE_MESSAGE_ID', '0') or 0)
MAX_INPUT_MB = int(os.environ.get('HEAVY_VIDEO_MAX_MB', '250') or 250)
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
        raise RuntimeError(f'Video exceeds {MAX_INPUT_MB}MB heavy-media limit.')


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


def status_caption():
    try:
        me = telegram_call('getMe', timeout=30) or {}
        username = str(me.get('username') or '').strip().lstrip('@')
        if username:
            return f'Video Ready For Status ✅\nDownload In @{username}'
    except Exception as exc:
        print(f'bot username lookup failed: {exc}', flush=True)
    return 'Video Ready For Status ✅'


def progress_text(percent):
    value = max(1, min(100, int(round(percent))))
    filled = 10 if value >= 100 else min(9, value // 10)
    bar = '▰' * filled + '▱' * (10 - filled)
    if ACTION == 'live_wallpaper':
        title = '🍎 Live Wallpaper sedang diproses...'
    elif ACTION == 'status_hq_android':
        title = '🤖 Status HQ Android Beta sedang diproses...'
    else:
        title = '🔋 Status HQ sedang diproses...'
    return f'{title}\n{bar} {value}%'


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


def run(cmd, timeout=900):
    print('$ ' + ' '.join(str(x) for x in cmd), flush=True)
    return subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)


def probe_video(path):
    result = run(
        [
            'ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height,r_frame_rate:format=duration',
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
        raise RuntimeError('Tak dapat baca duration video.')
    return {'duration': duration, 'width': width, 'height': height}


def even_floor(value):
    return max(2, int(math.floor(value / 2.0) * 2))


def target_dimensions(width, height, video_kbps, live=False):
    if not width or not height:
        return None
    if live:
        max_w, max_h = ((1920, 1080) if width > height else (1080, 1920))
    else:
        if video_kbps >= 2400:
            tier = 1080
        elif video_kbps >= 1050:
            tier = 720
        elif video_kbps >= 650:
            tier = 540
        else:
            tier = 360
        if abs(width - height) / max(width, height) < 0.08:
            max_w, max_h = tier, tier
        elif width > height:
            max_w, max_h = {1080: (1920, 1080), 720: (1280, 720), 540: (960, 540), 360: (640, 360)}[tier]
        else:
            max_w, max_h = {1080: (1080, 1920), 720: (720, 1280), 540: (540, 960), 360: (360, 640)}[tier]
    scale = min(1.0, max_w / width, max_h / height)
    return even_floor(width * scale), even_floor(height * scale)


def status_tier(video_kbps, android=False):
    if android:
        return 720
    if video_kbps >= 2400:
        return 1080
    if video_kbps >= 1050:
        return 720
    if video_kbps >= 650:
        return 540
    return 360


def status_plan(probe, android=False):
    duration = max(1.0, probe['duration'])
    target_bytes = int(43.5 * MB)
    audio_kbps = 128
    total_kbps = int((target_bytes * 8 / duration / 1000) * 0.90)
    max_video_kbps = 2800 if android else 5000
    video_kbps = max(220, min(max_video_kbps, total_kbps - audio_kbps - 70))
    return {
        'video_kbps': video_kbps,
        'audio_kbps': audio_kbps,
        'tier': status_tier(video_kbps, android=android),
        'android': android,
    }


def status_scale_filter(tier, android=False):
    if android:
        landscape_w, landscape_h = 1280, 720
        portrait_w, portrait_h = 720, 1280
    elif tier == 1080:
        landscape_w, landscape_h = 1920, 1080
        portrait_w, portrait_h = 1080, 1920
    elif tier == 720:
        landscape_w, landscape_h = 1280, 720
        portrait_w, portrait_h = 720, 1280
    elif tier == 540:
        landscape_w, landscape_h = 960, 540
        portrait_w, portrait_h = 540, 960
    else:
        landscape_w, landscape_h = 640, 360
        portrait_w, portrait_h = 360, 640

    max_w = f'if(gte(iw,ih),{landscape_w},{portrait_w})'
    max_h = f'if(gte(iw,ih),{landscape_h},{portrait_h})'
    fit = f'min(1,min(({max_w})/iw,({max_h})/ih))'
    return (
        f"scale=w='max(2,trunc(iw*{fit}/2)*2)':"
        f"h='max(2,trunc(ih*{fit}/2)*2)':flags=lanczos"
    )


def encode_status(input_path, output_path, probe, android=False):
    plan = status_plan(probe, android=android)
    safe_limit = int(47 * MB)
    for index, bitrate_scale in enumerate((1.0, 0.84, 0.70), 1):
        if output_path.exists():
            output_path.unlink()
        video_kbps = max(180, int(plan['video_kbps'] * bitrate_scale))
        maxrate = max(video_kbps, int(video_kbps * (1.12 if android else 1.15)))
        bufsize = max(1000, maxrate * 2)
        cmd = [
            'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-filter_threads', '1', '-i', str(input_path), '-map', '0:v:0', '-map', '0:a:0?'
        ]
        filters = [status_scale_filter(plan['tier'], android=android), 'setsar=1']
        if android:
            filters.append('fps=30')
        cmd += ['-vf', ','.join(filters)]
        cmd += [
            '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
            '-b:v', f'{video_kbps}k', '-maxrate', f'{maxrate}k', '-bufsize', f'{bufsize}k',
            '-profile:v', 'high', '-level:v', '3.1' if android else '4.1',
        ]
        if android:
            cmd += ['-g', '60', '-keyint_min', '60', '-sc_threshold', '0']
        cmd += [
            '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', f"{plan['audio_kbps']}k",
            '-movflags', '+faststart', '-metadata:s:v:0', 'rotate=0', '-map_metadata', '-1',
            '-threads', '2', str(output_path),
        ]
        run(cmd, timeout=1200)
        if output_path.stat().st_size <= safe_limit:
            return
        print(f'status attempt {index} too large: {output_path.stat().st_size} bytes', flush=True)
    raise RuntimeError('Output Status HQ masih melebihi had Telegram 50MB.')


def encode_live_wallpaper(input_path, video_path, photo_path, probe):
    duration = min(10.0, max(1.0, probe['duration']))
    target_bytes = 8.5 * MB
    audio_kbps = 96
    total_kbps = int((target_bytes * 8 / duration / 1000) * 0.90)
    video_kbps = max(700, min(6000, total_kbps - audio_kbps - 80))
    dims = target_dimensions(probe['width'], probe['height'], video_kbps, live=True)
    filters = []
    if dims:
        filters.append(f'scale={dims[0]}:{dims[1]}:flags=lanczos')
    filters.extend(['setsar=1', 'fps=30'])
    run(
        [
            'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', str(input_path),
            '-t', f'{duration:.3f}', '-vf', ','.join(filters),
            '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
            '-b:v', f'{video_kbps}k', '-maxrate', f'{int(video_kbps * 1.1)}k',
            '-bufsize', f'{max(1000, int(video_kbps * 2.2))}k',
            '-profile:v', 'high', '-level:v', '4.0',
            '-c:a', 'aac', '-b:a', f'{audio_kbps}k',
            '-movflags', '+faststart', '-map_metadata', '-1', str(video_path),
        ],
        timeout=600,
    )
    if video_path.stat().st_size > 10 * MB:
        raise RuntimeError('Live Wallpaper output melebihi 10MB.')
    cover_filters = []
    if dims:
        cover_filters.append(f'scale={dims[0]}:{dims[1]}:flags=lanczos')
    cover_filters.append('setsar=1')
    run(
        [
            'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-ss', '0.12', '-i', str(input_path),
            '-frames:v', '1', '-vf', ','.join(cover_filters), '-q:v', '3', str(photo_path),
        ],
        timeout=120,
    )


def send_status_video(path, android=False):
    metadata = probe_video(path)
    data = {
        'chat_id': str(CHAT_ID),
        'caption': status_caption(),
        'supports_streaming': 'true',
        'width': str(int(metadata.get('width') or 0)),
        'height': str(int(metadata.get('height') or 0)),
        'duration': str(max(1, int(round(metadata.get('duration') or 1)))),
    }
    with path.open('rb') as handle:
        telegram_call(
            'sendVideo',
            data,
            {'video': ('status-hq.mp4', handle, 'video/mp4')},
            timeout=300,
        )


def send_live_photo(video_path, photo_path):
    with video_path.open('rb') as video, photo_path.open('rb') as photo:
        telegram_call(
            'sendLivePhoto',
            {'chat_id': str(CHAT_ID), 'caption': 'Live Wallpaper iPhone dah siap ✅'},
            {
                'live_photo': ('live-wallpaper.mp4', video, 'video/mp4'),
                'photo': ('live-wallpaper.jpg', photo, 'image/jpeg'),
            },
            timeout=180,
        )


def download_source(path):
    set_progress(5)
    app = Client('heavy_media_worker', api_id=API_ID, api_hash=API_HASH, bot_token=BOT_TOKEN, in_memory=True)
    with app:
        downloaded = app.download_media(VIDEO_FILE_ID, file_name=str(path))
        if not downloaded and SOURCE_MESSAGE_ID:
            try:
                message = app.get_messages(CHAT_ID, SOURCE_MESSAGE_ID)
                downloaded = app.download_media(message, file_name=str(path))
            except Exception as exc:
                print(f'message fallback failed: {exc}', flush=True)
        if not downloaded:
            raise RuntimeError('MTProto tak dapat download video Telegram ini.')
    if not path.exists() or path.stat().st_size <= 0:
        raise RuntimeError('Video download kosong.')
    if path.stat().st_size > MAX_INPUT_BYTES:
        raise RuntimeError(f'Video melebihi limit {MAX_INPUT_MB}MB.')
    set_progress(30)


def main():
    require_config()
    print(f'heavy worker action={ACTION} input={FILE_SIZE} chat={CHAT_ID}', flush=True)
    with tempfile.TemporaryDirectory(prefix='abangrender-heavy-') as temp_dir:
        temp = Path(temp_dir)
        source = temp / 'source-video.bin'
        download_source(source)
        probe = probe_video(source)
        print(f'probe={probe}', flush=True)

        if ACTION == 'live_wallpaper':
            set_progress(42)
            live_video = temp / 'live-wallpaper.mp4'
            cover = temp / 'live-wallpaper.jpg'
            encode_live_wallpaper(source, live_video, cover, probe)
            set_progress(88)
            send_live_photo(live_video, cover)
        elif ACTION == 'status_hq_android':
            set_progress(42)
            output = temp / 'status-hq-android.mp4'
            encode_status(source, output, probe, android=True)
            set_progress(88)
            send_status_video(output, android=True)
        else:
            set_progress(42)
            output = temp / 'status-hq.mp4'
            encode_status(source, output, probe, android=False)
            set_progress(88)
            send_status_video(output, android=False)

        set_progress(100)
        finish_progress()
        print('heavy worker complete', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'heavy worker failed: {type(exc).__name__}: {exc}', flush=True)
        fail_progress('Proses video besar tak berjaya. Cuba hantar semula atau guna video yang lebih kecil.')
        raise