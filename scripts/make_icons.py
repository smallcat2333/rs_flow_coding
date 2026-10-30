"""生成 rs_flow_coding 的应用图标（32/128 PNG + ico）。

输入：无；输出：src-tauri/icons/ 下的 32x32.png、128x128.png、icon.png、icon.ico。
图案：三个状态色块（黄/红/绿）由连线串起，对应流程图协作颜色。
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"


def draw(size: int) -> Image.Image:
    """按给定边长绘制图标，坐标按 256 基准缩放。"""
    s = size / 256
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(48 * s), fill=(36, 41, 51, 255))
    line = (200, 205, 215, 255)
    w = max(1, int(10 * s))
    d.line([(128 * s, 70 * s), (128 * s, 186 * s)], fill=line, width=w)
    boxes = [
        ((64, 30, 192, 92), (255, 242, 204)),
        ((64, 112, 192, 154), (248, 206, 204)),
        ((64, 168, 192, 226), (213, 232, 212)),
    ]
    for (x0, y0, x1, y1), c in boxes:
        d.rounded_rectangle([x0 * s, y0 * s, x1 * s, y1 * s], radius=int(12 * s), fill=c + (255,))
    return img


def main() -> None:
    """生成全部尺寸图标文件。"""
    OUT.mkdir(parents=True, exist_ok=True)
    draw(32).save(OUT / "32x32.png")
    draw(128).save(OUT / "128x128.png")
    big = draw(256)
    big.save(OUT / "icon.png")
    big.save(OUT / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


if __name__ == "__main__":
    main()
