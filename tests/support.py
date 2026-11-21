"""Common configuration for the browser regression tests."""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHROME_ON_MAC = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")


def html_path(name=None):
    if name is None and os.environ.get("FRAMEFORM_TEST_HTML"):
        return Path(os.environ["FRAMEFORM_TEST_HTML"]).resolve()
    return ROOT / "dist" / "tests" / (name or "Frameform.html")


async def launch_chromium(playwright):
    executable = os.environ.get("FRAMEFORM_TEST_CHROME")
    if not executable and not Path(playwright.chromium.executable_path).is_file():
        if CHROME_ON_MAC.is_file():
            executable = str(CHROME_ON_MAC)
    return await playwright.chromium.launch(executable_path=executable, headless=True)
