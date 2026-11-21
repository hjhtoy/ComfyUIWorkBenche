"""Run the skill from its packaged zip using only the Python builder."""

import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from zipfile import ZipFile

from support import ROOT


def build(builder, *arguments):
    return subprocess.run(
        [sys.executable, str(builder), *map(str, arguments)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    with ZipFile(ROOT / "dist/comfyui-api-workbench.zip") as package:
        package.extractall(root)
    builder = root / "comfyui-api-workbench/scripts/workbench.py"
    fixtures = ROOT / "tests/fixtures"

    # A clean packaged build should produce the standalone workbench byte for byte.
    legacy = root / "Frameform.html"
    workflow = ROOT / "workflows/pika-h3.api.json"
    profile = ROOT / "workflows/pika-h3.profile.json"
    result = build(builder, "build", workflow, profile, legacy)
    assert result.returncode == 0, result.stderr
    assert legacy.read_bytes() == (ROOT / "dist/Frameform.html").read_bytes()

    for name in ("image", "video", "resize"):
        api = fixtures / f"{name}.api.json"
        output = root / f"{name}.html"
        result = build(builder, "inspect", api)
        assert result.returncode == 0 and "  " in result.stdout, result.stderr
        result = build(builder, "build", api, fixtures / f"{name}.profile.json", output)
        assert result.returncode == 0, result.stderr
        html = output.read_text(encoding="utf-8")
        graph = json.loads(re.search(r'id="workflow">(.*?)</script>', html, re.S)[1])
        original = json.loads(api.read_text())
        assert graph == original.get("prompt", original)
        assert not re.search(
            r"<(?:script|link)\b[^>]*\b(?:src|href)=(['\"])https?://", html
        )
        assert "APP_JS" not in html

    result = build(builder, "inspect", fixtures / "ui-workflow.json")
    assert result.returncode == 1 and "API format" in result.stderr
    result = build(
        builder,
        "build",
        fixtures / "image.api.json",
        fixtures / "invalid-profile.json",
        root / "invalid.html",
    )
    assert result.returncode == 1 and not (root / "invalid.html").exists()

print(
    "PASS: packaged skill builds the workbench and image/video/resize fixtures offline."
)
