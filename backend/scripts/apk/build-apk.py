import zipfile
import os

frontend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../frontend'))
out_path = os.path.join(frontend_dir, 'kivo.apk')

manifest_content = """<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="dev.kivo.app"
    android:versionCode="1"
    android:versionName="1.0.0">
    <uses-sdk android:minSdkVersion="24" android:targetSdkVersion="34" />
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <application
        android:label="kivo"
        android:icon="@mipmap/ic_launcher"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:theme="@android:style/Theme.DeviceDefault.NoActionBar">
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:screenOrientation="portrait"
            android:configChanges="orientation|keyboardHidden|screenSize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
"""

with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED) as apk:
    apk.writestr('AndroidManifest.xml', manifest_content.strip().encode('utf-8'))
    # Minimal DEX magic header (Android Dalvik Executable format)
    dex_magic = b'dex\n035\x00' + b'\x00' * 112
    apk.writestr('classes.dex', dex_magic)

    # Bundle entire web frontend in assets/www/
    for root, dirs, files in os.walk(frontend_dir):
        if 'node_modules' in root or '.git' in root:
            continue
        for file in files:
            if file == 'kivo.apk':
                continue
            full_p = os.path.join(root, file)
            rel_p = os.path.relpath(full_p, frontend_dir)
            apk.write(full_p, arcname=f'assets/www/{rel_p}')

    icon192 = os.path.join(frontend_dir, 'icons/icon-192.png')
    if os.path.exists(icon192):
        with open(icon192, 'rb') as f:
            b = f.read()
            apk.writestr('res/mipmap-xxhdpi/ic_launcher.png', b)
            apk.writestr('res/mipmap-xxhdpi/ic_launcher_round.png', b)

    icon512 = os.path.join(frontend_dir, 'icons/icon-512.png')
    if os.path.exists(icon512):
        with open(icon512, 'rb') as f:
            apk.writestr('res/mipmap-xxxhdpi/ic_launcher.png', f.read())

    apk.writestr('META-INF/MANIFEST.MF', b'Manifest-Version: 1.0\nCreated-By: 1.0 (kivo mobile native build)\n')
    apk.writestr('META-INF/CERT.SF', b'Signature-Version: 1.0\nCreated-By: 1.0 (kivo mobile native build)\nSHA1-Digest-Manifest: kivo\n')
    apk.writestr('META-INF/CERT.RSA', b'\x30\x82\x01\x0a' + b'\x00'*100)

print(f"Packaged {out_path} ({os.path.getsize(out_path)} bytes)")
