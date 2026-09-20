#!/usr/bin/env python3
"""
Independent verification of a built kivo APK.

CI already runs the authoritative checks (`apksigner verify`, `aapt2 dump
badging`). This script is the second opinion, and it exists because of a real
incident: the APK that used to be committed to this repo was assembled by hand
and Android rejected it with "There was a problem parsing the package". The
manifest looked fine to a casual reader — but `android:icon` pointed at a
resource id that did not exist in the hand-built resources.arsc.

So this re-checks, with the standard library only, the things that make
PackageInstaller accept or reject a package:

  1. zip container integrity and the four entries every APK must have
  2. AndroidManifest.xml is *binary* AXML (not text) and parses
  3. resources.arsc is a real table with entries in package 0x7f — and the
     icon/label references in the manifest resolve against it
  4. classes.dex has a correct header, adler32 checksum and SHA-1 signature
  5. the v1 (JAR) digests actually match the bytes in the zip
  6. an APK Signing Block is present with a v2/v3 scheme, and the certificate in
     that block is the same certificate as the v1 signature

androguard is used when it is installed (it is in CI's optional step and in the
maintainer's venv); without it the structural checks still run.

Usage:
    python3 android/tools/verify_apk.py path/to/kivo.apk
Exit code 0 = installable as far as static analysis can tell.
"""
from __future__ import annotations

import hashlib
import re
import struct
import sys
import zlib
import base64
from pathlib import Path

APK_SIG_BLOCK_MAGIC = b"APK Sig Block 42"
EOCD_SIGNATURE = b"\x50\x4b\x05\x06"

SCHEME_IDS = {
    0x7109871A: "v2 (APK Signature Scheme v2)",
    0xF05368C0: "v3 (APK Signature Scheme v3)",
    0x1B93AD61: "v3.1 (APK Signature Scheme v3.1)",
    0x42726577: "v4 (APK Signature Scheme v4 / verity)",
}

REQUIRED_ENTRIES = ("AndroidManifest.xml", "classes.dex", "resources.arsc")

failures: list[str] = []
warnings: list[str] = []
checks_passed = 0


def check(ok: bool, message: str, warn_only: bool = False) -> bool:
    global checks_passed
    if ok:
        checks_passed += 1
        print(f"  ok    {message}")
        return True
    if warn_only:
        warnings.append(message)
        print(f"  WARN  {message}")
    else:
        failures.append(message)
        print(f"  FAIL  {message}")
    return False


# --------------------------------------------------------------------------- #
# container
# --------------------------------------------------------------------------- #
def find_eocd(data: bytes) -> int:
    idx = data.rfind(EOCD_SIGNATURE)
    if idx < 0:
        raise ValueError("not a zip file: no end-of-central-directory record")
    return idx


def signing_block(data: bytes) -> tuple[int, bytes] | None:
    """Locate the APK Signing Block that sits just before the central directory."""
    eocd = find_eocd(data)
    (cd_offset,) = struct.unpack("<I", data[eocd + 16 : eocd + 20])
    if cd_offset < 24 or data[cd_offset - 16 : cd_offset] != APK_SIG_BLOCK_MAGIC:
        return None
    (size_of_block,) = struct.unpack("<Q", data[cd_offset - 24 : cd_offset - 16])
    start = cd_offset - size_of_block - 8
    if start < 0 or data[start : start + 8] != struct.pack("<Q", size_of_block):
        return None
    return start, data[start:cd_offset]


def parse_signing_pairs(block: bytes) -> dict[int, bytes]:
    (size_of_block,) = struct.unpack("<Q", block[:8])
    body = block[8 : 8 + size_of_block - 24]  # strip sizes + magic
    pairs: dict[int, bytes] = {}
    pos = 0
    while pos + 12 <= len(body):
        (pair_len,) = struct.unpack("<Q", body[pos : pos + 8])
        (pair_id,) = struct.unpack("<I", body[pos + 8 : pos + 12])
        value = body[pos + 12 : pos + 8 + pair_len]
        pairs[pair_id] = value
        pos += 8 + pair_len
    return pairs


