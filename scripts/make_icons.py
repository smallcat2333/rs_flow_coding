"""生成 flow_coding 的应用图标（32/128 PNG + ico）。

输入：无；输出：src-tauri/icons/ 下的 32x32.png、128x128.png、icon.png、icon.ico 和 agent.png。
图案：主程序用三个状态色块（黄/红/绿）串联；Agent 用会话列表同款小机器人。
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


def draw_agent(size: int) -> Image.Image:
    """按会话机器人造型绘制透明蓝色窗口图标；先以 256 像素绘制，再抗锯齿缩到所需边长。"""
    scale = 16
    img = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    color = (68, 147, 248, 255)
    width = round(1.3 * scale)
    d.line([(8 * scale, 1.6 * scale), (8 * scale, 3.7 * scale)], fill=color, width=width)
    d.ellipse([6.95 * scale, .25 * scale, 9.05 * scale, 2.35 * scale], fill=color)
    d.rounded_rectangle([2.4 * scale, 3.7 * scale, 13.6 * scale, 12.9 * scale], radius=2.7 * scale, outline=color, width=width)
    for x in (5.9, 10.1):
        d.ellipse([(x - 1.15) * scale, 7.05 * scale, (x + 1.15) * scale, 9.35 * scale], fill=color)
    for x in (.9, 15.1):
        d.line([(x * scale, 7.4 * scale), (x * scale, 10 * scale)], fill=color, width=width)
    return img.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    """生成主程序的全部尺寸图标，以及 Agent 独立窗口的透明机器人 PNG。"""
    OUT.mkdir(parents=True, exist_ok=True)
    draw(32).save(OUT / "32x32.png")
    draw(128).save(OUT / "128x128.png")
    draw_agent(64).save(OUT / "agent.png")
    big = draw(256)
    big.save(OUT / "icon.png")
    big.save(OUT / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


if __name__ == "__main__":
    main()
