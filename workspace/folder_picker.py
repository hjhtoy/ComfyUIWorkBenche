"""Open the workspace host's folder picker without blocking the worker."""
import asyncio
import base64
import contextlib
import os
from pathlib import Path
import shutil
import sys

MAC_PICKER = """
on run argv
    try
        set startFolder to (POSIX file (item 1 of argv)) as alias
        activate
        set selectedFolder to choose folder with prompt "选择结果保存目录" default location startFolder
        return POSIX path of selectedFolder
    on error number -128
        return ""
    end try
end run
"""

WINDOWS_PICKER = """
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
try {
    $dialog.Description = '选择结果保存目录'
    $dialog.SelectedPath = $env:FRAMEFORM_PICKER_START
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        [Console]::WriteLine($dialog.SelectedPath)
    }
} finally {
    $dialog.Dispose()
}
"""


def picker_executable():
    if sys.platform == "darwin":
        return "/usr/bin/osascript"
    if os.name == "nt":
        return shutil.which("powershell.exe")
    if os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"):
        return shutil.which("zenity") or shutil.which("kdialog")
    return None


async def choose_output_directory(initial):
    executable = picker_executable()
    if not executable:
        raise ValueError("工作区主机没有可用的系统目录选择器。")
    initial = initial if initial.is_dir() else Path.home()
    env = None
    if sys.platform == "darwin":
        args = ["-e", MAC_PICKER, str(initial)]
    elif os.name == "nt":
        script = base64.b64encode(WINDOWS_PICKER.encode("utf-16-le")).decode("ascii")
        args = ["-NoProfile", "-STA", "-EncodedCommand", script]
        env = {**os.environ, "FRAMEFORM_PICKER_START": str(initial)}
    elif Path(executable).name == "zenity":
        args = ["--file-selection", "--directory", "--title=选择结果保存目录",
                "--filename=" + str(initial) + os.sep]
    else:
        args = ["--title", "选择结果保存目录", "--getexistingdirectory", str(initial)]
    try:
        process = await asyncio.create_subprocess_exec(
            executable, *args, env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), 180)
        finally:
            if process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
                await process.wait()
    except asyncio.TimeoutError as error:
        raise ValueError("系统目录选择超时，请重新打开。") from error
    except OSError as error:
        raise ValueError("无法打开系统目录选择器。") from error
    if process.returncode == 1 and sys.platform != "darwin" and os.name != "nt":
        return None
    if process.returncode:
        raise ValueError("无法打开系统目录选择器，请确认主机已登录桌面。")
    value = stdout.decode("utf-8").removesuffix("\n")
    if os.name == "nt":
        value = value.removesuffix("\r")
    if not value:
        return None
    path = Path(value).resolve()
    if not path.is_dir():
        raise ValueError("所选目录已不可用，请重新选择。")
    return path
