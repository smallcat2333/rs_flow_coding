"""浏览器预览服务：在 127.0.0.1 上提供 ui/，并给 index.html 注入 Tauri 模拟层。

用法：python scripts/dev_server.py [--port 8765] [--samples <含 .drawio 的目录>]
- `/index.html`（及 `/`）：在 app.js 前注入 `/__mock.js`（scripts/dev_mock.js）；
- `/__samples`：返回样例目录下 .drawio 的 {文件名: XML}，供模拟层预置；
- 其余路径：按 ui/ 静态文件提供。
只用于开发预览，不随 App 打包。
"""
import argparse
import functools
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UI = ROOT / "ui"
MOCK = ROOT / "scripts" / "dev_mock.js"


class Handler(SimpleHTTPRequestHandler):
    """静态文件 + 注入与样例两个特殊路由。"""

    samples: Path | None = None

    def _send(self, body: bytes, ctype: str) -> None:
        """返回 200 与给定内容。"""
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        """按路径分发。"""
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            html = (UI / "index.html").read_text(encoding="utf-8")
            html = html.replace('<script src="app.js">', '<script src="/__mock.js"></script><script src="app.js">')
            return self._send(html.encode("utf-8"), "text/html; charset=utf-8")
        if path == "/__mock.js":
            return self._send(MOCK.read_bytes(), "application/javascript; charset=utf-8")
        if path == "/__samples":
            data = {}
            if self.samples:
                for f in sorted([*self.samples.glob("*.drawio"), *self.samples.glob("Feat_*.md")]):
                    data[f.name] = f.read_text(encoding="utf-8")
            return self._send(json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")
        return super().do_GET()

    def end_headers(self) -> None:
        """所有响应都禁止缓存，改完前端刷新即生效。"""
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        """静默静态资源日志，只打印非 200。"""
        if len(args) > 1 and str(args[1]) != "200":
            super().log_message(fmt, *args)


def main() -> None:
    """启动预览服务。"""
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--samples", default=None)
    a = ap.parse_args()
    Handler.samples = Path(a.samples) if a.samples else None
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), functools.partial(Handler, directory=str(UI)))
    print(f"预览: http://127.0.0.1:{a.port}/", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