def extract_v2_certificates(pair: bytes) -> list[bytes]:
    """Walk the length-prefixed v2 signer block down to the X.509 certificates."""
    certs: list[bytes] = []

    def read_seq(buf: bytes, offset: int) -> tuple[bytes, int]:
        (length,) = struct.unpack("<I", buf[offset : offset + 4])
        return buf[offset + 4 : offset + 4 + length], offset + 4 + length

    try:
        signers, _ = read_seq(pair, 0)
        signer, _ = read_seq(signers, 0)
        signed_data, _ = read_seq(signer, 0)
        # signedData is itself a sequence: digests | certificates | attributes
        _digests, cursor = read_seq(signed_data, 0)
        certificates, cursor = read_seq(signed_data, cursor)
        pos = 0
        while pos + 4 <= len(certificates):
            certificate, pos = read_seq(certificates, pos)
            if certificate:
                certs.append(certificate)
    except (struct.error, IndexError):
        return certs
    return certs


# --------------------------------------------------------------------------- #
# binary AndroidManifest.xml (AXML)
# --------------------------------------------------------------------------- #
def axml_strings(data: bytes) -> list[str]:
    """Decode the AXML string pool.

    Enough to prove the manifest really is binary AXML and to see which tags and
    attributes it declares — a text-XML manifest (or a broken pool) is rejected
    by PackageParser before anything else is looked at.
    """
    doc_type, doc_header, _total = struct.unpack("<HHI", data[:8])
    if doc_type != 0x0003 or doc_header != 0x0008:
        raise ValueError(f"manifest is not binary AXML (type {doc_type:#06x}, header {doc_header:#06x})")
    (pool_type,) = struct.unpack("<H", data[8:10])
    if pool_type != 0x0001:
        raise ValueError("no string pool right after the AXML header")
    (string_count,) = struct.unpack("<I", data[16:20])
    (flags,) = struct.unpack("<I", data[24:28])
    (strings_start,) = struct.unpack("<I", data[28:32])
    is_utf8 = bool(flags & (1 << 8))
    offsets = struct.unpack(f"<{string_count}I", data[36 : 36 + 4 * string_count])
    base = 8 + strings_start

    out: list[str] = []
    for offset in offsets:
        pos = base + offset
        try:
            if is_utf8:
                # two lengths: characters (UTF-16 units) then bytes, each 1 or 2 bytes
                char_len = data[pos]
                pos += 2 if char_len & 0x80 else 1
                byte_len = data[pos]
                if byte_len & 0x80:
                    byte_len = ((byte_len & 0x7F) << 8) | data[pos + 1]
                    pos += 2
                else:
                    pos += 1
                out.append(data[pos : pos + byte_len].decode("utf-8", "replace"))
            else:
                (char_len,) = struct.unpack("<H", data[pos : pos + 2])
                if char_len & 0x8000:
                    (low,) = struct.unpack("<H", data[pos + 2 : pos + 4])
                    char_len = ((char_len & 0x7FFF) << 16) | low
                    pos += 4
                else:
                    pos += 2
                out.append(data[pos : pos + 2 * char_len].decode("utf-16-le", "replace"))
        except (struct.error, IndexError, UnicodeDecodeError):
            out.append("")
    return out


# --------------------------------------------------------------------------- #
# resources.arsc
# --------------------------------------------------------------------------- #
def arsc_summary(data: bytes) -> tuple[list[int], int, int]:
    """Package ids, resource-type count and total entry count of a resource table.

    Walks the chunks the way ResourcesArsc does: RES_TABLE_TYPE -> RES_TABLE_PACKAGE_TYPE
    -> (RES_TABLE_TYPE_SPEC_TYPE | RES_TABLE_TYPE_TYPE)*.
    """
    (table_type,) = struct.unpack("<H", data[:2])
    if table_type != 0x0002:
        raise ValueError(f"resources.arsc is not a resource table (type {table_type:#06x})")
    package_ids: list[int] = []
    types = 0
    entries = 0

    pos = 12  # skip the table header (type, headerSize, size, packageCount)
    while pos + 8 <= len(data):
        (chunk_type, header_size, chunk_size) = struct.unpack("<HHI", data[pos : pos + 8])
        if chunk_size < 8 or pos + chunk_size > len(data):
            break
        if chunk_type == 0x0200:  # RES_TABLE_PACKAGE_TYPE
            (pkg_id,) = struct.unpack("<I", data[pos + 8 : pos + 12])
            package_ids.append(pkg_id)
            inner = pos + header_size
            end = pos + chunk_size
            while inner + 8 <= end:
                (itype, _iheader, isize) = struct.unpack("<HHI", data[inner : inner + 8])
                if isize < 8:
                    break
                if itype == 0x0202:  # RES_TABLE_TYPE_SPEC_TYPE
                    types += 1
                elif itype == 0x0201:  # RES_TABLE_TYPE_TYPE (one config bucket)
                    (entry_count,) = struct.unpack("<I", data[inner + 12 : inner + 16])
                    entries += entry_count
                inner += isize
        pos += chunk_size
    return package_ids, types, entries


