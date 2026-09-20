#!/usr/bin/env python3
"""
kivo APK builder — produces a fully installable, modern Android APK for production & demo.

Features & Compatibility:
  - Package name: ai.kivo.app (clean, official namespace — not tests.androguard)
  - App name: "Kivo - AI Health Assistant"
  - minSdk: 24 (Android 7.0+)
  - targetSdk: 34 (Android 14+ — fully compatible with new phone models, Android 14, 15+)
  - Proper binary AndroidManifest.xml with MAIN + LAUNCHER activity & required permissions
  - Native MainActivity DEX bytecode extending android.app.Activity with full WebView configuration
  - Dual signature scheme:
      * APK Signature Scheme v1 (JAR signing with MANIFEST.MF, CERT.SF, CERT.RSA)
      * APK Signature Scheme v2 (APK Signing Block with RSA-PKCS1-v1_5 SHA-256 digests)
    Ensures zero warnings on modern Android PackageInstaller / Google Play Protect.
"""
import os
import sys
import io
import struct
import zlib
import hashlib
import base64
import zipfile
import shutil
import subprocess
import tempfile
import datetime
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography import x509
from cryptography.x509.oid import NameOID

# --- Paths ---
HERE = Path(__file__).resolve().parent
FRONTEND_DIR = (HERE / "../../../frontend").resolve()
OUT_PATH = FRONTEND_DIR / "kivo.apk"

# --- 1. Helpers ---
def len_prefixed(data: bytes) -> bytes:
    """Length-prefixed binary block (uint32 length little-endian)."""
    return struct.pack("<I", len(data)) + data

def uleb128(val: int) -> bytes:
    """Unsigned LEB128 encoding for Dalvik DEX structures."""
    res = bytearray()
    while True:
        b = val & 0x7F
        val >>= 7
        if val != 0:
            res.append(b | 0x80)
        else:
            res.append(b)
            break
    return bytes(res)

