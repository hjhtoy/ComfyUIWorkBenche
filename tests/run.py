"""Build the workbench and run the browser regression scenarios."""

import argparse
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

from support import ROOT, html_path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument(
    "cases", nargs="*", help="optional scenario names, such as project_batch"
)
parser.add_argument("--workers", type=int, default=2)
args = parser.parse_args()
quick = [
    (path.stem.removeprefix("test_"), path, [], {})
    for path in sorted((ROOT / "tests").glob("test_*.py"))
]
generation = ROOT / "tests" / "test_generation.py"
cases = quick + [
    ("generation_http", generation, ["--http"], {}),
    (
        "skill_video",
        generation,
        [],
        {"FRAMEFORM_TEST_HTML": str(html_path("video.html"))},
    ),
]
if args.cases:
    valid_names = {case[0] for case in cases}
    unknown = set(args.cases) - valid_names
    if unknown:
        parser.error("unknown cases: " + ", ".join(sorted(unknown)))
    cases = [case for case in cases if case[0] in args.cases]

subprocess.run(
    ["node", "scripts/build.mjs", "--test"],
    cwd=ROOT,
    check=True,
    env={**os.environ, "PYTHON": sys.executable},
)


def run_case(case):
    name, path, extra_args, env = case
    try:
        result = subprocess.run(
            [sys.executable, "-u", str(path), *extra_args],
            cwd=ROOT,
            env={**os.environ, **env},
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=95,
            text=True,
        )
        return name, result.returncode == 0, result.stdout
    except subprocess.TimeoutExpired as error:
        output = error.stdout.decode(errors="replace") if error.stdout else ""
        return name, False, output + "\nScenario exceeded 95 seconds."


failed = []
with ThreadPoolExecutor(max_workers=args.workers) as executor:
    for name, passed, output in executor.map(run_case, cases):
        print(f"[{'PASS' if passed else 'FAIL'}] {name}", flush=True)
        if output.strip():
            print(output.rstrip(), flush=True)
        if not passed:
            failed.append(name)

if failed:
    sys.exit("Failed: " + ", ".join(failed))
print(f"{len(cases)} scenarios passed.")
