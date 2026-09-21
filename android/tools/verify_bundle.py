#!/usr/bin/env python3
"""Verify the APK contains the CURRENT real UI, not an older web-only shell."""
from pathlib import Path
import sys
import zipfile

root = Path(__file__).resolve().parents[2]
apk = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'frontend/kivo.apk'
frontend = root / 'frontend'
files = [p for p in frontend.iterdir() if p.suffix in ('.html', '.css', '.js') and p.name != 'sw.js']
files += [frontend / 'manifest.webmanifest']
files += list((frontend / 'icons').glob('*.png'))
files += list((frontend / 'img').glob('*.jpg')) + list((frontend / 'img').glob('*.webp'))
files += list((frontend / 'img').glob('*.mp4'))
files += list((frontend / 'fonts').glob('*.woff2'))
files += [p for p in (frontend / 'doctor').iterdir() if p.is_file()]
with zipfile.ZipFile(apk) as z:
    for file in files:
        name = 'assets/web/' + file.relative_to(frontend).as_posix()
        assert z.read(name) == file.read_bytes(), f'Stale or missing bundled UI: {name}'
    assert b'id="auth-form"' in z.read('assets/web/index.html')
    assert b'/native/' in z.read('classes.dex'), 'APK still starts on the old mobile mock'
    assert 'assets/web/kivo.apk' not in z.namelist(), 'APK recursively bundled itself'
    assert 'assets/web/m/index.html' not in z.namelist(), 'Mobile mock must not be bundled'
    # the interceptor allowlist must serve photography + fonts offline
    img = next(p for p in sorted((frontend / 'img').glob('*.jpg')))
    assert z.read('assets/web/' + img.relative_to(frontend).as_posix()), 'app imagery missing from bundle'
    font = next(p for p in sorted((frontend / 'fonts').glob('*.woff2')))
    assert z.read('assets/web/' + font.relative_to(frontend).as_posix()), 'self-hosted fonts missing from bundle'
print(f'[bundle] PASSED — {len(files)} current UI assets; real login bundled, API stays online')