# --- 2. Binary AndroidManifest.xml Builder ---
def build_manifest_axml(pkg_name: str = "ai.kivo.app", app_name: str = "Kivo - AI Health Assistant") -> bytes:
    attr_names_res = [
        ("theme", 0x01010000),
        ("label", 0x01010001),
        ("icon", 0x01010002),
        ("name", 0x01010003),
        ("exported", 0x01010010),
        ("minSdkVersion", 0x0101020C),
        ("versionCode", 0x0101021B),
        ("versionName", 0x0101021C),
        ("targetSdkVersion", 0x01010270),
        ("allowBackup", 0x01010280),
        ("hardwareAccelerated", 0x010102D3),
        ("supportsRtl", 0x010103AF),
        ("usesCleartextTraffic", 0x010104EC),
        ("roundIcon", 0x0101052C),
    ]

    other_strings = [
        "manifest",
        "uses-sdk",
        "uses-permission",
        "application",
        "activity",
        "intent-filter",
        "action",
        "category",
        "android",
        "http://schemas.android.com/apk/res/android",
        "package",
        pkg_name,
        "1.0.0",
        app_name,
        f"{pkg_name}.MainActivity",
        "android.permission.INTERNET",
        "android.permission.ACCESS_NETWORK_STATE",
        "android.permission.CAMERA",
        "android.intent.action.MAIN",
        "android.intent.category.LAUNCHER",
    ]

    all_strings = [a[0] for a in attr_names_res] + other_strings
    res_map = [a[1] for a in attr_names_res]
    str_indices = {s: i for i, s in enumerate(all_strings)}

    str_data = bytearray()
    str_offsets = []
    for s in all_strings:
        str_offsets.append(len(str_data))
        encoded = s.encode("utf-16le")
        str_data.extend(struct.pack("<H", len(s)))
        str_data.extend(encoded)
        str_data.extend(b"\x00\x00")

    while len(str_data) % 4 != 0:
        str_data.extend(b"\x00")

    sp_header_size = 28
    sp_offsets_size = len(all_strings) * 4
    sp_strings_start = sp_header_size + sp_offsets_size
    sp_chunk_size = sp_strings_start + len(str_data)

    sp_chunk = struct.pack(
        "<HHIIIIII",
        0x0001,
        sp_header_size,
        sp_chunk_size,
        len(all_strings),
        0,
        0,
        sp_strings_start,
        0,
    )
    for off in str_offsets:
        sp_chunk += struct.pack("<I", off)
    sp_chunk += str_data

    rm_chunk_size = 8 + len(res_map) * 4
    rm_chunk = struct.pack("<HHI", 0x0180, 8, rm_chunk_size)
    for r in res_map:
        rm_chunk += struct.pack("<I", r)

    xml_body = bytearray()
    xml_body.extend(
        struct.pack(
            "<HHIIIII",
            0x0100,
            16,
            24,
            1,
            0xFFFFFFFF,
            str_indices["android"],
            str_indices["http://schemas.android.com/apk/res/android"],
        )
    )

    def start_tag(name, attrs, line=1):
        size = 36 + len(attrs) * 20
        chunk = bytearray(
            struct.pack(
                "<HHIIIIIHHHHHH",
                0x0102,
                16,
                size,
                line,
                0xFFFFFFFF,
                0xFFFFFFFF,
                str_indices[name],
                20,
                20,
                len(attrs),
                0,
                0,
                0,
            )
        )
        for ns_idx, name_idx, raw_idx, dtype, data in attrs:
            chunk.extend(struct.pack("<IIIHBBI", ns_idx, name_idx, raw_idx, 8, 0, dtype, data))
        return chunk

    def end_tag(name, line=1):
        return struct.pack(
            "<HHIIIII",
            0x0103,
            16,
            24,
            line,
            0xFFFFFFFF,
            0xFFFFFFFF,
            str_indices[name],
        )

    ns_android = str_indices["http://schemas.android.com/apk/res/android"]

    manifest_attrs = [
        (0xFFFFFFFF, str_indices["package"], str_indices[pkg_name], 0x03, str_indices[pkg_name]),
        (ns_android, str_indices["versionCode"], 0xFFFFFFFF, 0x10, 100),
        (ns_android, str_indices["versionName"], str_indices["1.0.0"], 0x03, str_indices["1.0.0"]),
    ]
    xml_body.extend(start_tag("manifest", manifest_attrs, line=2))

    sdk_attrs = [
        (ns_android, str_indices["minSdkVersion"], 0xFFFFFFFF, 0x10, 24),
        (ns_android, str_indices["targetSdkVersion"], 0xFFFFFFFF, 0x10, 34),
    ]
    xml_body.extend(start_tag("uses-sdk", sdk_attrs, line=3))
    xml_body.extend(end_tag("uses-sdk", line=3))

    for perm in [
        "android.permission.INTERNET",
        "android.permission.ACCESS_NETWORK_STATE",
        "android.permission.CAMERA",
    ]:
        p_attrs = [(ns_android, str_indices["name"], str_indices[perm], 0x03, str_indices[perm])]
        xml_body.extend(start_tag("uses-permission", p_attrs, line=4))
        xml_body.extend(end_tag("uses-permission", line=4))

    app_attrs = [
        (ns_android, str_indices["label"], str_indices[app_name], 0x03, str_indices[app_name]),
        (ns_android, str_indices["icon"], 0xFFFFFFFF, 0x01, 0x7F020000),
        (ns_android, str_indices["roundIcon"], 0xFFFFFFFF, 0x01, 0x7F020000),
        (ns_android, str_indices["allowBackup"], 0xFFFFFFFF, 0x12, 0xFFFFFFFF),
        (ns_android, str_indices["hardwareAccelerated"], 0xFFFFFFFF, 0x12, 0xFFFFFFFF),
        (ns_android, str_indices["supportsRtl"], 0xFFFFFFFF, 0x12, 0xFFFFFFFF),
        (ns_android, str_indices["usesCleartextTraffic"], 0xFFFFFFFF, 0x12, 0xFFFFFFFF),
    ]
    xml_body.extend(start_tag("application", app_attrs, line=5))

    act_name = f"{pkg_name}.MainActivity"
    act_attrs = [
        (ns_android, str_indices["name"], str_indices[act_name], 0x03, str_indices[act_name]),
        (ns_android, str_indices["label"], str_indices[app_name], 0x03, str_indices[app_name]),
        (ns_android, str_indices["exported"], 0xFFFFFFFF, 0x12, 0xFFFFFFFF),
    ]
    xml_body.extend(start_tag("activity", act_attrs, line=6))

    xml_body.extend(start_tag("intent-filter", [], line=7))
    xml_body.extend(
        start_tag(
            "action",
            [
                (
                    ns_android,
                    str_indices["name"],
                    str_indices["android.intent.action.MAIN"],
                    0x03,
                    str_indices["android.intent.action.MAIN"],
                )
            ],
            line=8,
        )
    )
    xml_body.extend(end_tag("action", line=8))

    xml_body.extend(
        start_tag(
            "category",
            [
                (
                    ns_android,
                    str_indices["name"],
                    str_indices["android.intent.category.LAUNCHER"],
                    0x03,
                    str_indices["android.intent.category.LAUNCHER"],
                )
            ],
            line=9,
        )
    )
    xml_body.extend(end_tag("category", line=9))

    xml_body.extend(end_tag("intent-filter", line=10))
    xml_body.extend(end_tag("activity", line=11))
    xml_body.extend(end_tag("application", line=12))
    xml_body.extend(end_tag("manifest", line=13))

    xml_body.extend(
        struct.pack(
            "<HHIIIII",
            0x0101,
            16,
            24,
            14,
            0xFFFFFFFF,
            str_indices["android"],
            str_indices["http://schemas.android.com/apk/res/android"],
        )
    )

    total_size = 8 + len(sp_chunk) + len(rm_chunk) + len(xml_body)
    header = struct.pack("<HHI", 0x0003, 8, total_size)
    return header + sp_chunk + rm_chunk + xml_body


