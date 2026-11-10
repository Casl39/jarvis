#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""J.A.R.V.I.S. — постоянный TTS-воркер для настольного приложения.

Читает JSON-строки со stdin, синтезирует речь через Edge Neural TTS
и сохраняет MP3 по указанному пути. Отвечает JSON-строкой со статусом.

    {"id": "...", "text": "...", "voice": "auto", "out": "C:\\...\\a.mp3"}
    -> {"id": "...", "ok": true}
"""

import asyncio
import json
import os
import sys

import edge_tts

RU_VOICE = "ru-RU-DmitryNeural"
EN_VOICE = "en-GB-RyanNeural"


def pick_voice(text, voice):
    if voice and voice != "auto":
        return voice
    for ch in text:
        if "а" <= ch.lower() <= "я" or ch.lower() == "ё":
            return RU_VOICE
    return EN_VOICE


async def synthesize(text, voice, out_path):
    last_error = None
    for attempt in range(4):
        try:
            if os.path.exists(out_path):
                os.remove(out_path)
        except OSError:
            pass

        try:
            communicate = edge_tts.Communicate(text, voice)
            await communicate.save(out_path)
            if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
                return
            last_error = RuntimeError("empty audio")
        except Exception as exc:  # noqa: BLE001
            last_error = exc

        await asyncio.sleep(0.4 * (attempt + 1))

    raise last_error or RuntimeError("No audio received")


def respond(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    # line-buffered UTF-8
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = None
        try:
            request = json.loads(line)
            text = (request.get("text") or "").strip()
            if not text:
                raise ValueError("empty text")
            if len(text) > 4000:
                text = text[:4000]
            voice = pick_voice(text, request.get("voice") or "auto")
            out_path = request.get("out")
            if not out_path:
                raise ValueError("no output path")
            tmp = out_path + ".part"
            asyncio.run(synthesize(text, voice, tmp))
            os.replace(tmp, out_path)
            respond({"id": request.get("id"), "ok": True, "voice": voice})
        except Exception as exc:  # noqa: BLE001
            try:
                if request and request.get("out") and os.path.exists(request["out"] + ".part"):
                    os.remove(request["out"] + ".part")
            except Exception:
                pass
            respond({"id": request.get("id") if request else None, "ok": False, "error": str(exc)})


if __name__ == "__main__":
    main()
