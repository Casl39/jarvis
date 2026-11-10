#!/usr/bin/env bash
# ============================================================
#  J.A.R.V.I.S. — установка настольного приложения на Arch Linux
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"
APP_DIR="$(pwd)"

echo
echo "  J.A.R.V.I.S. — установка настольного приложения"
echo "  ------------------------------------------------"

MISSING=()
python3 -c "import gi" >/dev/null 2>&1 || MISSING+=("python-gobject")
python3 -c "import gi; gi.require_version('WebKit2','4.1'); from gi.repository import WebKit2" >/dev/null 2>&1 \
  || MISSING+=("webkit2gtk-4.1")

if [ "${#MISSING[@]}" -gt 0 ]; then
  echo
  echo "  Не хватает пакетов. Установите:"
  echo "    sudo pacman -S ${MISSING[*]}"
  echo
fi

echo "  Устанавливаю нейроголос edge-tts (в пользовательский каталог)..."
python3 -m pip install --user --upgrade edge-tts >/dev/null 2>&1 \
  && echo "  edge-tts установлен." \
  || echo "  Не удалось установить edge-tts — голос браузера останется резервным."

BIN="$HOME/.local/bin"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor/512x512/apps"
mkdir -p "$BIN" "$APPS" "$ICONS"

cat > "$BIN/jarvis-app" <<EOF
#!/usr/bin/env bash
exec python3 "$APP_DIR/jarvis-app.py" "\$@"
EOF
chmod +x "$BIN/jarvis-app"

if [ -f "$APP_DIR/../icons/icon-512.png" ]; then
  cp "$APP_DIR/../icons/icon-512.png" "$ICONS/jarvis.png"
fi

cat > "$APPS/jarvis-app.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=J.A.R.V.I.S.
Comment=Голосовой ассистент через OpenCode
Exec=python3 "$APP_DIR/jarvis-app.py"
Icon=jarvis
Terminal=false
Categories=Utility;AudioVideo;
StartupWMClass=J.A.R.V.I.S.
EOF

update-desktop-database "$APPS" >/dev/null 2>&1 || true
gtk-update-icon-cache "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true

echo
echo "  Готово."
echo "  Запуск из меню приложений или командой: jarvis-app"
echo "  (если команда не найдена, добавьте ~/.local/bin в PATH)"
echo