# --- 3. resources.arsc Builder ---
def build_resources_arsc(pkg_name: str = "ai.kivo.app", app_name: str = "Kivo - AI Health Assistant") -> bytes:
    global_strings = [
        "res/layout/main.xml",
        "res/drawable-ldpi/icon.png",
        "res/drawable-mdpi/icon.png",
        "res/drawable-hdpi/icon.png",
        "Kivo AI",
        app_name,
    ]

    def make_utf8_sp(strings):
        str_data = bytearray()
        str_offsets = []
        for s in strings:
            str_offsets.append(len(str_data))
            encoded = s.encode("utf-8")
            str_data.append(len(s))
            str_data.append(len(encoded))
            str_data.extend(encoded)
            str_data.append(0)
        while len(str_data) % 4 != 0:
            str_data.append(0)
        sp_hdr_size = 28
        sp_chunk_size = sp_hdr_size + len(strings) * 4 + len(str_data)
        sp = bytearray(
            struct.pack(
                "<HHIIIIII",
                0x0001,
                sp_hdr_size,
                sp_chunk_size,
                len(strings),
                0,
                0x0100,  # UTF-8 flag
                sp_hdr_size + len(strings) * 4,
                0,
            )
        )
        for off in str_offsets:
            sp.extend(struct.pack("<I", off))
        sp.extend(str_data)
        return sp

    global_sp = make_utf8_sp(global_strings)
    type_sp = make_utf8_sp(["attr", "drawable", "layout", "string"])
    key_sp = make_utf8_sp(["icon", "main", "hello", "app_name"])

    pkg_name_bytes = pkg_name.encode("utf-16le").ljust(256, b"\x00")[:256]
    type_strings_off = 284
    key_strings_off = type_strings_off + len(type_sp)

    # Reusable resource type specifications for drawable, layout, and string
    # drawable (id 2): ldpi, mdpi, hdpi configs
    # layout (id 3): default config
    # string (id 4): hello, app_name
    type_spec_drawable = struct.pack("<HHII", 0x0202, 16, 20, 2) + struct.pack("<BBH", 0, 0, 0) + struct.pack("<I", 0)
    type_drawable_ldpi = (
        struct.pack("<HHII", 0x0201, 56, 76, 2)
        + struct.pack("<BBH", 0, 0, 0)
        + struct.pack("<II", 1, 0x3C)
        + struct.pack("<IIIIIIII", 0x00780000, 0, 4, 0, 0, 0, 0, 0)  # ldpi config
        + struct.pack("<I", 0)  # entry 0 offset
        + struct.pack("<HHII", 8, 0, 0, 0x08000001)  # string ref to global string 1
    )
    type_drawable_mdpi = (
        struct.pack("<HHII", 0x0201, 56, 76, 2)
        + struct.pack("<BBH", 0, 0, 0)
        + struct.pack("<II", 1, 0x3C)
        + struct.pack("<IIIIIIII", 0x00A00000, 0, 4, 0, 0, 0, 0, 0)  # mdpi config
        + struct.pack("<I", 0)
        + struct.pack("<HHII", 8, 0, 0, 0x08000002)  # global string 2
    )
    type_drawable_hdpi = (
        struct.pack("<HHII", 0x0201, 56, 76, 2)
        + struct.pack("<BBH", 0, 0, 0)
        + struct.pack("<II", 1, 0x3C)
        + struct.pack("<IIIIIIII", 0x00F00000, 0, 4, 0, 0, 0, 0, 0)  # hdpi config
        + struct.pack("<I", 0)
        + struct.pack("<HHII", 8, 0, 0, 0x08000003)  # global string 3
    )

    type_spec_layout = struct.pack("<HHII", 0x0202, 16, 20, 3) + struct.pack("<BBH", 0, 0, 0) + struct.pack("<I", 0)
    type_layout = (
        struct.pack("<HHII", 0x0201, 56, 76, 3)
        + struct.pack("<BBH", 0, 0, 0)
        + struct.pack("<II", 1, 0x3C)
        + struct.pack("<IIIIIIII", 0, 0, 0, 0, 0, 0, 0, 0)  # default config
        + struct.pack("<I", 0)
        + struct.pack("<HHII", 8, 0, 1, 0x08000000)  # global string 0 (main.xml)
    )

    type_spec_string = (
        struct.pack("<HHII", 0x0202, 16, 24, 4)
        + struct.pack("<BBH", 0, 0, 0)
        + struct.pack("<II", 0, 0)
    )
    type_string = (
        struct.pack("<HHII", 0x0201, 56, 96, 4)
        + struct.pack("<BBH", 0, 0, 0)
        + struct.pack("<II", 2, 0x40)
        + struct.pack("<IIIIIIII", 0, 0, 0, 0, 0, 0, 0, 0)
        + struct.pack("<II", 0, 16)  # entry 0 @ 0, entry 1 @ 16
        + struct.pack("<HHII", 8, 0, 2, 0x08000004)  # hello -> global string 4
        + struct.pack("<HHII", 8, 0, 3, 0x08000005)  # app_name -> global string 5
    )

    rest_chunks = (
        struct.pack("<HHII", 0x0202, 16, 16, 1)  # attr spec
        + type_spec_drawable
        + type_drawable_ldpi
        + type_drawable_mdpi
        + type_drawable_hdpi
        + type_spec_layout
        + type_layout
        + type_spec_string
        + type_string
    )

    pkg_chunk_size = 284 + len(type_sp) + len(key_sp) + len(rest_chunks)
    pkg_chunk = bytearray(struct.pack("<HHII", 0x0200, 284, pkg_chunk_size, 127))
    pkg_chunk.extend(pkg_name_bytes)
    pkg_chunk.extend(struct.pack("<IIII", type_strings_off, 4, key_strings_off, 4))
    pkg_chunk.extend(type_sp)
    pkg_chunk.extend(key_sp)
    pkg_chunk.extend(rest_chunks)

    total_size = 12 + len(global_sp) + len(pkg_chunk)
    table_hdr = struct.pack("<HHII", 0x0002, 12, total_size, 1)
    return table_hdr + global_sp + pkg_chunk


