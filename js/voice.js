/* ============================================================
   J.A.R.V.I.S. — голос: распознавание речи и синтез
   ============================================================ */
(function (global) {
  "use strict";

  const SR = global.SpeechRecognition || global.webkitSpeechRecognition || null;
  const synth = global.speechSynthesis || null;

  const WAKE_RE = /(джарвис|jarvis|жарвис|джарвисс|жарвисс)/i;

  const v = {
    supported: !!SR,
    tts: !!synth,
    listening: false,
    speaking: false,
    wake: false,
    lang: "ru-RU",
    voiceName: "",
    rate: 1.02,
    pitch: 0.95,
    volume: 1,
    engine: "auto", // auto | neural | browser
    neural: false, // доступен ли серверный нейроголос
    serverVoices: [],
    serverVoice: "auto",
    onResult: null,
    onInterim: null,
    onState: null,
    onError: null,
    onWake: null,
  };

  let rec = null;
  let want = false;
  let starting = false;
  let restartTimer = null;
  let commandUntil = 0;
  let audioCtx = null;
  let audioEl = null;
  let speakToken = 0;

  function emit() {
    if (typeof v.onState === "function") {
      v.onState({ listening: v.listening, speaking: v.speaking, wake: v.wake });
    }
  }

  function fail(message) {
    if (typeof v.onError === "function") v.onError(message);
  }

  function normalize(text) {
    return text.toLowerCase().replace(/ё/g, "е");
  }

  function stripLead(text) {
    return text.replace(/^[\s,.:;!?—–-]+/, "").trim();
  }

  /* ---------- распознавание ---------- */

  function build() {
    rec = new SR();
    rec.lang = v.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = function () {
      starting = false;
      v.listening = true;
      emit();
    };

    rec.onend = function () {
      starting = false;
      v.listening = false;
      emit();
      if (want) {
        clearTimeout(restartTimer);
        restartTimer = setTimeout(function () {
          if (want) safeStart();
        }, 400);
      }
    };

    rec.onerror = function (e) {
      starting = false;
      const err = e && e.error;
      if (err === "not-allowed" || err === "service-not-allowed") {
        want = false;
        v.listening = false;
        emit();
        fail("Доступ к микрофону запрещён. Разрешите его в браузере.");
      } else if (err === "audio-capture") {
        want = false;
        v.listening = false;
        emit();
        fail("Микрофон не найден.");
      } else if (err === "network") {
        fail("Распознавание речи недоступно (нет сети).");
      }
      /* no-speech / aborted — обычная ситуация, молчим */
    };

    rec.onresult = function (event) {
      let finalText = "";
      let interim = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0] && result[0].transcript ? result[0].transcript : "";
        if (result.isFinal) finalText += transcript;
        else interim += transcript;
      }

      if (interim) {
        const showInterim =
          !v.wake ||
          Date.now() < commandUntil ||
          WAKE_RE.test(normalize(interim));
        if (showInterim && typeof v.onInterim === "function") v.onInterim(interim.trim());
      }

      if (finalText) {
        if (typeof v.onInterim === "function") v.onInterim("");
        handleFinal(finalText.trim());
      }
    };
  }

  function safeStart() {
    if (!SR || !want) return;
    if (!rec) build();
    rec.lang = v.lang;
    if (v.listening || starting) return;
    starting = true;
    try {
      rec.start();
    } catch (err) {
      starting = false;
      /* InvalidStateError — попробуем ещё раз чуть позже */
      clearTimeout(restartTimer);
      restartTimer = setTimeout(function () {
        if (want) safeStart();
      }, 500);
    }
  }

  function handleFinal(text) {
    if (!text) return;

    if (v.wake) {
      const norm = normalize(text);
      const match = norm.match(WAKE_RE);

      if (match) {
        const idx = norm.indexOf(match[0]);
        const rest = stripLead(text.slice(idx + match[0].length));
        commandUntil = 0;
        if (rest.length >= 2) {
          if (typeof v.onResult === "function") v.onResult(rest);
        } else {
          commandUntil = Date.now() + 8000;
          cue("wake");
          if (typeof v.onWake === "function") v.onWake();
        }
        return;
      }

      if (Date.now() < commandUntil) {
        commandUntil = 0;
        if (typeof v.onResult === "function") v.onResult(text);
      }
      return;
    }

    /* push-to-talk: одна фраза — один запрос */
    if (typeof v.onResult === "function") v.onResult(text);
    stop();
  }

  function start() {
    if (!SR) {
      fail("Браузер не поддерживает распознавание речи. Используйте Chrome или Edge.");
      return false;
    }
    want = true;
    safeStart();
    return true;
  }

  function stop() {
    want = false;
    commandUntil = 0;
    clearTimeout(restartTimer);
    if (rec) {
      try {
        rec.stop();
      } catch (_) {}
    }
    v.listening = false;
    emit();
  }

  function setWake(on) {
    v.wake = !!on;
    commandUntil = 0;
    if (v.wake) start();
    else stop();
    emit();
  }

  /* ---------- синтез ---------- */

  function voices() {
    if (!synth) return [];
    return synth.getVoices().slice().sort(function (a, b) {
      const al = a.lang.toLowerCase() === v.lang.toLowerCase() ? 0 : 1;
      const bl = b.lang.toLowerCase() === v.lang.toLowerCase() ? 0 : 1;
      if (al !== bl) return al - bl;
      return a.name.localeCompare(b.name);
    });
  }

  function pickVoice() {
    if (!synth) return null;
    const list = synth.getVoices();
    if (!list.length) return null;

    if (v.voiceName) {
      const exact = list.find(function (x) {
        return x.name === v.voiceName;
      });
      if (exact) return exact;
    }

    const lang = v.lang.toLowerCase();
    const prefix = lang.slice(0, 2);
    return (
      list.find(function (x) {
        return x.lang.toLowerCase() === lang;
      }) ||
      list.find(function (x) {
        return x.lang.toLowerCase().indexOf(prefix) === 0;
      }) ||
      null
    );
  }

  function cleanForSpeech(text) {
    return String(text)
      .replace(/```[\s\S]*?```/g, " … фрагмент кода пропущен … ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, " ссылка ")
      .replace(/<[^>]+>/g, "")
      .replace(/[*_#>|]/g, "")
      .replace(/^\s*[-•—]\s+/gm, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function chunkText(text, max) {
    max = max || 220;
    const sentences = text.match(/[^.!?…]+[.!?…]+[»"')]?\s*|[^.!?…]+$/g) || [text];
    const chunks = [];
    let current = "";

    function pushPiece(piece) {
      if (!piece) return;
      if ((current + " " + piece).trim().length > max && current) {
        chunks.push(current.trim());
        current = "";
      }
      if (piece.length > max) {
        piece.split(/,\s*|\s+/).forEach(function (word) {
          if ((current + " " + word).length > max && current) {
            chunks.push(current.trim());
            current = "";
          }
          current += (current ? " " : "") + word;
        });
      } else {
        current += (current ? " " : "") + piece;
      }
    }

    sentences.forEach(function (s) {
      pushPiece(s.trim());
    });
    if (current.trim()) chunks.push(current.trim());
    return chunks.filter(function (c) {
      return c.length > 1;
    });
  }

  function useNeural() {
    return v.neural && v.engine !== "browser";
  }

  function checkServer() {
    if (typeof global.fetch !== "function") {
      v.neural = false;
      return Promise.resolve(false);
    }
    return fetch("/tts", { headers: { Accept: "application/json" } })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (data) {
        v.neural = !!(data && data.available);
        v.serverVoices = (data && data.voices) || [];
        announceTts();
        return v.neural;
      })
      .catch(function () {
        v.neural = false;
        announceTts();
        return false;
      });
  }

  function announceTts() {
    if (typeof global.dispatchEvent === "function") {
      global.dispatchEvent(
        new CustomEvent("jarvis:tts", {
          detail: { neural: v.neural, voices: v.serverVoices.slice() },
        })
      );
    }
  }

  function speak(text) {
    if (!text) return;
    const clean = cleanForSpeech(text);
    if (clean.length < 2) return;

    stopSpeaking();

    if (useNeural()) speakNeural(clean);
    else speakBrowser(clean);
  }

  function speakNeural(clean) {
    const token = ++speakToken;
    const parts = chunkText(clean, 400);
    if (!parts.length) return;

    v.speaking = true;
    emit();

    let index = 0;

    function next() {
      if (token !== speakToken) return;
      if (index >= parts.length) {
        v.speaking = false;
        emit();
        return;
      }

      const part = parts[index++];

      fetch("/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: part, voice: v.serverVoice || "auto" }),
      })
        .then(function (response) {
          if (!response.ok) throw new Error("tts " + response.status);
          return response.blob();
        })
        .then(function (blob) {
          if (token !== speakToken) return;
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audioEl = audio;
          audio.volume = v.volume;

          const done = function () {
            URL.revokeObjectURL(url);
            if (audioEl === audio) audioEl = null;
            next();
          };

          audio.onended = done;
          audio.onerror = done;

          const playing = audio.play();
          if (playing && typeof playing.catch === "function") {
            playing.catch(function () {
              /* автовоспроизведение заблокировано — откат на браузер */
              URL.revokeObjectURL(url);
              if (audioEl === audio) audioEl = null;
              if (token === speakToken) speakBrowser(clean);
            });
          }
        })
        .catch(function () {
          if (token !== speakToken) return;
          /* нейроголос недоступен — мягкий откат на браузер */
          speakBrowser(parts.slice(index - 1).join(" "));
        });
    }

    next();
  }

  function speakBrowser(clean) {
    if (!synth || !clean) return;

    stopSpeaking();

    const parts = chunkText(clean);
    if (!parts.length) return;

    v.speaking = true;
    emit();

    let remaining = parts.length;
    const voice = pickVoice();

    parts.forEach(function (part, index) {
      const u = new SpeechSynthesisUtterance(part);
      u.lang = v.lang;
      u.rate = v.rate;
      u.pitch = v.pitch;
      u.volume = v.volume;
      if (voice) u.voice = voice;

      const finish = function () {
        remaining -= 1;
        if (remaining <= 0) {
          v.speaking = false;
          emit();
        }
      };

      u.onend = finish;
      u.onerror = finish;

      /* Небольшая пауза между фрагментами для естественности */
      if (index > 0) {
        setTimeout(function () {
          if (v.speaking) synth.speak(u);
        }, 60);
      } else {
        synth.speak(u);
      }
    });
  }

  function stopSpeaking() {
    speakToken += 1;

    if (audioEl) {
      try {
        audioEl.pause();
      } catch (_) {}
      audioEl = null;
    }

    if (synth) {
      try {
        synth.cancel();
      } catch (_) {}
    }

    if (v.speaking) {
      v.speaking = false;
      emit();
    }
  }

  /* ---------- звуковые сигналы ---------- */

  function cue(kind) {
    try {
      const Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = audioCtx || new Ctx();
      if (audioCtx.state === "suspended") audioCtx.resume();

      const t = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      const base = kind === "error" ? 240 : kind === "wake" ? 620 : 880;
      osc.type = "sine";
      osc.frequency.setValueAtTime(base, t);
      osc.frequency.exponentialRampToValueAtTime(
        kind === "error" ? 170 : base * 1.45,
        t + 0.13
      );

      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.07, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);

      osc.start(t);
      osc.stop(t + 0.26);
    } catch (_) {}
  }

  function setLang(lang) {
    if (!lang || lang === v.lang) return;
    v.lang = lang;
    if (rec) {
      const was = want;
      stop();
      if (was) setTimeout(start, 120);
    }
  }

  global.Voice = {
    get supported() {
      return v.supported;
    },
    get ttsSupported() {
      return v.tts || v.neural;
    },
    get neural() {
      return v.neural;
    },
    get serverVoices() {
      return v.serverVoices.slice();
    },
    get listening() {
      return v.listening;
    },
    get speaking() {
      return v.speaking;
    },
    get wake() {
      return v.wake;
    },
    set lang(x) {
      v.lang = x;
    },
    get lang() {
      return v.lang;
    },
    set voiceName(x) {
      v.voiceName = x || "";
    },
    get voiceName() {
      return v.voiceName;
    },
    set rate(x) {
      v.rate = Number(x) || 1;
    },
    get rate() {
      return v.rate;
    },
    set pitch(x) {
      v.pitch = Number(x) || 1;
    },
    set engine(x) {
      v.engine = x === "neural" || x === "browser" ? x : "auto";
    },
    get engine() {
      return v.engine;
    },
    set serverVoice(x) {
      v.serverVoice = x || "auto";
    },
    get serverVoice() {
      return v.serverVoice;
    },
    set volume(x) {
      v.volume = Math.max(0, Math.min(1, Number(x)));
    },
    set onResult(fn) {
      v.onResult = fn;
    },
    set onInterim(fn) {
      v.onInterim = fn;
    },
    set onState(fn) {
      v.onState = fn;
    },
    set onError(fn) {
      v.onError = fn;
    },
    set onWake(fn) {
      v.onWake = fn;
    },
    start: start,
    stop: stop,
    setWake: setWake,
    setLang: setLang,
    speak: speak,
    stopSpeaking: stopSpeaking,
    checkServer: checkServer,
    voices: voices,
    cue: cue,
    cleanForSpeech: cleanForSpeech,
  };

  if (synth) {
    if (typeof synth.onvoiceschanged !== "undefined") {
      synth.addEventListener("voiceschanged", function () {
        if (typeof global.dispatchEvent === "function") {
          global.dispatchEvent(new CustomEvent("jarvis:voices"));
        }
      });
    }
    /* Chrome иногда отдаёт голоса с задержкой */
    setTimeout(function () {
      try {
        synth.getVoices();
      } catch (_) {}
    }, 300);
  }
})(window);
