"""打包前端离线依赖（CodeMirror 6 + marked）到 ui/vendor/vendor.js。

用法：python scripts/build_vendor.py [--proxy http://127.0.0.1:11809]
输入：scripts/vendor_entry.js；工作目录 .cache/vendor_build（npm 安装，不入库）。
输出：ui/vendor/vendor.js（入库，App 运行不依赖 npm）。
依赖：Node.js / npm。
"""
import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / ".cache" / "vendor_build"
OUT = ROOT / "ui" / "vendor" / "vendor.js"
PKGS = ["codemirror@6", "@codemirror/lang-markdown@6", "marked@18", "esbuild@0.28"]


def run(cmd: list[str], env: dict) -> None:
    """执行命令，失败直接抛错。"""
    subprocess.run(cmd, cwd=WORK, env=env, check=True, shell=os.name == "nt")


def main() -> None:
    """安装依赖并打包。"""
    ap = argparse.ArgumentParser()
    ap.add_argument("--proxy", default=None)
    a = ap.parse_args()
    env = dict(os.environ)
    if a.proxy:
        env.update(HTTPS_PROXY=a.proxy, HTTP_PROXY=a.proxy)
    WORK.mkdir(parents=True, exist_ok=True)
    pkg = WORK / "package.json"
    if not pkg.exists():
        pkg.write_text(json.dumps({"name": "vendor-build", "private": True}), encoding="utf-8")
    run(["npm", "i", "--no-audit", "--no-fund", *PKGS], env)
    shutil.copy(ROOT / "scripts" / "vendor_entry.js", WORK / "entry.js")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    run(["npx", "esbuild", "entry.js", "--bundle", "--minify", "--format=iife", "--target=es2020", f"--outfile={OUT}"], env)
    print(f"已生成 {OUT}（{OUT.stat().st_size // 1024} KB）")


if __name__ == "__main__":
    main()
