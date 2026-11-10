/* ============================================================
   J.A.R.V.I.S. — клиент HTTP API OpenCode
   ============================================================ */
(function (global) {
  "use strict";

  const cfg = {
    baseUrl: "/oc",
  };

  function setConfig(next) {
    if (typeof next.baseUrl === "string") cfg.baseUrl = next.baseUrl;
  }

  function resolveBase() {
    const raw = (cfg.baseUrl || "").trim();
    if (!raw) return location.origin + "/oc";
    if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, "");
    if (raw.startsWith("/")) return (location.origin + raw).replace(/\/+$/, "");
    return raw.replace(/\/+$/, "");
  }

  function parseJson(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  async function request(path, opts) {
    opts = opts || {};
    const url = resolveBase() + path;
    const headers = Object.assign(
      { Accept: "application/json" },
      opts.headers || {}
    );
    let body;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    let res;
    try {
      res = await fetch(url, {
        method: opts.method || "GET",
        headers: headers,
        body: body,
        signal: opts.signal,
        cache: "no-store",
        credentials: "omit",
      });
    } catch (err) {
      const e = new Error("Нет связи с OpenCode");
      e.network = true;
      e.cause = err;
      throw e;
    }

    if (res.status === 204) return null;

    const text = await res.text();
    const json = parseJson(text);

    if (!res.ok) {
      const message =
        (json && (json.message || json.error || json.type)) ||
        "HTTP " + res.status + (text ? ": " + text.slice(0, 200) : "");
      const e = new Error(message);
      e.status = res.status;
      e.body = json || text;
      throw e;
    }

    return json;
  }

  function unwrap(json) {
    if (json && typeof json === "object" && "data" in json) return json.data;
    return json;
  }

  /* ---------- endpoints ---------- */

  async function info() {
    return unwrap(await request("/api/info"));
  }

  async function models() {
    const j = await request("/api/model");
    return (j && j.data) || [];
  }

  async function defaultModel() {
    const j = await request("/api/model/default");
    return (j && j.data) || null;
  }

  async function agents() {
    const j = await request("/api/agent");
    return (j && j.data) || [];
  }

  async function sessions(limit) {
    const j = await request("/api/session?limit=" + (limit || 30) + "&order=desc");
    return (j && j.data) || [];
  }

  async function getSession(id) {
    return unwrap(await request("/api/session/" + encodeURIComponent(id)));
  }

  async function createSession(opts) {
    opts = opts || {};
    const body = {};
    if (opts.directory) body.location = { directory: opts.directory };
    if (opts.model) body.model = opts.model;
    if (opts.agent) body.agent = opts.agent;
    if (opts.title) body.title = opts.title;
    return unwrap(await request("/api/session", { method: "POST", body: body }));
  }

  async function prompt(sessionID, text) {
    return unwrap(
      await request("/api/session/" + encodeURIComponent(sessionID) + "/prompt", {
        method: "POST",
        body: { text: text },
      })
    );
  }

  async function interrupt(sessionID) {
    return unwrap(
      await request("/api/session/" + encodeURIComponent(sessionID) + "/interrupt", {
        method: "POST",
      })
    );
  }

  async function messages(sessionID, limit) {
    const j = await request(
      "/api/session/" +
        encodeURIComponent(sessionID) +
        "/message?limit=" +
        (limit || 80) +
        "&order=asc"
    );
    return (j && j.data) || [];
  }

  async function permissions(sessionID) {
    const j = await request("/api/session/" + encodeURIComponent(sessionID) + "/permission");
    return (j && j.data) || [];
  }

  async function replyPermission(sessionID, requestID, decision) {
    return request(
      "/api/session/" +
        encodeURIComponent(sessionID) +
        "/permission/" +
        encodeURIComponent(requestID) +
        "/reply",
      { method: "POST", body: { decision: decision } }
    );
  }

  /* ---------- event stream ---------- */

  function parseFrame(frame) {
    let name = "";
    const dataLines = [];
    frame.split(/\r?\n/).forEach(function (line) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    });
    if (!dataLines.length) return null;

    const raw = dataLines.join("\n");
    let ev = parseJson(raw);
    if (typeof ev === "string") ev = parseJson(ev);
    if (!ev || typeof ev !== "object") return null;
    if (!ev.type && name) ev.type = name;
    return ev;
  }

  /**
   * Подписка на SSE. Автоматически переподключается.
   * @returns {{stop: Function}}
   */
  function subscribe(handlers) {
    const onEvent = handlers.onEvent || function () {};
    const onStatus = handlers.onStatus || function () {};
    const types = handlers.types || null;

    let stopped = false;
    let ctrl = null;
    let attempt = 0;

    function sleep(ms) {
      return new Promise(function (r) {
        setTimeout(r, ms);
      });
    }

    async function loop() {
      while (!stopped) {
        ctrl = new AbortController();
        try {
          onStatus("connecting");
          let url = resolveBase() + "/api/event";
          if (types && types.length) url += "?types=" + encodeURIComponent(types.join(","));

          const res = await fetch(url, {
            headers: { Accept: "text/event-stream" },
            signal: ctrl.signal,
            cache: "no-store",
          });

          if (!res.ok) {
            const err = new Error("HTTP " + res.status);
            err.status = res.status;
            throw err;
          }

          onStatus("open");
          attempt = 0;

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (!stopped) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });

            let idx;
            while ((idx = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              const ev = parseFrame(frame);
              if (ev) {
                try {
                  onEvent(ev);
                } catch (e) {
                  console.error("event handler", e);
                }
              }
            }
          }
        } catch (err) {
          if (stopped) return;
          onStatus("error", err);
        }

        if (stopped) return;
        attempt += 1;
        await sleep(Math.min(900 * attempt, 7000));
      }
    }

    loop();

    return {
      stop: function () {
        stopped = true;
        if (ctrl) ctrl.abort();
      },
    };
  }

  global.OC = {
    setConfig: setConfig,
    resolveBase: resolveBase,
    request: request,
    info: info,
    models: models,
    defaultModel: defaultModel,
    agents: agents,
    sessions: sessions,
    getSession: getSession,
    createSession: createSession,
    prompt: prompt,
    interrupt: interrupt,
    messages: messages,
    permissions: permissions,
    replyPermission: replyPermission,
    subscribe: subscribe,
  };
})(window);
