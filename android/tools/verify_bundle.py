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
files += [p for p in (frontend / 'doctor').iterdir() if p.is_file()]
with zipfile.ZipFile(apk) as z:
    for file in files:
        name = 'assets/web/' + file.relative_to(frontend).as_posix()
        assert z.read(name) == file.read_bytes(), f'Stale or missing bundled UI: {name}'
    assert b'id="auth-form"' in z.read('assets/web/index.html')
    assert b'/native/' in z.read('classes.dex'), 'APK still starts on the old mobile mock'
    assert 'assets/web/kivo.apk' not in z.namelist(), 'APK recursively bundled itself'
    assert 'assets/web/m/index.html' not in z.namelist(), 'Mobile mock must not be bundled'
print(f'[bundle] PASSED — {len(files)} current UI assets; real login bundled, API stays online')
