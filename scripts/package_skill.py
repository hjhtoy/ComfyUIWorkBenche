"""Package the built skill with stable ordering and timestamps."""

import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

skill = Path(sys.argv[1])
archive = skill.with_suffix(".zip")
with ZipFile(archive, "w", compression=ZIP_DEFLATED) as output:
    for file in sorted(skill.rglob("*")):
        if (
            not file.is_file()
            or "__pycache__" in file.parts
            or file.name == ".DS_Store"
        ):
            continue
        member = ZipInfo(file.relative_to(skill.parent).as_posix())
        member.external_attr = 0o644 << 16
        output.writestr(member, file.read_bytes(), compress_type=ZIP_DEFLATED)
print(archive)