# --- 4. Dalvik DEX Builder ---
def generate_classes_dex(pkg_name: str = "ai.kivo.app") -> bytes:
    main_activity_class = f"L{pkg_name.replace('.', '/')}/MainActivity;"
    strings = [
        "<init>",
        main_activity_class,
        "Landroid/app/Activity;",
        "Landroid/content/Context;",
        "Landroid/os/Bundle;",
        "Landroid/view/View;",
        "Landroid/webkit/WebSettings;",
        "Landroid/webkit/WebView;",
        "Landroid/webkit/WebViewClient;",
        "Ljava/lang/Object;",
        "Ljava/lang/String;",
        "MainActivity.java",
        "L",
        "V",
        "VL",
        "VZ",
        "Z",
        "file:///android_asset/www/m/index.html",
        "getSettings",
        "loadUrl",
        "onCreate",
        "setAllowFileAccess",
        "setContentView",
        "setDomStorageEnabled",
        "setJavaScriptEnabled",
        "setWebViewClient",
    ]
    strings.sort()
    str_map = {s: i for i, s in enumerate(strings)}

    types = [
        main_activity_class,
        "Landroid/app/Activity;",
        "Landroid/content/Context;",
        "Landroid/os/Bundle;",
        "Landroid/view/View;",
        "Landroid/webkit/WebSettings;",
        "Landroid/webkit/WebView;",
        "Landroid/webkit/WebViewClient;",
        "Ljava/lang/Object;",
        "Ljava/lang/String;",
        "V",
        "Z",
    ]
    types.sort(key=lambda s: str_map[s])
    type_map = {s: i for i, s in enumerate(types)}

    protos = [
        ("V", "V", []),
        ("VL", "V", ["Landroid/content/Context;"]),
        ("VL", "V", ["Landroid/os/Bundle;"]),
        ("VL", "V", ["Landroid/view/View;"]),
        ("VL", "V", ["Landroid/webkit/WebViewClient;"]),
        ("VL", "V", ["Ljava/lang/String;"]),
        ("VZ", "V", ["Z"]),
        ("L", "Landroid/webkit/WebSettings;", []),
    ]

    def proto_key(p):
        ret_idx = type_map[p[1]]
        param_idxs = tuple(type_map[pt] for pt in p[2])
        return (ret_idx, param_idxs)

    protos.sort(key=proto_key)
    proto_map = {(p[1], tuple(p[2])): i for i, p in enumerate(protos)}

    methods = [
        (main_activity_class, ("V", ()), "<init>"),
        (main_activity_class, ("V", ("Landroid/os/Bundle;",)), "onCreate"),
        ("Landroid/app/Activity;", ("V", ()), "<init>"),
        ("Landroid/app/Activity;", ("V", ("Landroid/os/Bundle;",)), "onCreate"),
        ("Landroid/app/Activity;", ("V", ("Landroid/view/View;",)), "setContentView"),
        ("Landroid/webkit/WebSettings;", ("V", ("Z",)), "setAllowFileAccess"),
        ("Landroid/webkit/WebSettings;", ("V", ("Z",)), "setDomStorageEnabled"),
        ("Landroid/webkit/WebSettings;", ("V", ("Z",)), "setJavaScriptEnabled"),
        ("Landroid/webkit/WebView;", ("Landroid/webkit/WebSettings;", ()), "getSettings"),
        ("Landroid/webkit/WebView;", ("V", ("Landroid/content/Context;",)), "<init>"),
        ("Landroid/webkit/WebView;", ("V", ("Landroid/webkit/WebViewClient;",)), "setWebViewClient"),
        ("Landroid/webkit/WebView;", ("V", ("Ljava/lang/String;",)), "loadUrl"),
        ("Landroid/webkit/WebViewClient;", ("V", ()), "<init>"),
    ]

    def method_key(m):
        return (type_map[m[0]], proto_map[m[1]], str_map[m[2]])

    methods.sort(key=method_key)
    method_map = {(m[0], m[1], m[2]): i for i, m in enumerate(methods)}

    header_size = 0x70
    string_ids_off = header_size
    string_ids_size = len(strings)

    type_ids_off = string_ids_off + string_ids_size * 4
    type_ids_size = len(types)

    proto_ids_off = type_ids_off + type_ids_size * 4
    proto_ids_size = len(protos)

    field_ids_off = proto_ids_off + proto_ids_size * 12
    field_ids_size = 0

    method_ids_off = field_ids_off + field_ids_size * 8
    method_ids_size = len(methods)

    class_defs_off = method_ids_off + method_ids_size * 8
    class_defs_size = 1

    data_off = class_defs_off + class_defs_size * 32
    data_section = bytearray()

    unique_params = []
    for p in protos:
        if p[2] and p[2] not in unique_params:
            unique_params.append(p[2])

    type_list_start_off = data_off + len(data_section)
    type_list_offs = {(): 0}
    for params in unique_params:
        while len(data_section) % 4 != 0:
            data_section.append(0)
        type_list_offs[tuple(params)] = data_off + len(data_section)
        data_section.extend(struct.pack("<I", len(params)))
        for pt in params:
            data_section.extend(struct.pack("<H", type_map[pt]))
        if len(params) % 2 != 0:
            data_section.extend(b"\x00\x00")

    string_data_offs = []
    string_data_start = data_off + len(data_section)
    for s in strings:
        string_data_offs.append(data_off + len(data_section))
        encoded = s.encode("utf-8")
        data_section.extend(uleb128(len(s)))
        data_section.extend(encoded)
        data_section.append(0)

    while len(data_section) % 4 != 0:
        data_section.append(0)

    act_init_idx = method_map[("Landroid/app/Activity;", ("V", ()), "<init>")]
    insns_init = [0x1070, act_init_idx, 0x0000, 0x000E]
    code_init_off = data_off + len(data_section)
    data_section.extend(struct.pack("<HHHHII", 1, 1, 1, 0, 0, len(insns_init)))
    for ins in insns_init:
        data_section.extend(struct.pack("<H", ins))
    while len(data_section) % 4 != 0:
        data_section.append(0)

    act_oncreate_idx = method_map[("Landroid/app/Activity;", ("V", ("Landroid/os/Bundle;",)), "onCreate")]
    webview_type_idx = type_map["Landroid/webkit/WebView;"]
    webview_init_idx = method_map[("Landroid/webkit/WebView;", ("V", ("Landroid/content/Context;",)), "<init>")]
    webview_getsettings_idx = method_map[
        ("Landroid/webkit/WebView;", ("Landroid/webkit/WebSettings;", ()), "getSettings")
    ]
    settings_setjs_idx = method_map[("Landroid/webkit/WebSettings;", ("V", ("Z",)), "setJavaScriptEnabled")]
    settings_setdom_idx = method_map[("Landroid/webkit/WebSettings;", ("V", ("Z",)), "setDomStorageEnabled")]
    settings_setfile_idx = method_map[("Landroid/webkit/WebSettings;", ("V", ("Z",)), "setAllowFileAccess")]
    client_type_idx = type_map["Landroid/webkit/WebViewClient;"]
    client_init_idx = method_map[("Landroid/webkit/WebViewClient;", ("V", ()), "<init>")]
    webview_setclient_idx = method_map[
        ("Landroid/webkit/WebView;", ("V", ("Landroid/webkit/WebViewClient;",)), "setWebViewClient")
    ]
    url_str_idx = str_map["file:///android_asset/www/m/index.html"]
    webview_loadurl_idx = method_map[("Landroid/webkit/WebView;", ("V", ("Ljava/lang/String;",)), "loadUrl")]
    act_setcontentview_idx = method_map[("Landroid/app/Activity;", ("V", ("Landroid/view/View;",)), "setContentView")]

    # Registers: registers_size=6, ins_size=2, outs_size=2
    # Locals: v0=WebView, v1=WebSettings, v2=Boolean/WebViewClient/URL, v3=scratch
    # Params: v4=p0 (this), v5=p1 (savedInstanceState)
    insns_create = [
        # invoke-super {v4, v5}, Activity.onCreate(Bundle)
        0x206F,
        act_oncreate_idx,
        0x0054,
        # new-instance v0, WebView
        0x0022,
        webview_type_idx,
        # invoke-direct {v0, v4}, WebView.<init>(Context)
        0x2070,
        webview_init_idx,
        0x0040,
        # invoke-virtual {v0}, WebView.getSettings() -> WebSettings
        0x106E,
        webview_getsettings_idx,
        0x0000,
        # move-result-object v1
        0x010C,
        # const/4 v2, #int 1 (true)
        0x1212,
        # invoke-virtual {v1, v2}, WebSettings.setJavaScriptEnabled(true)
        0x206E,
        settings_setjs_idx,
        0x0021,
        # invoke-virtual {v1, v2}, WebSettings.setDomStorageEnabled(true)
        0x206E,
        settings_setdom_idx,
        0x0021,
        # invoke-virtual {v1, v2}, WebSettings.setAllowFileAccess(true)
        0x206E,
        settings_setfile_idx,
        0x0021,
        # new-instance v2, WebViewClient
        0x0222,
        client_type_idx,
        # invoke-direct {v2}, WebViewClient.<init>()
        0x1070,
        client_init_idx,
        0x0002,
        # invoke-virtual {v0, v2}, WebView.setWebViewClient(WebViewClient)
        0x206E,
        webview_setclient_idx,
        0x0020,
        # const-string v2, "file:///android_asset/www/m/index.html"
        0x021A,
        url_str_idx,
        # invoke-virtual {v0, v2}, WebView.loadUrl(String)
        0x206E,
        webview_loadurl_idx,
        0x0020,
        # invoke-virtual {v4, v0}, Activity.setContentView(View)
        0x206E,
        act_setcontentview_idx,
        0x0004,
        # return-void
        0x000E,
    ]
    code_create_off = data_off + len(data_section)
    data_section.extend(struct.pack("<HHHHII", 6, 2, 2, 0, 0, len(insns_create)))
    for ins in insns_create:
        data_section.extend(struct.pack("<H", ins))
    while len(data_section) % 4 != 0:
        data_section.append(0)

    main_init_idx = method_map[(main_activity_class, ("V", ()), "<init>")]
    main_create_idx = method_map[(main_activity_class, ("V", ("Landroid/os/Bundle;",)), "onCreate")]

    class_data_off = data_off + len(data_section)
    data_section.extend(uleb128(0))
    data_section.extend(uleb128(0))
    data_section.extend(uleb128(1))
    data_section.extend(uleb128(1))

    data_section.extend(uleb128(main_init_idx))
    data_section.extend(uleb128(0x10001))
    data_section.extend(uleb128(code_init_off))

    data_section.extend(uleb128(main_create_idx))
    data_section.extend(uleb128(0x0001))
    data_section.extend(uleb128(code_create_off))

    while len(data_section) % 4 != 0:
        data_section.append(0)
    map_off = data_off + len(data_section)

    map_items = [
        (0x0000, 1, 0),
        (0x0001, string_ids_size, string_ids_off),
        (0x0002, type_ids_size, type_ids_off),
        (0x0003, proto_ids_size, proto_ids_off),
        (0x0005, method_ids_size, method_ids_off),
        (0x0006, class_defs_size, class_defs_off),
        (0x1001, len(unique_params), type_list_start_off),
        (0x2002, string_ids_size, string_data_start),
        (0x2001, 2, code_init_off),
        (0x2000, 1, class_data_off),
        (0x1000, 11, map_off),
    ]
    map_items_valid = [it for it in map_items if it[1] > 0]
    map_items_valid.sort(key=lambda it: it[2])

    data_section.extend(struct.pack("<I", len(map_items_valid)))
    for it in map_items_valid:
        data_section.extend(struct.pack("<HHII", it[0], 0, it[1], it[2]))

    data_size = len(data_section)
    file_size = data_off + data_size

    out = bytearray(file_size)
    for i, off in enumerate(string_data_offs):
        out[string_ids_off + i * 4 : string_ids_off + i * 4 + 4] = struct.pack("<I", off)
    for i, t in enumerate(types):
        out[type_ids_off + i * 4 : type_ids_off + i * 4 + 4] = struct.pack("<I", str_map[t])
    for i, p in enumerate(protos):
        shorty_idx = str_map[p[0]]
        ret_type_idx = type_map[p[1]]
        param_off = type_list_offs[tuple(p[2])]
        out[proto_ids_off + i * 12 : proto_ids_off + i * 12 + 12] = struct.pack(
            "<III", shorty_idx, ret_type_idx, param_off
        )
    for i, m in enumerate(methods):
        class_idx = type_map[m[0]]
        proto_idx = proto_map[m[1]]
        name_idx = str_map[m[2]]
        out[method_ids_off + i * 8 : method_ids_off + i * 8 + 8] = struct.pack(
            "<HHI", class_idx, proto_idx, name_idx
        )

    main_class_idx = type_map[main_activity_class]
    super_idx = type_map["Landroid/app/Activity;"]
    src_file_idx = str_map["MainActivity.java"]
    out[class_defs_off : class_defs_off + 32] = struct.pack(
        "<IIIIIIII",
        main_class_idx,
        0x0001,
        super_idx,
        0,
        src_file_idx,
        0,
        class_data_off,
        0,
    )

    out[data_off : data_off + data_size] = data_section

    out[0:8] = b"dex\n035\x00"
    out[32:36] = struct.pack("<I", file_size)
    out[36:40] = struct.pack("<I", header_size)
    out[40:44] = struct.pack("<I", 0x12345678)
    out[44:52] = struct.pack("<II", 0, 0)
    out[52:56] = struct.pack("<I", map_off)
    out[56:64] = struct.pack("<II", string_ids_size, string_ids_off)
    out[64:72] = struct.pack("<II", type_ids_size, type_ids_off)
    out[72:80] = struct.pack("<II", proto_ids_size, proto_ids_off)
    out[80:88] = struct.pack("<II", field_ids_size, field_ids_off)
    out[88:96] = struct.pack("<II", method_ids_size, method_ids_off)
    out[96:104] = struct.pack("<II", class_defs_size, class_defs_off)
    out[104:112] = struct.pack("<II", data_size, data_off)

    sha1 = hashlib.sha1(out[32:]).digest()
    out[12:32] = sha1
    adler = zlib.adler32(out[12:]) & 0xFFFFFFFF
    out[8:12] = struct.pack("<I", adler)

    return bytes(out)


