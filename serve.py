#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
J.A.R.V.I.S. — локальный сервер интерфейса и прокси к OpenCode.

Запуск:
    python serve.py --open

Что делает:
  * раздаёт файлы приложения (index.html, style.css, js/, icons/);
  * проксирует /oc/* в сервер OpenCode, поэтому браузеру не нужны CORS
    и отдельная настройка авторизации.

Зависимостей нет — только стандартная библиотека Python 3.8+.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
DEFAULT_OPENCODE = os.environ.get("OPENCODE_URL", "http://127.0.0.1:4096")
DEFAULT_PORT = int(os.environ.get("JARVIS_PORT", "8000"))

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("image/png", ".png")

HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}

TTS_VOICES = [
    "auto",
    "ru-RU-DmitryNeural",
    "en-GB-RyanNeural",
    "ru-RU-SvetlanaNeural",
]
TTS_CACHE = Path(tempfile.gettempdir()) / "jarvis-tts-cache"


class TtsEngine:
    """Нейросетевой синтез речи через edge-tts (если установлен)."""

    def __init__(self):
        self.lock = threading.Lock()
        try:
            import edge_tts  # noqa: F401

            self.available = True
        except Exception:  # noqa: BLE001
            self.available = False

    @staticmethod
    def resolve_voice(text, voice):
        if voice and voice != "auto":
            return voice
        for ch in text:
            low = ch.lower()
            if "а" <= low <= "я" or low == "ё":
                return "ru-RU-DmitryNeural"
        return "en-GB-RyanNeural"

    def synthesize(self, text, voice):
        if not self.available or not text:
            return None

        voice = self.resolve_voice(text, voice)
        key = hashlib.sha1((voice + "|" + text).encode("utf-8")).hexdigest()
        cache = TTS_CACHE / (key + ".mp3")

        try:
            if cache.is_file():
                return cache.read_bytes()
        except OSError:
            pass

        with self.lock:
            try:
                if cache.is_file():
                    return cache.read_bytes()
            except OSError:
                pass

            part = cache.with_suffix(".part")
            last_error = None
            for attempt in range(4):
                try:
                    import asyncio

                    import edge_tts

                    TTS_CACHE.mkdir(parents=True, exist_ok=True)
                    try:
                        part.unlink()
                    except OSError:
                        pass
                    asyncio.run(edge_tts.Communicate(text, voice).save(str(part)))
                    if part.is_file() and part.stat().st_size > 0:
                        os.replace(part, cache)
                        return cache.read_bytes()
                    last_error = RuntimeError("empty audio")
                except Exception as exc:  # noqa: BLE001
                    last_error = exc
                time.sleep(0.4 * (attempt + 1))

            try:
                part.unlink()
            except OSError:
                pass
            return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "JarvisUI/1.0"

    # ---------- утилиты ----------

    def log_message(self, fmt, *args):
        if getattr(self.server, "verbose", False):
            sys.stderr.write("  %s\n" % (fmt % args))

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def send_error_json(self, status, message):
        self.send_json(status, {"message": message})

    # ---------- маршрутизация ----------

    def do_GET(self):
        self.route("GET")

    def do_HEAD(self):
        self.route("HEAD")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_PATCH(self):
        self.route("PATCH")

    def do_DELETE(self):
        self.route("DELETE")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Allow", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def route(self, method):
        split = urllib.parse.urlsplit(self.path)
        path = split.path

        if path == "/oc" or path.startswith("/oc/"):
            target = path[3:] or "/"
            self.proxy(method, target, split.query)
            return

        if path == "/app/info":
            engine = getattr(self.server, "tts", None)
            self.send_json(
                200,
                {
                    "desktop": False,
                    "tts": bool(engine and engine.available),
                    "version": "1.0",
                },
            )
            return

        if path == "/tts":
            self.tts(method)
            return

        if method in ("GET", "HEAD"):
            self.static(path)
        else:
            self.send_error_json(405, "Метод не поддерживается для статических файлов")

    # ---------- синтез речи ----------

    def tts(self, method):
        engine = getattr(self.server, "tts", None)
        if engine is None:
            self.send_error_json(503, "Синтез речи недоступен")
            return

        if method in ("GET", "HEAD"):
            self.send_json(200, {"available": engine.available, "voices": TTS_VOICES})
            return

        if method != "POST":
            self.send_error_json(405, "Метод не поддерживается")
            return

        length = 0
        raw_length = self.headers.get("Content-Length")
        if raw_length:
            try:
                length = int(raw_length)
            except ValueError:
                length = 0
        body = self.rfile.read(length) if length > 0 else b""

        try:
            data = json.loads(body.decode("utf-8") or "{}")
        except (UnicodeDecodeError, ValueError):
            self.send_error_json(400, "Некорректный JSON")
            return

        text = (data.get("text") or "").strip() if isinstance(data, dict) else ""
        if not text:
            self.send_error_json(400, "Пустой текст")
            return

        audio = engine.synthesize(text[:4000], data.get("voice") or "auto")
        if not audio:
            self.send_error_json(502, "Синтез речи недоступен")
            return

        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(audio)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(audio)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # ---------- статика ----------

    def static(self, path):
        if path in ("", "/"):
            path = "/index.html"

        rel = urllib.parse.unquote(path).lstrip("/")
        try:
            file = (APP_DIR / rel).resolve()
        except OSError:
            self.send_error(400, "Некорректный путь")
            return

        if not str(file).startswith(str(APP_DIR) + os.sep) or not file.is_file():
            self.send_error(404, "Файл не найден")
            return

        try:
            data = file.read_bytes()
        except OSError as exc:
            self.send_error_json(500, "Не удалось прочитать файл: %s" % exc)
            return

        ctype = mimetypes.guess_type(str(file))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in (
            "application/javascript",
            "application/json",
            "application/manifest+json",
            "image/svg+xml",
        ):
            ctype += "; charset=utf-8"

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Service-Worker-Allowed", "/")
        self.end_headers()

        if self.command != "HEAD":
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

    # ---------- прокси ----------

    def proxy(self, method, path, query):
        url = self.server.opencode_url.rstrip("/") + path
        if query:
            url += "?" + query

        length = 0
        raw_length = self.headers.get("Content-Length")
        if raw_length:
            try:
                length = int(raw_length)
            except ValueError:
                length = 0
        body = self.rfile.read(length) if length > 0 else None

        headers = {"Accept-Encoding": "identity"}
        for name in ("Content-Type", "Accept", "Range"):
            value = self.headers.get(name)
            if value:
                headers[name] = value

        if self.server.password:
            token = base64.b64encode(
                ("opencode:" + self.server.password).encode("utf-8")
            ).decode("ascii")
            headers["Authorization"] = "Basic " + token

        request = urllib.request.Request(url, data=body, headers=headers, method=method)

        timeout = 3600 if path.startswith("/api/event") else self.server.upstream_timeout
        try:
            response = urllib.request.urlopen(request, timeout=timeout)
        except urllib.error.HTTPError as exc:
            response = exc
        except Exception as exc:  # noqa: BLE001
            self.send_error_json(
                502,
                "OpenCode недоступен по адресу %s (%s). Запустите: opencode serve"
                % (self.server.opencode_url, exc),
            )
            return

        status = getattr(response, "status", None) or getattr(response, "code", 502)

        self.send_response(status)
        for name, value in response.headers.items():
            lower = name.lower()
            if lower in HOP_HEADERS or lower in ("content-length", "content-encoding"):
                continue
            self.send_header(name, value)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()

        reader = getattr(response, "read1", None) or response.read
        try:
            while True:
                chunk = reader(8192)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            pass
        except Exception:  # noqa: BLE001
            pass
        finally:
            try:
                response.close()
            except Exception:  # noqa: BLE001
                pass


# ============================================================
#   Вспомогательные функции
# ============================================================


def lan_ips():
    ips = set()
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(0.4)
        sock.connect(("8.8.8.8", 80))
        ips.add(sock.getsockname()[0])
        sock.close()
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127."))


def check_opencode(url, password, timeout=3.0):
    headers = {"Accept": "application/json"}
    if password:
        token = base64.b64encode(("opencode:" + password).encode("utf-8")).decode("ascii")
        headers["Authorization"] = "Basic " + token
    request = urllib.request.Request(url.rstrip("/") + "/api/info", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8") or "{}")
            if isinstance(payload, dict) and "data" in payload:
                payload = payload["data"]
            return True, payload
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            return False, "401 — неверный пароль"
        return False, "HTTP %s" % exc.code
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


def install_agent():
    source = APP_DIR / "agents" / "jarvis.md"
    if not source.is_file():
        print("Не найден файл agents/jarvis.md")
        return 1

    target_dir = Path.home() / ".config" / "opencode" / "agents"
    target = target_dir / "jarvis.md"

    try:
        target_dir.mkdir(parents=True, exist_ok=True)
        if target.exists():
            backup = target.with_suffix(".md.bak")
            shutil.copy2(target, backup)
            print("Старый агент сохранён: %s" % backup)
        shutil.copy2(source, target)
    except OSError as exc:
        print("Не удалось установить агента: %s" % exc)
        return 1

    print("Агент установлен: %s" % target)
    print("OpenCode подхватит его автоматически (перезапуск не нужен).")
    return 0


def agent_target():
    return Path.home() / ".config" / "opencode" / "agents" / "jarvis.md"


def ensure_agent():
    """Install the jarvis agent on first run.

    Returns "present", "installed", "missing-source" or "failed".
    """
    target = agent_target()
    if target.exists():
        return "present"

    source = APP_DIR / "agents" / "jarvis.md"
    if not source.is_file():
        return "missing-source"

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    except OSError:
        return "failed"
    return "installed"


def bind_server(host, port, handler):
    last_error = None
    for offset in range(0, 12):
        candidate = port + offset
        try:
            httpd = ThreadingHTTPServer((host, candidate), handler)
            httpd.daemon_threads = True
            return httpd, candidate
        except OSError as exc:
            last_error = exc
            continue
    raise last_error  # type: ignore[misc]


def main():
    parser = argparse.ArgumentParser(
        description="J.A.R.V.I.S. — интерфейс и прокси к OpenCode",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="порт интерфейса")
    parser.add_argument("--host", default="127.0.0.1", help="адрес прослушивания")
    parser.add_argument(
        "--lan",
        action="store_true",
        help="разрешить доступ из локальной сети (для телефона/Android)",
    )
    parser.add_argument("--opencode", default=DEFAULT_OPENCODE, help="адрес сервера OpenCode")
    parser.add_argument(
        "--password",
        default=os.environ.get("OPENCODE_PASSWORD", ""),
        help="пароль сервера OpenCode (или переменная OPENCODE_PASSWORD)",
    )
    parser.add_argument("--open", dest="open_browser", action="store_true", help="открыть браузер")
    parser.add_argument("--verbose", action="store_true", help="логировать запросы")
    parser.add_argument(
        "--install-agent",
        action="store_true",
        help="установить агента jarvis.md в ~/.config/opencode/agents",
    )
    args = parser.parse_args()

    if args.install_agent:
        sys.exit(install_agent())

    host = "0.0.0.0" if args.lan else args.host
    opencode_url = args.opencode.rstrip("/")

    try:
        httpd, port = bind_server(host, args.port, Handler)
    except OSError as exc:
        print("Не удалось занять порт %s: %s" % (args.port, exc))
        sys.exit(1)

    httpd.opencode_url = opencode_url
    httpd.password = args.password
    httpd.upstream_timeout = 120
    httpd.verbose = args.verbose
    httpd.tts = TtsEngine()

    agent_state = ensure_agent()

    local_url = "http://localhost:%d" % port
    ok, detail = check_opencode(opencode_url, args.password)

    line = "=" * 66
    print()
    print(line)
    print("   J.A.R.V.I.S.  ·  интерфейс запущен")
    print(line)
    print("   Открыть:      %s" % local_url)
    print("   OpenCode:     %s" % opencode_url)
    if args.password:
        print("   Пароль:       задан")
    print(
        "   Нейроголос:   %s"
        % (
            "edge-tts доступен"
            if httpd.tts.available
            else "не установлен (pip install --user edge-tts)"
        )
    )
    if agent_state == "installed":
        print("   Агент:        установлен jarvis.md (короткие ответы)")
    elif agent_state == "failed":
        print("   Агент:        не удалось установить ~/.config/opencode/agents/jarvis.md")
    elif agent_state == "missing-source":
        print("   Агент:        файл agents/jarvis.md не найден")
    if ok:
        version = detail.get("version") if isinstance(detail, dict) else "?"
        print("   Статус:       сервер OpenCode доступен (версия %s)" % version)
    else:
        print("   Статус:       OpenCode недоступен — %s" % detail)
        print()
        print("   Запустите сервер в другом терминале:")
        print("     opencode serve --port 4096")
        print("   (в настольном приложении Jarvis.exe сервер запускается сам)")
    print()

    if args.lan or host == "0.0.0.0":
        ips = lan_ips()
        if ips:
            print("   Для телефона (та же Wi-Fi сеть):")
            for ip in ips:
                print("     http://%s:%d" % (ip, port))
        else:
            print("   Локальные IP не найдены — проверьте подключение к сети.")
        print()
        print("   Внимание: интерфейс доступен другим устройствам в вашей сети")
        print("   и даёт им доступ к вашему OpenCode.")
        print()

    print("   Ctrl+C — остановить.")
    print(line)
    print()

    if args.open_browser:
        threading.Timer(0.7, lambda: webbrowser.open(local_url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлено.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
