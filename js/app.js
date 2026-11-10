/* ============================================================
   J.A.R.V.I.S. — приложение
   ============================================================ */
(function () {
  "use strict";

  const $ = (sel, root) => (root || document).querySelector(sel);

  const DEFAULTS = {
    baseUrl: "/oc",
    directory: "",
    model: "",
    agent: "jarvis",
    lang: "ru-RU",
    voice: "",
    ttsEngine: "auto",
    ttsVoice: "auto",
    rate: 1.02,
    pitch: 0.95,
    autoSpeak: true,
    wake: false,
    cues: true,
  };

  const LS_SETTINGS = "jarvis.settings.v1";
  const LS_SESSION = "jarvis.session.v1";

  const el = {
    app: $("#app"),
    transcript: $("#transcript"),
    input: $("#input"),
    composer: $("#composer"),
    interim: $("#interim"),
    btnMic: $("#btnMic"),
    btnSend: $("#btnSend"),
    btnStop: $("#btnStop"),
    btnSettings: $("#btnSettings"),
    btnHistory: $("#btnHistory"),
    btnCloseDrawer: $("#btnCloseDrawer"),
    btnCloseHistory: $("#btnCloseHistory"),
    drawer: $("#drawer"),
    historyPanel: $("#historyPanel"),
    historyList: $("#historyList"),
    scrim: $("#scrim"),
    perm: $("#perm"),
    permAction: $("#permAction"),
    permRes: $("#permRes"),
    statusBtn: $("#statusBtn"),
    statusText: $("#statusText"),
    coreState: $("#coreState"),
    coreHint: $("#coreHint"),
    toasts: $("#toasts"),
    wakeHint: $("#wakeHint"),
    sessionHint: $("#sessionHint"),
    fileBanner: $("#fileBanner"),
    setUrl: $("#setUrl"),
    setDir: $("#setDir"),
    setModel: $("#setModel"),
    setAgent: $("#setAgent"),
    setLang: $("#setLang"),
    setTtsEngine: $("#setTtsEngine"),
    setTtsVoice: $("#setTtsVoice"),
    setVoice: $("#setVoice"),
    setRate: $("#setRate"),
    rateOut: $("#rateOut"),
    setAutoSpeak: $("#setAutoSpeak"),
    setWake: $("#setWake"),
    setCues: $("#setCues"),
    btnTest: $("#btnTest"),
    btnVoiceTest: $("#btnVoiceTest"),
    btnNew: $("#btnNew"),
    btnClear: $("#btnClear"),
    btnReset: $("#btnReset"),
    connNote: $("#connNote"),
    sessionInfo: $("#sessionInfo"),
    aboutInfo: $("#aboutInfo"),
  };

  const app = {
    sessionID: null,
    connected: false,
    busy: false,
    info: null,
    models: [],
    agents: [],
    sub: null,
    bubbles: new Map(),
    segments: new Map(),
    tools: new Map(),
    thinkingEl: null,
    pendingPerm: null,
    emptyEl: null,
    lastPing: 0,
  };

  const speech = { queue: [], timer: null };

  let S = {};

  /* ============================================================
     Настройки
     ============================================================ */

  function loadSettings() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(LS_SETTINGS) || "{}");
    } catch (_) {
      saved = {};
    }
    S = Object.assign({}, DEFAULTS, saved);

    if (location.protocol === "file:") {
      if (!saved.baseUrl) S.baseUrl = "http://127.0.0.1:4096";
      el.fileBanner.hidden = false;
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(LS_SETTINGS, JSON.stringify(S));
    } catch (_) {}
  }

  function applySettingsToForm() {
    el.setUrl.value = S.baseUrl;
    el.setDir.value = S.directory;
    el.setAgent.value = S.agent;
    el.setLang.value = S.lang;
    el.setTtsEngine.value = S.ttsEngine;
    el.setRate.value = String(S.rate);
    el.rateOut.textContent = Number(S.rate).toFixed(2).replace(/0$/, "");
    el.setAutoSpeak.checked = !!S.autoSpeak;
    el.setWake.checked = !!S.wake;
    el.setCues.checked = !!S.cues;
    el.wakeHint.hidden = !S.wake;

    if (!el.setLang.value) el.setLang.value = "ru-RU";
    if (!el.setTtsEngine.value) el.setTtsEngine.value = "auto";
  }

  function applyVoiceSettings() {
    Voice.lang = S.lang;
    Voice.voiceName = S.voice;
    Voice.engine = S.ttsEngine;
    Voice.serverVoice = S.ttsVoice;
    Voice.rate = S.rate;
    Voice.pitch = S.pitch;
    if (S.wake) Voice.setWake(true);
  }

  /* ============================================================
     Мелкие утилиты
     ============================================================ */

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }

  function toast(message, kind) {
    const node = document.createElement("div");
    node.className = "toast" + (kind ? " " + kind : "");
    node.textContent = message;
    el.toasts.appendChild(node);
    setTimeout(function () {
      node.classList.add("out");
      setTimeout(function () {
        node.remove();
      }, 260);
    }, 5200);
  }

  function relTime(ts) {
    if (!ts) return "";
    const diff = (Date.now() - ts) / 1000;
    if (diff < 60) return "только что";
    if (diff < 3600) return Math.floor(diff / 60) + " мин назад";
    if (diff < 86400) return Math.floor(diff / 3600) + " ч назад";
    if (diff < 172800) return "вчера";
    return new Date(ts).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  }

  function scrollDown(force) {
    const box = el.transcript;
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    if (force || near) {
      requestAnimationFrame(function () {
        box.scrollTop = box.scrollHeight;
      });
    }
  }

  /* ============================================================
     Состояние интерфейса
     ============================================================ */

  function setConn(state, text) {
    document.body.dataset.conn = state;
    el.statusText.textContent = text;
  }

  function setCore(state, hint) {
    document.body.dataset.state = state;
    const labels = {
      offline: "ОФФЛАЙН",
      connecting: "ПОДКЛЮЧЕНИЕ",
      idle: "В СЕТИ",
      wake: "ОЖИДАНИЕ",
      listening: "СЛУШАЮ",
      thinking: "ОБРАБОТКА",
      speaking: "ОТВЕТ",
      error: "СБОЙ",
    };
    el.coreState.textContent = labels[state] || state.toUpperCase();
    el.coreHint.textContent = hint || "";
  }

  function updateMic() {
    el.btnMic.classList.toggle("active", Voice.listening);
    el.btnMic.title = Voice.listening ? "Остановить прослушивание" : "Говорить (Ctrl+Space)";
  }

  function refreshState() {
    updateMic();
    el.btnStop.hidden = !(app.busy || Voice.speaking);

    if (!app.connected) {
      setCore("offline", "нет связи с OpenCode");
      return;
    }
    if (Voice.speaking) setCore("speaking", "озвучиваю ответ");
    else if (Voice.listening && S.wake) setCore("wake", "скажите «Джарвис»");
    else if (Voice.listening) setCore("listening", "говорите, сэр");
    else if (app.busy) setCore("thinking", "анализирую запрос");
    else setCore("idle", "жду команды");
  }

  function setThinking(on) {
    if (on && !app.thinkingEl) {
      const row = document.createElement("div");
      row.className = "thinking-row";
      row.innerHTML =
        '<span class="dots"><i></i><i></i><i></i></span><span>обработка</span>';
      el.transcript.appendChild(row);
      app.thinkingEl = row;
      scrollDown();
    } else if (!on && app.thinkingEl) {
      app.thinkingEl.remove();
      app.thinkingEl = null;
    }
  }

  /* ============================================================
     Озвучка с очередью
     ============================================================ */

  function speakLater(text, force) {
    if (!text) return;
    if (!S.autoSpeak && !force) return;
    const spoken = shortenForSpeech(text);
    if (!spoken) return;
    speech.queue.push(spoken);
    pumpSpeech();
  }

  function shortenForSpeech(text) {
    /* Убираем разметку и служебные символы: вслух читается только речь. */
    const clean = String(text)
      .replace(/```[\s\S]*?```/g, " Код на экране. ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/~~(.*?)~~/g, "$1")
      .replace(/[|>#]/g, " ")
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) return "";
    if (clean.length <= 480) return clean;

    const sentences = clean.match(/[^.!?…]+[.!?…]+/g) || [];
    let out = "";
    for (let i = 0; i < sentences.length; i++) {
      if ((out + sentences[i]).length > 380) break;
      out += sentences[i];
    }
    if (!out) out = clean.slice(0, 360).trim() + "…";
    return out.trim() + " Подробности на экране, сэр.";
  }

  function pumpSpeech() {
    if (speech.timer) return;
    if (!speech.queue.length) return;
    if (Voice.speaking) {
      speech.timer = setTimeout(function () {
        speech.timer = null;
        pumpSpeech();
      }, 220);
      return;
    }
    const next = speech.queue.shift();
    Voice.speak(next);
    speech.timer = setTimeout(function () {
      speech.timer = null;
      pumpSpeech();
    }, 260);
  }

  function stopSpeech() {
    speech.queue.length = 0;
    clearTimeout(speech.timer);
    speech.timer = null;
    Voice.stopSpeaking();
  }

  /* ============================================================
     Транскрипт
     ============================================================ */

  function showEmpty() {
    if (app.emptyEl) return;
    const box = document.createElement("div");
    box.className = "empty-state";
    box.innerHTML =
      '<div class="es-title">Системы в норме</div>' +
      "<p>Спросите голосом или текстом. Джарвис работает через ваш сервер OpenCode — " +
      "он видит файлы, запускает команды и помнит контекст диалога.</p>" +
      '<div class="chips">' +
      '<button class="chip" data-text="Что ты умеешь?">Что ты умеешь?</button>' +
      '<button class="chip" data-text="Покажи, какие файлы есть в этой папке">Что в папке?</button>' +
      '<button class="chip" data-text="Который сейчас час?">Который час?</button>' +
      '<button class="chip" data-text="Расскажи коротко, кто ты">Кто ты?</button>' +
      "</div>";
    el.transcript.appendChild(box);
    app.emptyEl = box;

    box.querySelectorAll(".chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        send(chip.dataset.text);
      });
    });
  }

  function hideEmpty() {
    if (app.emptyEl) {
      app.emptyEl.remove();
      app.emptyEl = null;
    }
  }

  function clearTranscript() {
    el.transcript.innerHTML = "";
    app.bubbles.clear();
    app.segments.clear();
    app.tools.clear();
    app.thinkingEl = null;
    showEmpty();
  }

  function appendUser(text) {
    hideEmpty();
    const wrap = document.createElement("article");
    wrap.className = "msg user";
    const time = new Date().toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    });
    wrap.innerHTML =
      '<div class="msg-meta"><span>' +
      time +
      '</span><span class="meta-dot"></span>ВЫ</div>' +
      '<div class="msg-body"><div class="msg-text"></div></div>';
    wrap.querySelector(".msg-text").textContent = text;
    el.transcript.appendChild(wrap);
    scrollDown(true);
  }

  function assistantBubble(id) {
    let bubble = app.bubbles.get(id);
    if (bubble) return bubble;

    hideEmpty();
    const wrap = document.createElement("article");
    wrap.className = "msg assistant";
    wrap.innerHTML =
      '<div class="msg-meta"><span class="meta-dot"></span>J.A.R.V.I.S.</div>' +
      '<div class="msg-body"></div>';
    el.transcript.appendChild(wrap);
    bubble = { wrap: wrap, body: wrap.querySelector(".msg-body") };
    app.bubbles.set(id, bubble);
    return bubble;
  }

  function segmentFor(messageID, ordinal) {
    const key = messageID + ":" + ordinal;
    let seg = app.segments.get(key);
    if (seg) return seg;

    const bubble = assistantBubble(messageID);
    seg = document.createElement("div");
    seg.className = "msg-text";
    bubble.body.appendChild(seg);
    app.segments.set(key, seg);
    return seg;
  }

  function appendDelta(messageID, ordinal, delta) {
    const seg = segmentFor(messageID, ordinal);
    seg.textContent += delta;
    scrollDown();
  }

  function finishSegment(messageID, ordinal, text) {
    const seg = segmentFor(messageID, ordinal);
    const finalText = typeof text === "string" ? text : seg.textContent;
    renderMarkdown(seg, finalText);
    scrollDown();
    if (finalText && finalText.trim().length > 1) speakLater(finalText);
  }

  function addErrorBubble(message) {
    hideEmpty();
    const wrap = document.createElement("article");
    wrap.className = "msg assistant error";
    wrap.innerHTML =
      '<div class="msg-meta"><span class="meta-dot"></span>СИСТЕМА</div>' +
      '<div class="msg-body"><div class="msg-text"></div></div>';
    wrap.querySelector(".msg-text").textContent = message;
    el.transcript.appendChild(wrap);
    scrollDown(true);
    speakLater("Сэр, произошёл сбой. " + message);
  }

  function addToolChip(callID, input) {
    if (!callID) callID = "tool-" + Math.random().toString(36).slice(2);

    const current = app.bubbles.get(app.lastAssistantID || "");
    let host = current ? current.body : null;

    const chip = document.createElement("div");
    chip.className = "tool";

    let detail = "";
    let name = "инструмент";

    if (input && typeof input === "object") {
      if (typeof input.command === "string") {
        name = "shell";
        detail = input.command;
      } else if (typeof input.filePath === "string" || typeof input.path === "string") {
        name = "файл";
        detail = input.filePath || input.path;
      } else if (typeof input.pattern === "string") {
        name = "поиск";
        detail = input.pattern;
      } else if (typeof input.query === "string") {
        name = "запрос";
        detail = input.query;
      } else if (typeof input.description === "string") {
        name = "задача";
        detail = input.description;
      } else if (typeof input.url === "string") {
        name = "ссылка";
        detail = input.url;
      } else {
        detail = Object.keys(input).slice(0, 3).join(", ");
      }
    }

    if (detail.length > 110) detail = detail.slice(0, 107) + "…";

    chip.innerHTML =
      '<span class="tool-icon"></span>' +
      '<span class="tool-text"><span class="tool-name">' +
      escapeHtml(name) +
      "</span> " +
      escapeHtml(detail) +
      "</span>";

    if (host) host.appendChild(chip);
    else {
      hideEmpty();
      el.transcript.appendChild(chip);
    }

    app.tools.set(callID, chip);
    scrollDown();
  }

  function finishTool(callID, ok) {
    const chip = app.tools.get(callID);
    if (!chip) return;
    chip.classList.add(ok ? "done" : "failed");
  }

  function renderMarkdown(node, text) {
    const blocks = [];
    let src = String(text).replace(/```([a-zA-Z0-9+#._-]*)\n?([\s\S]*?)```/g, function (_, lang, code) {
      blocks.push({ lang: lang, code: code.replace(/\n$/, "") });
      return "\u0000B" + (blocks.length - 1) + "\u0000";
    });

    src = escapeHtml(src);

    const codes = [];
    src = src.replace(/`([^`\n]+)`/g, function (_, code) {
      codes.push(code);
      return "\u0000C" + (codes.length - 1) + "\u0000";
    });

    src = src
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
      );

    /* Блочная разметка: абзацы, заголовки и списки собираются построчно,
       чтобы <br> не попадали внутрь <ul>. */
    const out = [];
    let para = [];
    let list = null;

    function flushPara() {
      if (!para.length) return;
      out.push("<p>" + para.join("<br>") + "</p>");
      para = [];
    }

    function flushList() {
      if (!list) return;
      out.push(
        "<ul>" +
          list
            .map(function (item) {
              return "<li>" + item + "</li>";
            })
            .join("") +
          "</ul>"
      );
      list = null;
    }

    src.split(/\r?\n/).forEach(function (line) {
      const trimmed = line.trim();
      if (!trimmed) {
        flushPara();
        flushList();
        return;
      }

      const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        flushPara();
        flushList();
        const level = heading[1].length;
        out.push("<h" + level + ">" + heading[2] + "</h" + level + ">");
        return;
      }

      if (/^\u0000B\d+\u0000$/.test(trimmed)) {
        flushPara();
        flushList();
        out.push(trimmed);
        return;
      }

      const item = trimmed.match(/^(?:[-*•]|\d+\.)\s+(.+)$/);
      if (item) {
        flushPara();
        if (!list) list = [];
        list.push(item[1]);
        return;
      }

      if (list) flushList();
      para.push(trimmed);
    });

    flushPara();
    flushList();
    src = out.join("");

    src = src.replace(/\u0000C(\d+)\u0000/g, function (_, i) {
      return "<code>" + escapeHtml(codes[Number(i)]) + "</code>";
    });

    src = src.replace(/\u0000B(\d+)\u0000/g, function (_, i) {
      const block = blocks[Number(i)];
      return "<pre><code>" + escapeHtml(block.code) + "</code></pre>";
    });

    node.innerHTML = src;
  }

  /* ============================================================
     OpenCode: подключение и события
     ============================================================ */

  function parseModel(value) {
    if (!value) return null;
    const idx = value.indexOf("|");
    if (idx === -1) return null;
    return { providerID: value.slice(0, idx), id: value.slice(idx + 1) };
  }

  async function syncDesktopConfig() {
    const payload = {};
    if (/^https?:\/\//i.test(S.baseUrl || "")) payload.opencodeUrl = S.baseUrl;
    if (!Object.keys(payload).length) return;
    try {
      await fetch("/app/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (_) {}
  }

  let connectRetries = 0;
  let connectRetryTimer = null;

  async function connect(opts) {
    opts = opts || {};
    setConn("connecting", "Подключение…");
    if (!app.connected) setCore("connecting", "проверяю канал");

    await syncDesktopConfig();
    OC.setConfig({ baseUrl: S.baseUrl });

    try {
      const info = await OC.info();
      app.info = info || {};
      app.connected = true;
      app.lastPing = Date.now();
      connectRetries = 0;

      setConn("online", connOnlineLabel());
      el.aboutInfo.textContent =
        "версия OpenCode: " + ((app.info && app.info.version) || "—");

      if (app.sub) app.sub.stop();
      app.sub = OC.subscribe({ onEvent: handleEvent, onStatus: onStreamStatus });

      await loadCatalog();
      await restoreSession();
      refreshState();

      if (!opts.silent) toast("Связь с OpenCode установлена", "good");
      return true;
    } catch (err) {
      app.connected = false;
      setConn("offline", "Нет связи");
      setCore("offline", "запускаю сервер OpenCode…");

      /* Сервер может ещё подниматься — повторяем попытки. */
      if (connectRetries < 15) {
        connectRetries += 1;
        clearTimeout(connectRetryTimer);
        connectRetryTimer = setTimeout(function () {
          connect({ silent: true });
        }, 2000);
      }

      if (!opts.silent) {
        toast(
          "Не удалось подключиться к OpenCode. Сервер запускается автоматически — подождите немного.",
          "bad"
        );
      }
      return false;
    }
  }

  function connOnlineLabel() {
    const version = (app.info && app.info.version) || "";
    return version ? "В сети · " + version : "В сети";
  }

  function onStreamStatus(status) {
    if (status === "open") {
      app.lastPing = Date.now();
      if (app.connected) setConn("online", connOnlineLabel());
    } else if (status === "error" && app.connected) {
      setConn("connecting", "Переподключение…");
    }
  }

  async function loadCatalog() {
    let models = [];
    let agents = [];
    try {
      models = await OC.models();
    } catch (_) {}
    try {
      agents = await OC.agents();
    } catch (_) {}

    app.models = models || [];
    app.agents = agents || [];
    populateModels();
    populateAgents();

    /* Проверяем сохранённые выборы */
    if (S.model && !app.models.some(function (m) { return modelValue(m) === S.model; })) {
      S.model = "";
      saveSettings();
    }
    if (S.agent && !app.agents.some(function (a) { return a.id === S.agent; })) {
      const wanted = S.agent;
      S.agent = "";
      saveSettings();
      if (wanted === "jarvis") {
        toast(
          "Агент «jarvis» не найден — перезапустите лаунчер, он установит его автоматически.",
          "warn"
        );
      }
    }
    el.setAgent.value = S.agent;
    el.setModel.value = S.model;
  }

  function modelValue(m) {
    return (m.providerID || "") + "|" + (m.modelID || m.id || "");
  }

  function populateModels() {
    const select = el.setModel;
    select.innerHTML = '<option value="">По умолчанию (настройки OpenCode)</option>';

    const groups = new Map();
    app.models.forEach(function (m) {
      const provider = m.providerID || "other";
      if (!groups.has(provider)) groups.set(provider, []);
      groups.get(provider).push(m);
    });

    Array.from(groups.keys())
      .sort()
      .forEach(function (provider) {
        const group = document.createElement("optgroup");
        group.label = provider;
        groups
          .get(provider)
          .slice()
          .sort(function (a, b) {
            return (a.name || a.id || "").localeCompare(b.name || b.id || "");
          })
          .forEach(function (m) {
            const option = document.createElement("option");
            option.value = modelValue(m);
            option.textContent = m.name || m.modelID || m.id;
            group.appendChild(option);
          });
        select.appendChild(group);
      });
  }

  function populateAgents() {
    const select = el.setAgent;
    select.innerHTML = '<option value="">По умолчанию</option>';
    app.agents
      .filter(function (a) {
        return !a.hidden && a.mode !== "subagent";
      })
      .sort(function (a, b) {
        return (a.name || a.id).localeCompare(b.name || b.id);
      })
      .forEach(function (a) {
        const option = document.createElement("option");
        option.value = a.id;
        option.textContent = a.name || a.id;
        select.appendChild(option);
      });
  }

  async function restoreSession() {
    const saved = localStorage.getItem(LS_SESSION);
    if (saved) {
      try {
        const session = await OC.getSession(saved);
        if (session && session.id) {
          app.sessionID = session.id;
          updateSessionInfo();
          await loadHistory();
          await checkPendingPermissions();
          return;
        }
      } catch (_) {
        localStorage.removeItem(LS_SESSION);
      }
    }
    app.sessionID = null;
    updateSessionInfo();
    showEmpty();
  }

  async function ensureSession(force) {
    if (app.sessionID && !force) return app.sessionID;

    const base = {
      directory: S.directory || undefined,
      agent: S.agent || undefined,
      title: "Джарвис — " + new Date().toLocaleString("ru-RU"),
    };
    const model = parseModel(S.model);

    let session;
    try {
      session = await OC.createSession(Object.assign({ model: model || undefined }, base));
    } catch (err) {
      if (model) {
        /* модель могла быть недоступна в этой папке — пробуем без неё */
        session = await OC.createSession(base);
      } else {
        throw err;
      }
    }

    app.sessionID = session.id;
    localStorage.setItem(LS_SESSION, session.id);
    updateSessionInfo();
    return session.id;
  }

  function updateSessionInfo() {
    if (app.sessionID) {
      el.sessionHint.textContent = "сеанс " + app.sessionID.slice(-8);
      el.sessionInfo.textContent = "Активный сеанс: " + app.sessionID;
    } else {
      el.sessionHint.textContent = "";
      el.sessionInfo.textContent = "Сеанс ещё не создан — он появится после первого запроса.";
    }
  }

  async function loadHistory() {
    clearTranscript();
    if (!app.sessionID) {
      showEmpty();
      return;
    }

    let messages = [];
    try {
      messages = await OC.messages(app.sessionID, 80);
    } catch (_) {
      return;
    }

    messages.forEach(function (m) {
      if (!m || !m.type) return;

      if (m.type === "user" && m.text) {
        appendUser(m.text);
      } else if (m.type === "assistant") {
        app.lastAssistantID = m.id;
        (m.content || []).forEach(function (part, index) {
          if (!part) return;
          if (part.type === "text" && typeof part.text === "string") {
            const seg = segmentFor(m.id, index);
            renderMarkdown(seg, part.text);
          } else if (part.type === "tool") {
            addToolChip(part.id || m.id + "-tool-" + index, part.input || {});
            finishTool(part.id || m.id + "-tool-" + index, part.state === "completed");
          }
        });
      }
    });

    if (!messages.length) showEmpty();
    scrollDown(true);
  }

  async function checkPendingPermissions() {
    if (!app.sessionID) return;
    try {
      const list = await OC.permissions(app.sessionID);
      if (list && list.length) showPermission(list[0]);
    } catch (_) {}
  }

  /* ============================================================
     События OpenCode
     ============================================================ */

  function handleEvent(ev) {
    if (!ev || !ev.type) return;
    const data = ev.data || {};

    if (data.sessionID && data.sessionID !== app.sessionID) return;

    switch (ev.type) {
      case "session.execution.started":
        app.busy = true;
        setThinking(true);
        refreshState();
        break;

      case "session.text.started":
        setThinking(false);
        app.lastAssistantID = data.assistantMessageID;
        segmentFor(data.assistantMessageID, data.ordinal);
        break;

      case "session.text.delta":
        setThinking(false);
        appendDelta(data.assistantMessageID, data.ordinal, data.delta || "");
        break;

      case "session.text.ended":
        setThinking(false);
        app.lastAssistantID = data.assistantMessageID;
        finishSegment(data.assistantMessageID, data.ordinal, data.text);
        break;

      case "session.tool.called":
        setThinking(false);
        addToolChip(data.id, data.input);
        break;

      case "session.tool.success":
        finishTool(data.id, true);
        break;

      case "session.tool.failed":
        finishTool(data.id, false);
        break;

      case "session.execution.succeeded":
        app.busy = false;
        setThinking(false);
        refreshState();
        break;

      case "session.execution.failed":
        app.busy = false;
        setThinking(false);
        addErrorBubble(
          (data.error && (data.error.message || data.error.type)) || "Не удалось выполнить запрос."
        );
        refreshState();
        break;

      case "session.execution.interrupted":
        app.busy = false;
        setThinking(false);
        refreshState();
        break;

      case "session.idle":
        app.busy = false;
        setThinking(false);
        refreshState();
        break;

      case "session.retry.scheduled":
        addToolChip("retry-" + ev.id, { description: "повтор запроса к модели" });
        break;

      case "permission.asked":
        showPermission(data);
        break;

      case "session.inbox.delivered":
        break;
    }
  }

  /* ============================================================
     Отправка
     ============================================================ */

  async function send(rawText) {
    const text = (rawText || "").trim();
    if (!text) return;

    if (!app.connected) {
      toast("Нет связи с OpenCode. Проверьте настройки.", "bad");
      openDrawer();
      return;
    }

    if (handleLocalCommand(text)) return;

    el.input.value = "";
    el.input.dispatchEvent(new Event("input"));
    el.interim.hidden = true;

    appendUser(text);
    app.busy = true;
    setThinking(true);
    refreshState();

    try {
      await ensureSession();
      try {
        await OC.prompt(app.sessionID, text);
      } catch (err) {
        if (err && err.status === 404) {
          app.sessionID = null;
          await ensureSession(true);
          await OC.prompt(app.sessionID, text);
        } else {
          throw err;
        }
      }
    } catch (err) {
      app.busy = false;
      setThinking(false);
      const message =
        err && err.status === 401
          ? "OpenCode отклонил запрос (401). Проверьте адрес сервера в настройках."
          : err && err.status === 409
          ? "Сервер занят другим запросом. Попробуйте ещё раз."
          : "Не удалось отправить запрос: " + (err && err.message ? err.message : "ошибка");
      addErrorBubble(message);
      refreshState();
    }
  }

  function handleLocalCommand(text) {
    const t = text.toLowerCase().trim();
    /* \b в JS не работает для кириллицы, поэтому проверяем конец слова явно */
    const END = "(?:$|[^a-zа-яё0-9])";

    if (new RegExp("^(стоп|остановись|остановить|хватит|замолчи|тихо)" + END).test(t)) {
      stopEverything();
      return true;
    }
    if (new RegExp("^(новый диалог|новый разговор|начни заново|новый сеанс)" + END).test(t)) {
      newSession();
      return true;
    }
    if (new RegExp("^(настройки|открой настройки)" + END).test(t)) {
      openDrawer();
      return true;
    }
    if (new RegExp("^(очисти экран|очистить экран)" + END).test(t)) {
      clearTranscript();
      return true;
    }
    if (new RegExp("^(история|покажи историю)" + END).test(t)) {
      openHistory();
      return true;
    }
    if (new RegExp("^тише" + END).test(t)) {
      S.rate = Math.max(0.6, Number((S.rate - 0.1).toFixed(2)));
      saveSettings();
      applySettingsToForm();
      Voice.rate = S.rate;
      toast("Скорость речи: " + S.rate.toFixed(2), "good");
      return true;
    }
    if (new RegExp("^(громче|быстрее)" + END).test(t)) {
      S.rate = Math.min(1.6, Number((S.rate + 0.1).toFixed(2)));
      saveSettings();
      applySettingsToForm();
      Voice.rate = S.rate;
      toast("Скорость речи: " + S.rate.toFixed(2), "good");
      return true;
    }
    return false;
  }

  function stopEverything() {
    stopSpeech();
    if (app.sessionID && app.busy) {
      OC.interrupt(app.sessionID).catch(function () {});
    }
    app.busy = false;
    setThinking(false);
    refreshState();
  }

  async function newSession() {
    stopSpeech();
    app.busy = false;
    setThinking(false);
    app.sessionID = null;
    localStorage.removeItem(LS_SESSION);
    clearTranscript();
    updateSessionInfo();
    refreshState();
    speakLater("Новый диалог, сэр.");
    try {
      await ensureSession(true);
      toast("Новый диалог создан", "good");
    } catch (err) {
      toast("Не удалось создать диалог: " + (err.message || "ошибка"), "bad");
    }
  }

  /* ============================================================
     Разрешения
     ============================================================ */

  function showPermission(request) {
    if (!request || !request.id) return;
    app.pendingPerm = request;
    el.permAction.textContent =
      request.message || "Джарвис хочет выполнить действие: " + request.action;
    el.permRes.textContent = (request.resources || []).join("\n");
    el.perm.hidden = false;
    Voice.cue("wake");
    speakLater(
      "Сэр, требуется подтверждение. " + request.action + ". " + (request.resources || []).slice(0, 2).join(", "),
      true
    );
  }

  async function replyPermission(decision) {
    const request = app.pendingPerm;
    if (!request) return;
    app.pendingPerm = null;
    el.perm.hidden = true;

    try {
      await OC.replyPermission(request.sessionID || app.sessionID, request.id, decision);
      if (decision === "reject") speakLater("Отклонено, сэр.", true);
    } catch (err) {
      toast("Не удалось ответить на запрос: " + (err.message || "ошибка"), "bad");
    }
  }

  /* ============================================================
     Панели
     ============================================================ */

  function openScrim() {
    el.scrim.hidden = false;
  }

  function closeScrim() {
    el.scrim.hidden = true;
  }

  function openDrawer() {
    el.drawer.classList.add("open");
    el.drawer.setAttribute("aria-hidden", "false");
    openScrim();
  }

  function closeDrawer() {
    el.drawer.classList.remove("open");
    el.drawer.setAttribute("aria-hidden", "true");
    if (!el.historyPanel.classList.contains("open")) closeScrim();
  }

  async function openHistory() {
    el.historyPanel.classList.add("open");
    el.historyPanel.setAttribute("aria-hidden", "false");
    openScrim();
    el.historyList.innerHTML = '<div class="empty-note">Загрузка…</div>';

    try {
      const list = await OC.sessions(30);
      el.historyList.innerHTML = "";

      if (!list.length) {
        el.historyList.innerHTML = '<div class="empty-note">История пуста.</div>';
        return;
      }

      list.forEach(function (session) {
        const item = document.createElement("button");
        item.type = "button";
        item.className =
          "history-item" + (session.id === app.sessionID ? " current" : "");
        const title = session.title || "Без названия";
        item.innerHTML =
          '<span class="hi-title">' +
          escapeHtml(title) +
          '</span><span class="hi-meta"><span>' +
          escapeHtml(session.agent || "build") +
          "</span><span>" +
          relTime(session.time && (session.time.updated || session.time.created)) +
          "</span></span>";
        item.addEventListener("click", async function () {
          app.sessionID = session.id;
          localStorage.setItem(LS_SESSION, session.id);
          updateSessionInfo();
          closeHistory();
          await loadHistory();
          await checkPendingPermissions();
          refreshState();
        });
        el.historyList.appendChild(item);
      });
    } catch (err) {
      el.historyList.innerHTML =
        '<div class="empty-note">Не удалось загрузить историю: ' +
        escapeHtml(err.message || "ошибка") +
        "</div>";
    }
  }

  function closeHistory() {
    el.historyPanel.classList.remove("open");
    el.historyPanel.setAttribute("aria-hidden", "true");
    if (!el.drawer.classList.contains("open")) closeScrim();
  }

  function closeAllPanels() {
    closeDrawer();
    closeHistory();
    closeScrim();
  }

  /* ============================================================
     Голос
     ============================================================ */

  function initVoice() {
    if (!Voice.supported) {
      el.btnMic.disabled = true;
      el.btnMic.title = "Браузер не поддерживает распознавание речи";
    }

    Voice.onResult = function (text) {
      if (!text) return;
      if (S.cues) Voice.cue("start");
      send(text);
    };

    Voice.onInterim = function (text) {
      if (text) {
        el.interim.textContent = text;
        el.interim.hidden = false;
      } else {
        el.interim.hidden = true;
      }
    };

    Voice.onState = function () {
      refreshState();
      if (!Voice.listening) el.interim.hidden = true;
    };

    Voice.onError = function (message) {
      toast(message, "bad");
    };

    Voice.onWake = function () {
      el.interim.textContent = "Слушаю…";
      el.interim.hidden = false;
    };

    window.addEventListener("jarvis:voices", populateVoices);
    window.addEventListener("jarvis:tts", populateTtsVoices);
    populateVoices();
    populateTtsVoices();

    Voice.checkServer().then(function (available) {
      if (!available && S.ttsEngine === "neural") {
        toast("Нейроголос недоступен — используется голос браузера", "warn");
      }
    });
  }

  function populateTtsVoices() {
    const select = el.setTtsVoice;
    if (!select) return;

    const current = S.ttsVoice || "auto";
    select.innerHTML = '<option value="auto">Авто (по языку)</option>';

    const labels = {
      "ru-RU-DmitryNeural": "Дмитрий — русский мужской",
      "ru-RU-SvetlanaNeural": "Светлана — русский женский",
      "en-GB-RyanNeural": "Ryan — английский (Jarvis)",
    };

    Voice.serverVoices.forEach(function (name) {
      if (!name || name === "auto") return;
      const option = document.createElement("option");
      option.value = name;
      option.textContent = labels[name] || name;
      select.appendChild(option);
    });

    select.value = current;
    if (select.value !== current) select.value = "auto";
  }

  function populateVoices() {
    const select = el.setVoice;
    const current = S.voice;
    select.innerHTML = '<option value="">Авто (по языку)</option>';

    Voice.voices().forEach(function (voice) {
      const option = document.createElement("option");
      option.value = voice.name;
      option.textContent = voice.name + " · " + voice.lang;
      select.appendChild(option);
    });

    select.value = current || "";
    if (select.value !== current) {
      select.value = "";
      S.voice = "";
      saveSettings();
    }
  }

  /* ============================================================
     Настройки: обработчики
     ============================================================ */

  let reconnectTimer = null;

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(function () {
      if (app.sub) app.sub.stop();
      app.sub = null;
      connect({ silent: true });
    }, 700);
  }

  function bindSettings() {
    el.setUrl.addEventListener("input", function () {
      S.baseUrl = el.setUrl.value.trim() || "/oc";
      saveSettings();
      scheduleReconnect();
    });

    el.setDir.addEventListener("input", function () {
      S.directory = el.setDir.value.trim();
      saveSettings();
      toast("Папка применится к новому диалогу", "warn");
    });

    el.setModel.addEventListener("change", function () {
      S.model = el.setModel.value;
      saveSettings();
      toast("Модель применится к новому диалогу", "warn");
    });

    el.setAgent.addEventListener("change", function () {
      S.agent = el.setAgent.value;
      saveSettings();
      toast("Агент применится к новому диалогу", "warn");
    });

    el.setLang.addEventListener("change", function () {
      S.lang = el.setLang.value;
      saveSettings();
      Voice.setLang(S.lang);
      populateVoices();
    });

    el.setVoice.addEventListener("change", function () {
      S.voice = el.setVoice.value;
      saveSettings();
      Voice.voiceName = S.voice;
    });

    el.setTtsEngine.addEventListener("change", function () {
      S.ttsEngine = el.setTtsEngine.value;
      saveSettings();
      Voice.engine = S.ttsEngine;
      if (S.ttsEngine === "neural" && !Voice.neural) {
        toast("Нейроголос не найден — будет использован голос браузера", "warn");
      }
    });

    el.setTtsVoice.addEventListener("change", function () {
      S.ttsVoice = el.setTtsVoice.value;
      saveSettings();
      Voice.serverVoice = S.ttsVoice;
    });

    el.setRate.addEventListener("input", function () {
      S.rate = Number(el.setRate.value);
      el.rateOut.textContent = S.rate.toFixed(2).replace(/0$/, "");
      Voice.rate = S.rate;
      saveSettings();
    });

    el.setAutoSpeak.addEventListener("change", function () {
      S.autoSpeak = el.setAutoSpeak.checked;
      saveSettings();
      if (!S.autoSpeak) stopSpeech();
    });

    el.setWake.addEventListener("change", function () {
      S.wake = el.setWake.checked;
      saveSettings();
      el.wakeHint.hidden = !S.wake;
      if (S.wake) {
        if (!app.connected) {
          toast("Сначала подключитесь к OpenCode", "warn");
          S.wake = false;
          el.setWake.checked = false;
          el.wakeHint.hidden = true;
          saveSettings();
          return;
        }
        Voice.setWake(true);
        toast("Режим «Джарвис» включён. Скажите: «Джарвис, …»", "good");
      } else {
        Voice.setWake(false);
      }
      refreshState();
    });

    el.setCues.addEventListener("change", function () {
      S.cues = el.setCues.checked;
      saveSettings();
    });

    el.btnTest.addEventListener("click", async function () {
      el.connNote.textContent = "проверяю…";
      el.connNote.className = "conn-note";
      OC.setConfig({ baseUrl: S.baseUrl });
      try {
        const info = await OC.info();
        el.connNote.textContent = "OK · версия " + ((info && info.version) || "?");
        el.connNote.className = "conn-note ok";
        connect({ silent: true });
      } catch (err) {
        el.connNote.textContent = "нет связи — сервер запускается";
        el.connNote.className = "conn-note bad";
      }
    });

    el.btnVoiceTest.addEventListener("click", function () {
      Voice.cue("start");
      Voice.speak("Все системы в норме, сэр. К вашим услугам.");
    });

    el.btnNew.addEventListener("click", function () {
      newSession();
      closeDrawer();
    });

    el.btnClear.addEventListener("click", function () {
      clearTranscript();
      closeDrawer();
    });

    el.btnReset.addEventListener("click", function () {
      if (!confirm("Сбросить все настройки и историю сеанса?")) return;
      localStorage.removeItem(LS_SETTINGS);
      localStorage.removeItem(LS_SESSION);
      location.reload();
    });
  }

  /* ============================================================
     Прочие обработчики
     ============================================================ */

  function bindUi() {
    el.composer.addEventListener("submit", function (event) {
      event.preventDefault();
      send(el.input.value);
    });

    el.input.addEventListener("input", function () {
      el.btnSend.disabled = !el.input.value.trim();
    });

    el.btnMic.addEventListener("click", function () {
      if (!app.connected) {
        toast("Нет связи с OpenCode", "bad");
        return;
      }
      if (!Voice.supported) {
        toast("Браузер не поддерживает распознавание речи. Откройте в Chrome или Edge.", "bad");
        return;
      }
      if (Voice.listening) {
        Voice.stop();
      } else {
        stopSpeech();
        Voice.start();
        if (S.cues) Voice.cue("start");
      }
      refreshState();
    });

    el.btnStop.addEventListener("click", stopEverything);

    el.btnSettings.addEventListener("click", openDrawer);
    el.btnHistory.addEventListener("click", openHistory);
    el.btnCloseDrawer.addEventListener("click", closeDrawer);
    el.btnCloseHistory.addEventListener("click", closeHistory);
    el.scrim.addEventListener("click", closeAllPanels);

    el.statusBtn.addEventListener("click", function () {
      if (app.connected) {
        openDrawer();
        el.btnTest.click();
      } else {
        connect();
      }
    });

    el.perm.querySelectorAll("[data-decision]").forEach(function (button) {
      button.addEventListener("click", function () {
        replyPermission(button.dataset.decision);
      });
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        if (!el.perm.hidden) {
          replyPermission("reject");
        } else {
          closeAllPanels();
        }
      }

      if ((event.ctrlKey || event.metaKey) && event.code === "Space") {
        event.preventDefault();
        el.btnMic.click();
      }
    });

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && !app.connected) {
        connect({ silent: true });
      }
    });

    window.addEventListener("online", function () {
      if (!app.connected) connect({ silent: true });
    });

    if (!("ontouchstart" in window)) {
      setTimeout(function () {
        el.input.focus();
      }, 400);
    }
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol === "file:") return;
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }

  /* ============================================================
     Старт
     ============================================================ */

  function init() {
    loadSettings();
    applySettingsToForm();
    applyVoiceSettings();
    bindUi();
    bindSettings();
    initVoice();
    registerServiceWorker();

    el.btnSend.disabled = true;
    showEmpty();
    setConn("connecting", "Подключение…");
    setCore("connecting", "проверяю канал");

    connect({ silent: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