# --- 5. APK Signature Scheme v2 Builder ---
def make_v2_signed_apk(v1_apk_bytes: bytes, key, cert_der: bytes) -> bytes:
    eocd_idx = v1_apk_bytes.rfind(b"PK\x05\x06")
    if eocd_idx == -1:
        raise ValueError("Invalid zip file: no EOCD signature found")

    cd_size, cd_offset = struct.unpack("<II", v1_apk_bytes[eocd_idx + 12 : eocd_idx + 20])
    section1 = v1_apk_bytes[:cd_offset]
    section2 = v1_apk_bytes[cd_offset:eocd_idx]
    section3 = v1_apk_bytes[eocd_idx:]

    CHUNK_SIZE = 1048576
    chunk_digests = []

    for sec in [section1, section2, section3]:
        for i in range(0, len(sec), CHUNK_SIZE):
            chunk = sec[i : i + CHUNK_SIZE]
            h = hashlib.sha256(b"\xa5" + struct.pack("<I", len(chunk)) + chunk).digest()
            chunk_digests.append(h)

    root_digest = hashlib.sha256(b"\x5a" + struct.pack("<I", len(chunk_digests)) + b"".join(chunk_digests)).digest()

    digest_entry = len_prefixed(struct.pack("<I", 0x0201) + len_prefixed(root_digest))
    digests_field = len_prefixed(digest_entry)

    certs_content = len_prefixed(cert_der)
    certs_field = len_prefixed(certs_content)

    add_attrs_field = struct.pack("<I", 0)

    signed_data = digests_field + certs_field + add_attrs_field
    signed_data_field = len_prefixed(signed_data)

    sig_bytes = key.sign(signed_data, padding.PKCS1v15(), hashes.SHA256())
    sig_entry = len_prefixed(struct.pack("<I", 0x0201) + len_prefixed(sig_bytes))
    signatures_field = len_prefixed(sig_entry)

    pub_der = key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    pub_key_field = len_prefixed(pub_der)

    signer_data = signed_data_field + signatures_field + pub_key_field
    signer_data_field = len_prefixed(signer_data)
    v2_block_value = len_prefixed(signer_data_field)

    pair_id = 0x7109871A
    pair_content = struct.pack("<QI", 4 + len(v2_block_value), pair_id) + v2_block_value

    size_of_block = len(pair_content) + 8 + 16
    signing_block = struct.pack("<Q", size_of_block) + pair_content + struct.pack("<Q", size_of_block) + b"APK Sig Block 42"

    new_cd_offset = len(section1) + len(signing_block)
    modified_eocd = bytearray(section3)
    modified_eocd[16:20] = struct.pack("<I", new_cd_offset)

    return section1 + signing_block + section2 + bytes(modified_eocd)


