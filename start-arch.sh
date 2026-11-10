#!/usr/bin/env bash
# J.A.R.V.I.S. — запуск на Arch Linux / любом Linux
# Открывает отдельное настольное окно (WebKit2GTK), а если его нет —
# резервный режим в браузере.
set -euo pipefail
cd "$(dirname "$0")"

PY=python3
command -v "$PY" >/dev/null 2>&1 || PY=python

echo
echo "  J.A.R.V.I.S. — запуск"
echo "  ------------------------------------------------"
echo "  Сервер OpenCode должен быть запущен отдельно:"
echo "    opencode serve --port 4096"
echo

ARGS=()
if [ "${1:-}" = "--lan" ]; then
  ARGS+=(--lan)
fi

if "$PY" -c "import gi; gi.require_version('WebKit2','4.1'); from gi.repository import WebKit2" >/dev/null 2>&1; then
  exec "$PY" desktop/jarvis-app.py "${ARGS[@]}"
fi

echo "  WebKit2GTK не найден — открываю интерфейс в браузере."
echo "  Для отдельного окна: sudo pacman -S python-gobject webkit2gtk-4.1"
echo
exec "$PY" serve.py "${ARGS[@]}" --open