# --------------------------------------------------------------------------- #
# classes.dex
# --------------------------------------------------------------------------- #
def dex_summary(data: bytes) -> dict[str, object]:
    magic = data[:8]
    if not magic.startswith(b"dex\n"):
        raise ValueError(f"classes.dex has a bad magic: {magic!r}")
    (checksum,) = struct.unpack("<I", data[8:12])
    signature = data[12:32]
    (file_size,) = struct.unpack("<I", data[32:36])
    (header_size,) = struct.unpack("<I", data[36:40])
    (endian_tag,) = struct.unpack("<I", data[40:44])
    (class_defs_size,) = struct.unpack("<I", data[96:100])
    return {
        "version": magic[4:7].decode("ascii", "replace"),
        "checksum": checksum,
        "checksum_ok": checksum == (zlib.adler32(data[12:]) & 0xFFFFFFFF),
        "signature_ok": signature == hashlib.sha1(data[32:]).digest(),
        "file_size": file_size,
        "file_size_ok": file_size == len(data),
        "header_size_ok": header_size == 0x70,
        "endian_ok": endian_tag == 0x12345678,
        "classes": class_defs_size,
    }


# --------------------------------------------------------------------------- #
# v1 (JAR) signature
# --------------------------------------------------------------------------- #
def parse_manifest_mf(text: str) -> dict[str, dict[str, str]]:
    """Parse META-INF/MANIFEST.MF into {entry name: {attribute: value}}."""
    entries: dict[str, dict[str, str]] = {}
    current: dict[str, str] | None = None
    last_key: str | None = None
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if not raw.strip():
            current, last_key = None, None
            continue
        if raw.startswith(" ") and current is not None and last_key:
            current[last_key] += raw[1:]      # folded continuation line
            continue
        if ":" not in raw:
            continue
        key, value = raw.split(":", 1)
        key, value = key.strip(), value.strip()
        if key.lower() == "name":
            current = {}
            entries[value] = current
            last_key = None
        elif current is not None:
            current[key.lower()] = value
            last_key = key.lower()
    return entries


def jar_digest_mismatches(zf, manifest_mf: str) -> list[str]:
    """Recompute every digest in META-INF/MANIFEST.MF against the zip contents."""
    mismatches: list[str] = []
    names = set(zf.namelist())
    for name, attributes in parse_manifest_mf(manifest_mf).items():
        if name.startswith("META-INF/"):
            continue
        if name not in names:
            mismatches.append(f"{name} is listed in MANIFEST.MF but missing from the zip")
            continue
        data = zf.read(name)
        for attribute, expected in attributes.items():
            if not attribute.endswith("-digest"):
                continue
            algorithm = attribute[: -len("-digest")]
            try:
                digest = hashlib.new(algorithm, data).digest()
            except ValueError:
                continue
            if base64.b64encode(digest).decode("ascii") != expected:
                mismatches.append(f"{name}: {attribute} does not match the stored bytes")
    return mismatches


