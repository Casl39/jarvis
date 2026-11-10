#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""J.A.R.V.I.S. — настольное окно для Arch Linux / Linux.

Запускает локальный сервер интерфейса (serve.py) внутри процесса и
открывает его в отдельном окне WebKit2GTK — без адресной строки и вкладок.

Зависимости (Arch):
    sudo pacman -S python-gobject webkit2gtk-4.1
    pip install --user edge-tts        # нейроголос Джарвиса

Запуск:
    python3 jarvis-app.py
    # сервер OpenCode должен быть запущен заранее:
    # opencode serve --port 4096
"""

from __future__ import annotations

import argparse
import os
import signal
import sys
import threading
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")

try:
    gi.require_version("WebKit2", "4.1")
except ValueError:
    gi.require_version("WebKit2", "4.0")

from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

APP_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(APP_DIR.parent))

import serve as backend  # noqa: E402

WEB_DIR = APP_DIR.parent


def start_server(host, port, opencode, password, verbose):
    httpd, actual_port = backend.bind_server(host, port, backend.Handler)
    httpd.opencode_url = opencode.rstrip("/")
    httpd.password = password
    httpd.upstream_timeout = 120
    httpd.verbose = verbose
    httpd.tts = backend.TtsEngine()

    backend.ensure_agent()

    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, actual_port


def tune_settings(view):
    settings = view.get_settings()
    for name, value in (
        ("enable-media-stream", True),
        ("enable-webrtc", True),
        ("media-playback-requires-user-gesture", False),
        ("enable-developer-extras", False),
    ):
        try:
            settings.set_property(name, value)
        except (TypeError, AttributeError):
            pass


def on_permission(view, request):
    """Разрешаем микрофон, остальные запросы отклоняем."""
    try:
        media = getattr(WebKit2, "UserMediaPermissionRequest", None)
        if media is not None and isinstance(request, media):
            request.allow()
            return True
    except Exception:  # noqa: BLE001
        pass

    try:
        request.deny()
    except Exception:  # noqa: BLE001
        pass
    return True


def build_window(url):
    window = Gtk.Window(title="J.A.R.V.I.S.")
    window.set_default_size(1180, 820)
    window.set_size_request(860, 620)

    icon = WEB_DIR / "icons" / "icon-512.png"
    if icon.is_file():
        try:
            window.set_icon_from_file(str(icon))
        except Exception:  # noqa: BLE001
            pass

    view = WebKit2.WebView()
    tune_settings(view)
    view.connect("permission-request", on_permission)
    view.load_uri(url)

    window.add(view)
    window.connect("destroy", Gtk.main_quit)
    window.show_all()
    return window


def main():
    parser = argparse.ArgumentParser(description="J.A.R.V.I.S. — настольное окно")
    parser.add_argument("--port", type=int, default=int(os.environ.get("JARVIS_PORT", "8000")))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--lan", action="store_true", help="доступ из локальной сети")
    parser.add_argument("--opencode", default=os.environ.get("OPENCODE_URL", "http://127.0.0.1:4096"))
    parser.add_argument("--password", default=os.environ.get("OPENCODE_PASSWORD", ""))
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    host = "0.0.0.0" if args.lan else args.host

    try:
        httpd, port = start_server(
            host, args.port, args.opencode, args.password, args.verbose
        )
    except OSError as exc:
        print("Не удалось запустить локальный сервер: %s" % exc)
        return 1

    url = "http://127.0.0.1:%d/" % port
    print("J.A.R.V.I.S. — окно открыто: %s" % url)
    print("OpenCode: %s" % args.opencode)
    print(
        "Нейроголос: %s"
        % ("доступен" if httpd.tts.available else "не установлен (pip install --user edge-tts)")
    )

    signal.signal(signal.SIGINT, lambda *_: GLib.idle_add(Gtk.main_quit))
    signal.signal(signal.SIGTERM, lambda *_: GLib.idle_add(Gtk.main_quit))

    build_window(url)
    try:
        Gtk.main()
    finally:
        try:
            httpd.shutdown()
        except Exception:  # noqa: BLE001
            pass
        try:
            httpd.server_close()
        except Exception:  # noqa: BLE001
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
