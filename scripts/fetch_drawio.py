"""下载离线 draw.io webapp 到 ui/drawio，并裁掉嵌入编辑用不到的大文件。

用法：python scripts/fetch_drawio.py [--version v32.6.1] [--proxy http://127.0.0.1:11809]
输入：GitHub jgraph/drawio 发布的 draw.war（zip 格式）；输出：ui/drawio/ 目录（已在 .gitignore）。
裁剪口径：只保留 index.html 启动链（bootstrap → app.min.js 等）与中英文语言包，
去掉开发源码、Confluence 集成、查看器、模板库与 Java 部分，约 115MB → 60MB。
"""
import argparse
import shutil
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "ui" / "drawio"
CACHE = ROOT / ".cache"

# 以前缀匹配丢弃的路径（相对 war 根）
DROP_PREFIXES = (
    "WEB-INF/", "META-INF/", "connect/", "templates/",
    "js/diagramly/", "js/integrate.min.js", "js/viewer.min.js", "js/viewer-static.min.js",
    "js/embed.dev.js", "viewer.min.js", "viewer-static.min.js",
    "onedrive3.html", "teams.html", "monday-app-association.json", "vsdxImporter.html",
)
# resources/ 下只保留的语言包
KEEP_RESOURCES = {"resources/dia.txt", "resources/dia_zh.txt", "resources/dia_zh-tw.txt"}


def download(version: str, proxy: str | None) -> Path:
    """下载 draw.war 到 .cache，已存在则复用；返回本地路径。"""
    CACHE.mkdir(exist_ok=True)
    war = CACHE / f"draw-{version}.war"
    if war.exists():
        return war
    url = f"https://github.com/jgraph/drawio/releases/download/{version}/draw.war"
    handlers = [urllib.request.ProxyHandler({"http": proxy, "https": proxy})] if proxy else []
    opener = urllib.request.build_opener(*handlers)
    print(f"下载 {url}")
    with opener.open(url, timeout=300) as resp, open(war.with_suffix(".part"), "wb") as f:
        shutil.copyfileobj(resp, f)
    war.with_suffix(".part").rename(war)
    return war


def keep(name: str) -> bool:
    """判断 war 内文件是否保留。"""
    if name.endswith(".map") or name.startswith(DROP_PREFIXES):
        return False
    if name.startswith("resources/"):
        return name in KEEP_RESOURCES
    return True


def main() -> None:
    """下载并解压裁剪后的 draw.io 到 ui/drawio（先清空旧目录）。"""
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", default="v32.6.1")
    ap.add_argument("--proxy", default=None)
    args = ap.parse_args()
    war = download(args.version, args.proxy)
    if DEST.exists():
        shutil.rmtree(DEST)
    n = 0
    with zipfile.ZipFile(war) as z:
        for info in z.infolist():
            if info.is_dir() or not keep(info.filename):
                continue
            z.extract(info, DEST)
            n += 1
    (DEST / "VERSION").write_text(args.version, encoding="utf-8")
    print(f"已解压 {n} 个文件到 {DEST}")


if __name__ == "__main__":
    main()