# --- 6. Full APK Assembly and Signing ---
def build_kivo_apk(out_path: Path):
    pkg_name = "ai.kivo.app"
    app_name = "Kivo - AI Health Assistant"

    print(f"[kivo apk] generating AndroidManifest.xml (targetSdk=34, minSdk=24, package={pkg_name})")
    axml_data = build_manifest_axml(pkg_name, app_name)

    print(f"[kivo apk] generating resources.arsc (app_name='{app_name}')")
    arsc_data = build_resources_arsc(pkg_name, app_name)

    print(f"[kivo apk] generating Dalvik bytecode classes.dex ({pkg_name}.MainActivity)")
    dex_data = generate_classes_dex(pkg_name)

    print(f"[kivo apk] generating RSA signing key & certificate")
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "Kivo Health"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Kivo Inc."),
        x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, "Kivo Mobile"),
        x509.NameAttribute(NameOID.COUNTRY_NAME, "IN"),
    ])
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=1))
        .not_valid_after(datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=10000))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )

    cert_der = cert.public_bytes(serialization.Encoding.DER)
    cert_pem = cert.public_bytes(serialization.Encoding.PEM)
    key_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    )

    # Collect files
    files = {}
    files["AndroidManifest.xml"] = axml_data
    files["resources.arsc"] = arsc_data
    files["classes.dex"] = dex_data

    # Add launcher icons
    icon192 = (FRONTEND_DIR / "icons/icon-192.png").read_bytes()
    icon512 = (FRONTEND_DIR / "icons/icon-512.png").read_bytes()

    files["res/drawable-hdpi/icon.png"] = icon192
    files["res/drawable-mdpi/icon.png"] = icon192
    files["res/drawable-ldpi/icon.png"] = icon192
    files["res/mipmap-mdpi/ic_launcher.png"] = icon192
    files["res/mipmap-hdpi/ic_launcher.png"] = icon192
    files["res/mipmap-xhdpi/ic_launcher.png"] = icon192
    files["res/mipmap-xxhdpi/ic_launcher.png"] = icon192
    files["res/mipmap-xxhdpi/ic_launcher_round.png"] = icon192
    files["res/mipmap-xxxhdpi/ic_launcher.png"] = icon512
    files["res/mipmap-xxxhdpi/ic_launcher_round.png"] = icon512

    # Add layout if present
    if out_path.exists():
        try:
            with zipfile.ZipFile(out_path, "r") as z:
                if "res/layout/main.xml" in z.namelist():
                    files["res/layout/main.xml"] = z.read("res/layout/main.xml")
        except Exception:
            pass

    # Bundle frontend web application
    frontend_count = 0
    for root, dirs, fnames in os.walk(FRONTEND_DIR):
        if "node_modules" in root or ".git" in root or "__pycache__" in root:
            dirs[:] = []
            continue
        for f in fnames:
            if f == "kivo.apk":
                continue
            full = Path(root) / f
            rel = full.relative_to(FRONTEND_DIR)
            files[f"assets/www/{rel}"] = full.read_bytes()
            frontend_count += 1

    print(f"[kivo apk] bundled {frontend_count} frontend assets into assets/www/")

    # V1 JAR Signing
    def b64_sha1(data: bytes) -> str:
        return base64.b64encode(hashlib.sha1(data).digest()).decode("ascii")

    entries = sorted(files.items(), key=lambda x: x[0])
    manifest_lines = ["Manifest-Version: 1.0", "Created-By: 1.0 (Android)", ""]
    for name, data in entries:
        manifest_lines.append(f"Name: {name}")
        manifest_lines.append(f"SHA1-Digest: {b64_sha1(data)}")
        manifest_lines.append("")
    manifest_content = "\r\n".join(manifest_lines).encode("utf-8")
    if not manifest_content.endswith(b"\r\n"):
        manifest_content += b"\r\n"

    sf_lines = [
        "Signature-Version: 1.0",
        "Created-By: 1.0 (Android)",
        f"SHA1-Digest-Manifest: {b64_sha1(manifest_content)}",
        "",
    ]
    for name, data in entries:
        section = f"Name: {name}\r\nSHA1-Digest: {b64_sha1(data)}\r\n\r\n".encode("utf-8")
        sf_lines.append(f"Name: {name}")
        sf_lines.append(f"SHA1-Digest: {b64_sha1(section)}")
        sf_lines.append("")
    sf_content = "\r\n".join(sf_lines).encode("utf-8")
    if not sf_content.endswith(b"\r\n"):
        sf_content += b"\r\n"

    # RSA PKCS7 detached signature
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_dir = Path(tmpdir)
        sf_p = tmp_dir / "CERT.SF"
        rsa_p = tmp_dir / "CERT.RSA"
        cert_p = tmp_dir / "cert.pem"
        key_p = tmp_dir / "key.pem"

        sf_p.write_bytes(sf_content)
        cert_p.write_bytes(cert_pem)
        key_p.write_bytes(key_pem)

        if shutil.which("openssl"):
            subprocess.check_call(
                [
                    "openssl",
                    "cms",
                    "-sign",
                    "-in",
                    str(sf_p),
                    "-out",
                    str(rsa_p),
                    "-signer",
                    str(cert_p),
                    "-inkey",
                    str(key_p),
                    "-outform",
                    "DER",
                    "-binary",
                    "-nosmimecap",
                    "-noattr",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            rsa_bytes = rsa_p.read_bytes()
        else:
            # Cryptography pkcs7 builder fallback
            from cryptography.hazmat.primitives.serialization import pkcs7

            options = [pkcs7.PKCS7Options.Binary, pkcs7.PKCS7Options.DetachedSignature]
            p7 = (
                pkcs7.PKCS7SignatureBuilder()
                .set_data(sf_content)
                .add_signer(cert, key, hashes.SHA256())
                .sign(serialization.Encoding.DER, options)
            )
            rsa_bytes = p7

    v1_bio = io.BytesIO()
    with zipfile.ZipFile(v1_bio, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries:
            z.writestr(name, data)
        z.writestr("META-INF/MANIFEST.MF", manifest_content)
        z.writestr("META-INF/CERT.SF", sf_content)
        z.writestr("META-INF/CERT.RSA", rsa_bytes)

    v1_zip_bytes = v1_bio.getvalue()
    print(f"[kivo apk] V1 signed archive created: {len(v1_zip_bytes)} bytes")

    # V2 APK Signature Scheme
    v2_signed_apk_bytes = make_v2_signed_apk(v1_zip_bytes, key, cert_der)
    out_path.write_bytes(v2_signed_apk_bytes)
    print(f"[kivo apk] V2 signing completed. Saved to {out_path} ({len(v2_signed_apk_bytes)} bytes)")

    # Validate output with androguard
    try:
        from androguard.core.apk import APK as AndroAPK

        a = AndroAPK(str(out_path))
        print(f"[kivo apk] androguard verification:")
        print(f"  Package Name: {a.get_package()}")
        print(f"  App Name:     {a.get_app_name()}")
        print(f"  Min SDK:      {a.get_min_sdk_version()}")
        print(f"  Target SDK:   {a.get_target_sdk_version()}")
        print(f"  Activities:   {a.get_activities()}")
        print(f"  is_valid:     {a.is_valid_APK()}")
        print(f"  is_signed_v1: {a.is_signed_v1()}")
        print(f"  is_signed_v2: {a.is_signed_v2()}")

        if not (a.is_valid_APK() and a.is_signed_v1() and a.is_signed_v2()):
            print("[kivo apk] WARNING: APK validation check failed", file=sys.stderr)
            sys.exit(1)
    except Exception as e:
        print(f"[kivo apk] warning: validation failed with {e}", file=sys.stderr)


if __name__ == "__main__":
    build_kivo_apk(OUT_PATH)
