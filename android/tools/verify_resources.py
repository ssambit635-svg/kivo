#!/usr/bin/env python3
"""
Pre-flight resource check for the kivo Android shell.

The APK that used to live in this repo failed to install with "There was a
problem parsing the package" for exactly one class of reason: the binary
manifest referenced resources (`@7F020000`) that did not exist in the hand-built
resources.arsc. AAPT2 catches that at build time, but this script catches it
before Gradle even starts, and it also cross-checks the `R.id` / `R.string` /
`R.layout` symbols the Java code uses against the XML that defines them.

Usage:
    python3 android/tools/verify_resources.py
Exit code 0 = every reference resolves.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAIN = HERE.parent / "app" / "src" / "main"
RES = MAIN / "res"
JAVA = MAIN / "java"

XML_GLOBS = ["**/*.xml"]
JAVA_GLOBS = ["**/*.java"]

problems: list[str] = []
notes: list[str] = []


def defined_values(kind: str) -> set[str]:
    """Names declared in res/values/*.xml (<color name="x">, <string name="x">…)."""
    names: set[str] = set()
    for path in RES.glob("values*/*.xml"):
        text = path.read_text(encoding="utf-8")
        names.update(re.findall(rf'<{kind}\s+name="([^"]+)"', text))
        # <item name="x" type="kind"> form
        names.update(re.findall(rf'<item\s+name="([^"]+)"\s+type="{kind}"', text))
        # style/theme names live in the same files
    return names


def defined_files(kind: str) -> set[str]:
    """Resource names that come from a file: res/<kind>[-density]/name.ext"""
    names: set[str] = set()
    for path in RES.glob(f"{kind}*/*"):
        if path.is_file():
            names.add(path.stem)
    return names


def layout_ids() -> set[str]:
    ids: set[str] = set()
    for path in RES.glob("layout*/*.xml"):
        ids.update(re.findall(r'android:id="@\+id/([^"]+)"', path.read_text(encoding="utf-8")))
    return ids


def menu_ids() -> set[str]:
    ids: set[str] = set()
    for path in RES.glob("menu*/*.xml"):
        ids.update(re.findall(r'android:id="@\+id/([^"]+)"', path.read_text(encoding="utf-8")))
    return ids


VALUE_KINDS = {"string", "color", "dimen", "style", "integer", "bool", "array", "plurals"}
FILE_KINDS = {"drawable", "mipmap", "layout", "menu", "xml", "anim", "raw", "font"}


def main() -> int:
    if not RES.is_dir():
        print(f"[resources] no res/ directory at {RES}", file=sys.stderr)
        return 1

    defined: dict[str, set[str]] = {}
    for kind in VALUE_KINDS:
        defined[kind] = defined_values(kind)
    for kind in FILE_KINDS:
        defined[kind] = defined_files(kind)
    ids = layout_ids() | menu_ids()

    print("[resources] defined:")
    for kind in sorted(defined):
        if defined[kind]:
            print(f"  {kind:9s} {len(defined[kind]):3d}  {', '.join(sorted(defined[kind]))[:110]}")
    print(f"  {'id':9s} {len(ids):3d}  {', '.join(sorted(ids))[:110]}")

    # ---- 1. every @kind/name reference inside XML resolves -----------------
    ref_re = re.compile(r'@(android:)?(\w+)/([A-Za-z0-9_.]+)')
    xml_files = [p for p in RES.rglob("*.xml") if p.is_file()] + [MAIN / "AndroidManifest.xml"]
    for path in xml_files:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        for framework, kind, name in ref_re.findall(text):
            if framework:
                continue  # @android:… is a framework resource, not ours
            if kind == "id":
                if name not in ids and not name.startswith("android:"):
                    problems.append(f"{path.name}: @id/{name} is not declared by any layout or menu")
                continue
            if kind not in defined:
                problems.append(f"{path.name}: unknown resource type @{kind}/{name}")
                continue
            # Style names are dotted ("Theme.Kivo.Dialog") and inherit the
            # parent's entry, so accept either the full name or its root.
            if name not in defined[kind] and name.split(".")[0] not in defined[kind]:
                problems.append(f"{path.name}: @{kind}/{name} does not resolve")

    # ---- 2. every R.<kind>.<name> in Java resolves -------------------------
    java_re = re.compile(r"\bR\.(\w+)\.(\w+)")
    for path in JAVA.rglob("*.java"):
        text = path.read_text(encoding="utf-8")
        for kind, name in java_re.findall(text):
            if kind in VALUE_KINDS or kind in FILE_KINDS:
                if name not in defined.get(kind, set()):
                    problems.append(f"{path.name}: R.{kind}.{name} does not resolve")
            elif kind == "id":
                if name not in ids:
                    problems.append(f"{path.name}: R.id.{name} is not declared by any layout or menu")
            elif kind in ("layout", "menu"):
                if name not in defined.get(kind, set()):
                    problems.append(f"{path.name}: R.{kind}.{name} does not resolve")
            else:
                notes.append(f"{path.name}: unchecked R.{kind}.{name}")

    # ---- 3. string placeholders must match how Java formats them ----------
    def call_args(text: str, start: int) -> str:
        """Arguments of the call whose '(' is at `start`, with parens balanced."""
        depth = 0
        for i in range(start, len(text)):
            char = text[i]
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0:
                    return text[start + 1 : i]
        return ""

    def top_level_commas(arg_text: str) -> int:
        depth = 0
        count = 0
        for char in arg_text:
            if char in "([":
                depth += 1
            elif char in ")]":
                depth -= 1
            elif char == "," and depth == 0:
                count += 1
        return count

    string_decls: dict[str, str] = {}
    for values_file in RES.glob("values*/*.xml"):
        for name, body in re.findall(
            r'<string name="([^"]+)"[^>]*>(.*?)</string>', values_file.read_text(encoding="utf-8"), re.S
        ):
            string_decls[name] = body

    for path in JAVA.rglob("*.java"):
        text = path.read_text(encoding="utf-8")
        for match in re.finditer(r"getString\(\s*(?=R\.string\.)", text):
            args = call_args(text, text.index("(", match.start()))
            name_match = re.match(r"\s*R\.string\.(\w+)", args)
            if not name_match:
                continue
            name = name_match.group(1)
            decl = string_decls.get(name)
            if decl is None:
                problems.append(f"{path.name}: getString(R.string.{name}) has no declaration")
                continue
            rest = args[name_match.end() :]
            argc = 0 if not rest.strip().lstrip(",").strip() else top_level_commas(args)
            placeholders = re.findall(r"%(\d+)\$", decl)
            needed = max(int(x) for x in placeholders) if placeholders else 0
            if needed != argc:
                problems.append(
                    f"{path.name}: getString(R.string.{name}, …) passes {argc} argument(s) "
                    f"but the string needs {needed}"
                )

    # ---- 4. the launcher icon must exist for every density bucket ----------
    for density in ("mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"):
        for icon in ("ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png"):
            candidate = RES / f"mipmap-{density}" / icon
            if not candidate.exists():
                problems.append(f"missing launcher icon {candidate.relative_to(RES.parent.parent.parent)}")

    for note in notes:
        print(f"[resources] note: {note}")

    if problems:
        print(f"\n[resources] FAILED — {len(problems)} unresolvable reference(s):", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1

    print(f"\n[resources] OK — checked {len(xml_files)} XML files and "
          f"{len(list(JAVA.rglob('*.java')))} Java files; every reference resolves")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