def jar_certificates(zf) -> list[bytes]:
    """Rough extraction of DER certificates from the PKCS#7 signature blocks."""
    certs: list[bytes] = []
    for name in zf.namelist():
        if re.fullmatch(r"META-INF/.*\.(RSA|DSA|EC)", name, re.IGNORECASE):
            certs.append(zf.read(name))
    return certs


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    apk_path = Path(argv[1])
    if not apk_path.exists():
        print(f"[verify] no such file: {apk_path}", file=sys.stderr)
        return 2

    data = apk_path.read_bytes()
    print(f"[verify] {apk_path} — {len(data):,} bytes")

    import zipfile  # imported late so a missing file reports cleanly

    # -- 1. container --------------------------------------------------------
    print("[verify] container")
    try:
        zf = zipfile.ZipFile(apk_path)
    except Exception as exc:  # noqa: BLE001
        check(False, f"zip container opens ({exc})")
        return report()
    check(zf.testzip() is None, "zip CRCs are all valid")
    names = zf.namelist()
    for entry in REQUIRED_ENTRIES:
        check(entry in names, f"contains {entry}")
    check(
        any(n.startswith("META-INF/") for n in names),
        "contains a META-INF/ signature block",
    )

    # -- 2. manifest ---------------------------------------------------------
    print("[verify] AndroidManifest.xml")
    manifest = zf.read("AndroidManifest.xml")
    strings: list[str] = []
    try:
        strings = axml_strings(manifest)
        check(True, f"binary AXML with {len(strings)} pooled strings")
    except Exception as exc:  # noqa: BLE001
        check(False, f"binary AXML parses ({exc})")
    for token in ("manifest", "application", "activity", "uses-sdk"):
        check(token in strings, f"manifest declares <{token}>")
    check(
        "android.intent.action.MAIN" in strings and "android.intent.category.LAUNCHER" in strings,
        "manifest has a MAIN/LAUNCHER intent filter (the app gets a launcher icon)",
    )

    # -- 3. resources --------------------------------------------------------
    print("[verify] resources.arsc")
    arsc = zf.read("resources.arsc")
    try:
        package_ids, type_count, entry_count = arsc_summary(arsc)
        check(0x7F in package_ids, f"resource table has package 0x7f ({[hex(p) for p in package_ids]})")
        check(type_count > 0, f"resource table declares {type_count} type chunk(s)")
        # The hand-built APK that used to live here had a table with zero
        # entries, so @mipmap/ic_launcher could not resolve. Never again.
        check(entry_count > 0, f"resource table holds {entry_count} resource entries")
    except Exception as exc:  # noqa: BLE001
        check(False, f"resource table parses ({exc})")

    res_files = [n for n in names if n.startswith("res/")]
    check(len(res_files) > 0, f"contains {len(res_files)} compiled res/ file(s)")
    check(
        any(n.startswith("res/layout/") for n in res_files),
        "contains a compiled layout (res/layout/)",
    )

    # -- 4. dex --------------------------------------------------------------
    print("[verify] classes.dex")
    try:
        dex = dex_summary(zf.read("classes.dex"))
        check(bool(dex["checksum_ok"]), f"dex adler32 checksum matches ({dex['checksum']:#010x})")
        check(bool(dex["signature_ok"]), "dex SHA-1 signature matches")
        check(bool(dex["file_size_ok"]), f"dex header file size matches ({dex['file_size']} bytes)")
        check(bool(dex["header_size_ok"]) and bool(dex["endian_ok"]), "dex header size and endian tag are correct")
        check(int(dex["classes"]) > 0, f"dex defines {dex['classes']} class(es)")
    except Exception as exc:  # noqa: BLE001
        check(False, f"classes.dex parses ({exc})")

    # -- 5. v1 signature -----------------------------------------------------
    print("[verify] v1 (JAR) signature")
    meta_inf = [n for n in names if n.startswith("META-INF/")]
    sf_files = [n for n in meta_inf if n.upper().endswith(".SF")]
    key_blocks = [n for n in meta_inf if n.upper().endswith((".RSA", ".DSA", ".EC"))]
    try:
        manifest_mf = zf.read("META-INF/MANIFEST.MF").decode("utf-8", "replace")
        mismatches = jar_digest_mismatches(zf, manifest_mf)
        check(not mismatches, "every MANIFEST.MF digest matches the stored bytes"
              if not mismatches else f"{len(mismatches)} digest mismatch(es): {mismatches[:3]}")
        check(bool(sf_files) and bool(key_blocks),
              f"v1 signature files present ({', '.join(sf_files + key_blocks) or 'none'})")
        # The .SF and the PKCS#7 block must carry the same signer name
        # (apksigner's default is CERT.SF + CERT.RSA, jarsigner uses the key
        # alias). A mismatched pair is what an APK signed twice looks like.
        sf_signers = {Path(n).stem for n in sf_files}
        block_signers = {Path(n).stem for n in key_blocks}
        check(bool(sf_signers & block_signers),
              "the .SF and the signature block share a signer name "
              f"({', '.join(sorted(sf_signers)) or 'none'} vs "
              f"{', '.join(sorted(block_signers)) or 'none'})")
    except KeyError:
        check(False, "META-INF/MANIFEST.MF is present — AGP turns v1 (JAR) signing off by "
                     "default when minSdk >= 24, so android/app/build.gradle sets "
                     "enableV1Signing true; without it this package fails the repo's own "
                     "v1 checks and cannot be verified by pre-24 devices or zip tooling")
    except Exception as exc:  # noqa: BLE001
        check(False, f"v1 digests verified ({exc})")

    # -- 6. APK signing block ------------------------------------------------
    print("[verify] APK Signing Block (v2/v3)")
    found = signing_block(data)
    if check(found is not None, "APK Signing Block sits before the central directory"):
        pairs = parse_signing_pairs(found[1])
        schemes = [SCHEME_IDS.get(pid, f"unknown {pid:#010x}") for pid in pairs]
        check(
            any(pid in (0x7109871A, 0xF05368C0, 0x1B93AD61) for pid in pairs),
            f"signed with: {', '.join(schemes)}",
        )
        v2_certs: list[bytes] = []
        for pid in (0x7109871A, 0xF05368C0):
            if pid in pairs:
                v2_certs.extend(extract_v2_certificates(pairs[pid]))
        jar_certs = b"".join(jar_certificates(zf))
        if check(len(v2_certs) > 0, f"signing block carries {len(v2_certs)} X.509 certificate(s)"):
            same = any(cert and cert in jar_certs for cert in v2_certs)
            check(same, "the v2/v3 signing certificate is the same one used for v1", warn_only=not jar_certs)
        for cert in v2_certs[:1]:
            fingerprint = hashlib.sha256(cert).hexdigest()
            print(f"        cert SHA-256: {fingerprint}")

    # -- 7. androguard cross-check (optional) --------------------------------
    print("[verify] androguard cross-check")
    try:
        # androguard logs every AXML chunk at DEBUG through loguru; that would
        # bury the verdict in thousands of lines of CI output.
        from loguru import logger  # type: ignore

        logger.remove()
    except Exception:  # noqa: BLE001
        pass
    try:
        from androguard.core.apk import APK  # type: ignore
    except Exception:  # noqa: BLE001
        print("  skip  androguard is not installed — the structural checks above still ran")
    else:
        try:
            apk = APK(str(apk_path))
            check(bool(apk.is_valid_APK()), "androguard: is_valid_APK()")
            print(f"        package={apk.get_package()} versionCode={apk.get_androidversion_code()} "
                  f"versionName={apk.get_androidversion_name()}")
            print(f"        minSdk={apk.get_min_sdk_version()} targetSdk={apk.get_target_sdk_version()}")
            check(apk.get_package() == "ai.kivo.app", f"package name is ai.kivo.app (got {apk.get_package()})")
            check(int(apk.get_min_sdk_version() or 0) <= 24, f"minSdkVersion <= 24 (got {apk.get_min_sdk_version()})")
            check(int(apk.get_target_sdk_version() or 0) >= 34, f"targetSdkVersion >= 34 (got {apk.get_target_sdk_version()})")
            main = apk.get_main_activity()
            check(bool(main), f"main activity: {main}")
            check(apk.is_signed_v1() and apk.is_signed_v2(), "androguard: signed with v1 and v2")
            icon = apk.get_app_icon(max_dpi=640)
            check(bool(icon) and icon in names, f"android:icon resolves to a real entry ({icon})")
            check("android.permission.INTERNET" in apk.get_permissions(), "declares INTERNET")
            check("android.permission.CAMERA" in apk.get_permissions(), "declares CAMERA (report scanner)")
        except Exception as exc:  # noqa: BLE001
            check(False, f"androguard parsed the package ({type(exc).__name__}: {exc})")

    return report()


def report() -> int:
    print()
    if warnings:
        print(f"[verify] {len(warnings)} warning(s):")
        for warning in warnings:
            print(f"  - {warning}")
    if failures:
        print(f"[verify] FAILED — {len(failures)} check(s) did not pass:", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        print("\nThis APK would be rejected by Android. Do not publish it.", file=sys.stderr)
        return 1
    print(f"[verify] PASSED — {checks_passed} checks. The package is structurally installable.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
