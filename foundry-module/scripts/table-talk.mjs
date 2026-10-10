/**
 * Table Talk: push-to-talk from Foundry to a Claude Code game master.
 *
 * Every player holds a key (G by default) and talks. Their own browser turns the speech into text,
 * labels it with their assigned character and hands it to the GM's client over the module socket.
 * The GM's client keeps the queue; when the GM sends it, the lines go to the Table Talk channel
 * running inside the GM's Claude Code session (http://127.0.0.1:8796 by default).
 */

const ID = "table-talk";
const SOCKET = `module.${ID}`;
const WHISPER_LIB = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";
const WHISPER_MODEL = "onnx-community/whisper-base";
const SEND_PHRASE = /^\W*(?:(?:ok(?:ay)?|o\.k\.)\W+)?(?:g\.?\s?m|gm|game ?master)\W+send(?:\s+it)?\W*$/i;

const RELEASE_TAIL_MS = 600;

/** A short, quiet tone when the mic is really listening. */
function readyBeep() {
  try {
    const ctx = (readyBeep.ctx ??= new AudioContext());
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.13);
  } catch {}
}

const loc = (key, data) => (data ? game.i18n.format(`TABLETALK.${key}`, data) : game.i18n.localize(`TABLETALK.${key}`));

/* -------------------------------------------- */
/*  Speech-to-text engines                      */
/* -------------------------------------------- */

/** The browser's own recognition (Chrome, Edge, Safari). Instant, nothing to download. */
class BrowserEngine {
  static get Recognition() {
    return globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
  }

  static get supported() {
    return !!this.Recognition;
  }

  #rec = null;
  #finals = [];
  #interim = "";
  #ended = null;
  #holding = false;
  #opts = null;
  error = null;

  /** @param {object} opts
   *  @param {string} opts.lang
   *  @param {(text: string) => void} opts.onInterim
   *  @param {() => void} opts.onReady  called once the browser is really hearing the mic */
  start(opts) {
    this.#finals = [];
    this.#interim = "";
    this.error = null;
    this.#holding = true;
    this.#opts = opts;
    this.#ready = false;
    this.#listen();
  }

  #ready = false;

  /** Some browsers (Chromium, Edge) end recognition at the first pause even in continuous mode.
   *  While the key is still held, start a fresh one and keep adding to what was heard. */
  #listen() {
    const { lang, onInterim, onReady } = this.#opts;
    const rec = new BrowserEngine.Recognition();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let interim = "";
    rec.onresult = event => {
      interim = "";
      for ( let i = event.resultIndex; i < event.results.length; i++ ) {
        const result = event.results[i];
        if ( result.isFinal ) this.#finals.push(result[0].transcript.trim());
        else interim += result[0].transcript;
      }
      this.#interim = interim;
      onInterim?.([...this.#finals, interim].join(" ").trim());
    };
    rec.onerror = event => {
      if ( ["aborted", "no-speech"].includes(event.error) ) return;
      this.error = event.error;
    };
    rec.onaudiostart = () => {
      if ( this.#ready ) return;
      this.#ready = true;
      onReady?.();
    };
    this.#ended = new Promise(resolve => {
      rec.onend = () => {
        // Words still in flight when it ended count as heard.
        if ( interim.trim() ) this.#finals.push(interim.trim());
        interim = "";
        this.#interim = "";
        if ( this.#holding && !this.error && (this.#rec === rec) ) {
          try { this.#listen(); return; } catch {}
        }
        resolve();
      };
    });
    this.#rec = rec;
    rec.start();
  }

  /** @returns {Promise<string>} what was said */
  async stop() {
    this.#holding = false;
    const rec = this.#rec;
    if ( !rec ) return "";
    try { rec.stop(); } catch {}
    // The browser finalises the last words after stop(); give it a moment, then use what we have.
    await Promise.race([this.#ended, new Promise(r => setTimeout(r, 4000))]);
    this.#rec = null;
    return [...this.#finals, this.#interim].join(" ").replace(/\s+/g, " ").trim();
  }

  cancel() {
    this.#holding = false;
    try { this.#rec?.abort(); } catch {}
    this.#rec = null;
  }
}

/**
 * Whisper running inside the browser (transformers.js). Works where the browser has no speech
 * service of its own (Firefox, the Foundry desktop app). One-time model download, cached after.
 */
class WhisperEngine {
  static get supported() {
    return !!(navigator.mediaDevices?.getUserMedia && globalThis.MediaRecorder && globalThis.AudioContext);
  }

  static #pipeline = null;

  /** Load (or reuse) the transcriber. */
  static load(onProgress) {
    this.#pipeline ??= (async () => {
      onProgress?.(0);
      const { pipeline } = await import(WHISPER_LIB);
      const webgpu = !!navigator.gpu && !!(await navigator.gpu.requestAdapter().catch(() => null));
      const files = new Map();
      const progress_callback = p => {
        if ( (p.status !== "progress") || !p.total ) return;
        files.set(p.file, { loaded: p.loaded, total: p.total });
        let loaded = 0, total = 0;
        for ( const f of files.values() ) { loaded += f.loaded; total += f.total; }
        onProgress?.(Math.floor((loaded / total) * 100));
      };
      if ( webgpu ) {
        try {
          return await pipeline("automatic-speech-recognition", WHISPER_MODEL, {
            device: "webgpu", dtype: { encoder_model: "fp32", decoder_model_merged: "q4" }, progress_callback
          });
        } catch (err) {
          console.warn(`${ID} | WebGPU Whisper failed, using WASM`, err);
        }
      }
      return pipeline("automatic-speech-recognition", WHISPER_MODEL, { device: "wasm", dtype: "q8", progress_callback });
    })();
    this.#pipeline.catch(() => (this.#pipeline = null));
    return this.#pipeline;
  }

  #stream = null;
  #recorder = null;
  #chunks = [];
  #lang = "en";
  error = null;

  async start({ lang, onReady }) {
    this.error = null;
    this.#lang = (lang || "en").slice(0, 2).toLowerCase();
    this.#chunks = [];
    try {
      this.#stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
      });
    } catch (err) {
      this.error = err.name === "NotAllowedError" ? "not-allowed" : err.message;
      return;
    }
    this.#recorder = new MediaRecorder(this.#stream);
    this.#recorder.ondataavailable = e => e.data.size && this.#chunks.push(e.data);
    this.#recorder.start(250);
    onReady?.();
  }

  async stop({ onProgress } = {}) {
    const recorder = this.#recorder;
    if ( !recorder ) return "";
    this.#recorder = null;
    const stopped = new Promise(r => (recorder.onstop = r));
    recorder.stop();
    await stopped;
    this.#stream?.getTracks().forEach(t => t.stop());
    this.#stream = null;
    if ( !this.#chunks.length ) return "";

    const blob = new Blob(this.#chunks, { type: recorder.mimeType });
    const ctx = new AudioContext({ sampleRate: 16000 });
    let samples;
    try {
      const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
      samples = audio.getChannelData(0);
    } finally {
      ctx.close();
    }
    if ( samples.length < 16000 * 0.3 ) return "";
    const transcribe = await WhisperEngine.load(onProgress);
    const out = await transcribe(samples, { language: this.#lang, task: "transcribe", chunk_length_s: 30 });
    return cleanWhisper(out?.text ?? "");
  }

  cancel() {
    try { this.#recorder?.stop(); } catch {}
    this.#stream?.getTracks().forEach(t => t.stop());
    this.#recorder = null;
    this.#stream = null;
  }
}

/** Whisper marks silence and noise with tags such as [BLANK_AUDIO] or (wind blowing). */
function cleanWhisper(text) {
  return text.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}

/* -------------------------------------------- */
/*  Talking                                     */
/* -------------------------------------------- */

const talk = {
  engine: null,      // the engine in use for this press
  active: false,
  busy: false,       // transcribing the previous press
  lastLine: null,    // this player's latest line still waiting for the GM
  forceWhisper: false
};

function talkKeyLabel() {
  const binding = game.keybindings.get(ID, "talk")?.[0];
  if ( !binding ) return "G";
  return foundry.applications.sidebar.apps.ControlsConfig?.humanizeBinding?.(binding)
    ?? binding.key.replace(/^Key/, "");
}

function chooseEngine() {
  const pref = game.settings.get(ID, "engine");
  if ( pref === "whisper" || talk.forceWhisper ) return WhisperEngine.supported ? new WhisperEngine() : null;
  if ( BrowserEngine.supported ) return new BrowserEngine();
  if ( pref === "auto" && WhisperEngine.supported ) return new WhisperEngine();
  return null;
}

/** Which speech-to-text this browser will use, shown in the panel so everyone can tell. */
const engineState = { label: "" };

function usingWhisper() {
  const pref = game.settings.get(ID, "engine");
  return (pref === "whisper") || talk.forceWhisper || ((pref === "auto") && !BrowserEngine.supported);
}

function showEngine(text) {
  engineState.label = text;
  panel.engine(text);
}

/** Start the one-time Whisper download straight away, with progress, instead of on first use. */
function preloadWhisper() {
  if ( !usingWhisper() ) return showEngine(loc("EngineBrowser"));
  if ( !WhisperEngine.supported ) return showEngine(loc("NoEngine"));
  showEngine(loc("EngineWhisperLoading", { pct: 0 }));
  WhisperEngine.load(pct => showEngine(loc("EngineWhisperLoading", { pct })))
    .then(() => showEngine(loc("EngineWhisperReady")))
    .catch(err => showEngine(loc("ModelFailed", { error: err.message })));
}

function speechLang() {
  return game.settings.get(ID, "language").trim() || navigator.language || "en-US";
}

async function startTalking() {
  if ( talk.active || talk.busy ) return;
  if ( !window.isSecureContext ) return panel.status(loc("Insecure"), "error");
  const engine = chooseEngine();
  if ( !engine ) return panel.status(loc("NoEngine"), "error");
  talk.engine = engine;
  talk.active = true;
  panel.status(loc("Starting"), "busy");
  window.addEventListener("keyup", onRawKeyUp, true);
  window.addEventListener("blur", stopTalking, { once: true });
  // The mic takes a moment to open; words spoken before then are lost, so say when it's really on.
  const onReady = () => {
    if ( !talk.active || (talk.engine !== engine) ) return;
    panel.talking(true);
    panel.status(loc("Listening"), "live");
    readyBeep();
  };
  await engine.start({ lang: speechLang(), onReady, onInterim: text => text && panel.status(text, "live") });
  if ( engine.error ) {
    talk.active = false;
    panel.talking(false);
    handleEngineError(engine.error);
  }
}

/** Foundry ignores the key-up when Shift or another modifier is held by then; catch it anyway. */
function onRawKeyUp(event) {
  const binding = game.keybindings.get(ID, "talk")?.[0];
  if ( binding && event.code === binding.key ) stopTalking();
}

async function stopTalking() {
  window.removeEventListener("keyup", onRawKeyUp, true);
  if ( !talk.active ) return;
  talk.active = false;
  talk.busy = true;
  // Keep listening a moment after the key comes up so the last word isn't clipped.
  await new Promise(r => setTimeout(r, RELEASE_TAIL_MS));
  panel.talking(false);
  const engine = talk.engine;
  panel.status(loc("Transcribing"), "busy");
  let text = "";
  try {
    text = await engine.stop({
      onProgress: pct => panel.status(loc("ModelLoading", { pct }), "busy")
    });
  } catch (err) {
    console.error(`${ID} |`, err);
    engine.error ??= err.message;
  } finally {
    talk.busy = false;
  }
  if ( engine.error ) return handleEngineError(engine.error);
  if ( !text ) return panel.status(loc("NothingHeard", { key: talkKeyLabel() }), "warn");
  submitLine(text);
}

function handleEngineError(error) {
  if ( error === "not-allowed" ) return panel.status(loc("MicBlocked"), "error");
  if ( error === "no-speech" ) return panel.status(loc("NothingHeard", { key: talkKeyLabel() }), "warn");
  // The browser's recognition needs its vendor's online service; Electron and some browsers lack it.
  const serviceMissing = ["network", "service-not-allowed", "language-not-supported", "audio-capture"].includes(error);
  if ( serviceMissing && game.settings.get(ID, "engine") === "auto" && !talk.forceWhisper && WhisperEngine.supported ) {
    talk.forceWhisper = true;
    panel.status(loc("SwitchingEngine"), "warn");
    preloadWhisper();
    return;
  }
  panel.status(loc("EngineError", { error }), "error");
}

/* -------------------------------------------- */
/*  Lines and the GM's queue                    */
/* -------------------------------------------- */

function makeLine(text) {
  const user = game.user;
  const character = user.isGM ? "GM" : (user.character?.name ?? user.name);
  return { id: foundry.utils.randomID(), userId: user.id, player: user.name, character, text, at: Date.now() };
}

function submitLine(text) {
  if ( game.user.isGM && SEND_PHRASE.test(text) && game.settings.get(ID, "spokenSend") ) return queue.send();
  const line = makeLine(text);
  if ( queue.isOwner ) {
    queue.add(line);
    panel.status(loc("Queued", { text }), "ok");
    return;
  }
  if ( !game.users.activeGM ) return panel.status(loc("NoGM"), "error");
  talk.lastLine = text;
  game.socket.emit(SOCKET, { type: "line", line });
  panel.status(loc("Queued", { text }), "ok");
}

const queue = {
  lines: [],

  /** The active GM's client holds the queue and talks to Claude Code. */
  get isOwner() {
    return game.user.isGM && (game.users.activeGM?.id === game.user.id);
  },

  get storageKey() {
    return `${ID}.queue.${game.world.id}`;
  },

  restore() {
    try {
      this.lines = JSON.parse(localStorage.getItem(this.storageKey) ?? "[]");
    } catch {
      this.lines = [];
    }
  },

  save() {
    try { localStorage.setItem(this.storageKey, JSON.stringify(this.lines)); } catch {}
  },

  add(line) {
    if ( this.lines.some(l => l.id === line.id) ) return;
    this.lines.push(line);
    this.changed();
  },

  remove(id) {
    this.lines = this.lines.filter(l => l.id !== id);
    this.changed();
  },

  changed() {
    this.save();
    panel.render();
    this.broadcast();
  },

  /** Everyone learns how many lines wait; each player picks out their own to show (and delete). */
  broadcast() {
    game.socket.emit(SOCKET, {
      type: "queue",
      count: this.lines.length,
      lines: this.lines.map(({ id, userId, text }) => ({ id, userId, text }))
    });
  },

  async send() {
    if ( !this.isOwner ) return;
    if ( !this.lines.length ) return panel.status(loc("NothingToSend"), "warn");
    const batch = this.lines.slice();
    panel.sending(true);
    try {
      const res = await fetch(`${channelUrl()}/batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          world: game.world.id,
          lines: batch.map(({ character, player, text }) => ({ character, player, text }))
        })
      });
      const body = await res.json().catch(() => ({}));
      if ( res.status === 403 ) throw new Error(loc("Refused", { origin: window.location.origin }));
      if ( !res.ok ) throw new Error(body.reason ?? `HTTP ${res.status}`);
      const sentIds = new Set(batch.map(l => l.id));
      this.lines = this.lines.filter(l => !sentIds.has(l.id));
      this.changed();
      game.socket.emit(SOCKET, { type: "sent", count: batch.length });
      panel.status(loc("Sent", { count: batch.length }), "ok");
      link.set("ok");
    } catch (err) {
      const unreachable = err instanceof TypeError;
      if ( unreachable ) link.set("down");
      panel.status(unreachable ? loc("NotLinked", { url: channelUrl() }) : loc("SendFailed", { error: err.message }), "error");
    } finally {
      panel.sending(false);
    }
  }
};

function onSocket(message, senderId) {
  switch ( message?.type ) {
    case "line":
      if ( queue.isOwner ) queue.add(message.line);
      break;
    case "remove": {
      // A player takes back one of their own lines before the GM sends it.
      if ( !queue.isOwner ) break;
      const line = queue.lines.find(l => l.id === message.id);
      const from = senderId ?? message.userId;
      if ( line && (line.userId === from) ) queue.remove(line.id);
      break;
    }
    case "queue":
      if ( !queue.isOwner ) {
        panel.mine((message.lines ?? []).filter(l => l.userId === game.user.id));
        panel.waiting(message.count);
      }
      break;
    case "sent":
      if ( !queue.isOwner ) {
        talk.lastLine = null;
        panel.mine([]);
        panel.waiting(0);
        panel.status(loc("SentToGM"), "ok");
      }
      break;
    case "hello":
      // Someone (re)loaded; tell them how many lines are waiting.
      if ( queue.isOwner ) queue.broadcast();
      break;
  }
}

/* -------------------------------------------- */
/*  Link to Claude Code (GM only)               */
/* -------------------------------------------- */

function channelUrl() {
  return game.settings.get(ID, "channelUrl").trim().replace(/\/+$/, "");
}

const link = {
  state: "unknown", // ok | down | refused
  timer: null,

  set(state) {
    if ( state === this.state ) return;
    this.state = state;
    panel.render();
  },

  async check() {
    try {
      const res = await fetch(`${channelUrl()}/health`, { cache: "no-store" });
      this.set(res.ok ? "ok" : (res.status === 403 ? "refused" : "down"));
    } catch {
      this.set("down");
    }
  },

  start() {
    this.check();
    this.timer ??= setInterval(() => this.check(), 5000);
  }
};

/* -------------------------------------------- */
/*  Panel                                       */
/* -------------------------------------------- */

const panel = {
  el: null,
  waitingCount: 0,
  myLines: [],

  /** A player's own lines still waiting for the GM, each with a button to take it back. */
  mine(lines) {
    this.myLines = lines;
    if ( !this.el ) return;
    const list = this.el.querySelector(".tt-mine");
    list.hidden = queue.isOwner || !lines.length;
    list.replaceChildren(...lines.map(line => {
      const li = document.createElement("li");
      const text = document.createElement("span");
      text.textContent = line.text;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "tt-remove";
      remove.dataset.retract = line.id;
      remove.dataset.tooltip = loc("Retract");
      remove.setAttribute("aria-label", loc("Retract"));
      remove.innerHTML = `<i class="fa-solid fa-xmark" inert></i>`;
      li.append(text, remove);
      return li;
    }));
  },

  create() {
    const el = document.createElement("section");
    el.id = "table-talk";
    el.className = "table-talk";
    el.innerHTML = `
      <div class="tt-row">
        <button type="button" class="tt-talk" data-action="talk">
          <i class="fa-solid fa-microphone" inert></i><span class="tt-talk-label"></span>
        </button>
        <span class="tt-link" hidden></span>
      </div>
      <form class="tt-type">
        <input type="text" name="line" maxlength="2000" autocomplete="off">
        <button type="submit" class="tt-type-send"><i class="fa-solid fa-arrow-right" inert></i></button>
      </form>
      <p class="tt-status" role="status" aria-live="polite"></p>
      <p class="tt-engine"></p>
      <ol class="tt-mine" hidden></ol>
      <div class="tt-gm" hidden>
        <header class="tt-queue-head"><span class="tt-queue-title"></span></header>
        <ol class="tt-queue"></ol>
        <button type="button" class="tt-send" data-action="send">
          <i class="fa-solid fa-paper-plane" inert></i><span class="tt-send-label"></span>
        </button>
      </div>`;
    const talkButton = el.querySelector(".tt-talk");
    talkButton.addEventListener("pointerdown", event => {
      event.preventDefault();
      talkButton.setPointerCapture(event.pointerId);
      startTalking();
    });
    for ( const type of ["pointerup", "pointercancel", "lostpointercapture"] ) {
      talkButton.addEventListener(type, () => stopTalking());
    }
    el.querySelector(".tt-send").addEventListener("click", () => queue.send());
    const typeForm = el.querySelector(".tt-type");
    const typeInput = typeForm.querySelector("input");
    typeInput.placeholder = loc("TypePlaceholder");
    typeForm.querySelector("button").setAttribute("aria-label", loc("TypeSend"));
    typeForm.addEventListener("submit", event => {
      event.preventDefault();
      const text = typeInput.value.replace(/\s+/g, " ").trim();
      if ( !text ) return;
      typeInput.value = "";
      submitLine(text);
    });
    el.querySelector(".tt-mine").addEventListener("click", event => {
      const id = event.target.closest("[data-retract]")?.dataset.retract;
      if ( !id ) return;
      game.socket.emit(SOCKET, { type: "remove", id, userId: game.user.id });
      this.mine(this.myLines.filter(l => l.id !== id));
      if ( !this.myLines.length ) talk.lastLine = null;
    });
    el.querySelector(".tt-queue").addEventListener("click", event => {
      const id = event.target.closest("[data-remove]")?.dataset.remove;
      if ( id ) queue.remove(id);
    });
    document.body.append(el);
    this.el = el;
    this.place();
    window.addEventListener("resize", () => this.place());
    this.render();
  },

  /** Sit just above the players list, bottom left. */
  place() {
    const players = document.getElementById("players");
    const rect = players?.getBoundingClientRect();
    this.el.style.bottom = rect?.height ? `${Math.round(window.innerHeight - rect.top + 8)}px` : "";
    this.el.style.left = rect?.width ? `${Math.round(rect.left)}px` : "";
  },

  render() {
    if ( !this.el ) return;
    const key = talkKeyLabel();
    this.el.querySelector(".tt-talk-label").textContent = loc("HoldToTalk", { key });
    const gm = queue.isOwner;
    const gmBox = this.el.querySelector(".tt-gm");
    gmBox.hidden = !gm;
    const dot = this.el.querySelector(".tt-link");
    dot.hidden = !gm;
    if ( !gm ) return;

    dot.dataset.state = link.state;
    dot.dataset.tooltip = {
      ok: loc("Linked"),
      down: loc("NotLinked", { url: channelUrl() }),
      refused: loc("Refused", { origin: window.location.origin }),
      unknown: ""
    }[link.state];
    dot.setAttribute("aria-label", dot.dataset.tooltip);

    this.el.querySelector(".tt-queue-title").textContent = `${loc("Queue")} (${queue.lines.length})`;
    const list = this.el.querySelector(".tt-queue");
    list.replaceChildren(...queue.lines.map(line => {
      const li = document.createElement("li");
      const who = document.createElement("strong");
      who.textContent = line.character === line.player || line.character === "GM"
        ? line.character : `${line.character} (${line.player})`;
      const text = document.createElement("span");
      text.textContent = line.text;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "tt-remove";
      remove.dataset.remove = line.id;
      remove.dataset.tooltip = loc("Remove");
      remove.setAttribute("aria-label", loc("Remove"));
      remove.innerHTML = `<i class="fa-solid fa-xmark" inert></i>`;
      li.append(who, text, remove);
      return li;
    }));
    if ( !queue.lines.length ) {
      const li = document.createElement("li");
      li.className = "tt-empty";
      li.textContent = loc("QueueEmpty");
      list.append(li);
    }
    const sendKey = game.keybindings.get(ID, "send")?.[0];
    const sendKeyText = sendKey ? ` ${loc("SendKey", { key: foundry.applications.sidebar.apps.ControlsConfig?.humanizeBinding?.(sendKey) ?? "Shift+G" })}` : "";
    this.el.querySelector(".tt-send-label").textContent = loc("Send") + sendKeyText;
    this.el.querySelector(".tt-send").disabled = !queue.lines.length;
  },

  engine(text) {
    const p = this.el?.querySelector(".tt-engine");
    if ( p ) p.textContent = text;
  },

  status(text, kind = "") {
    if ( !this.el ) return;
    const p = this.el.querySelector(".tt-status");
    p.textContent = text;
    p.dataset.kind = kind;
  },

  talking(on) {
    this.el?.classList.toggle("talking", on);
  },

  sending(on) {
    if ( !this.el ) return;
    const button = this.el.querySelector(".tt-send");
    button.disabled = on || !queue.lines.length;
    if ( on ) this.el.querySelector(".tt-send-label").textContent = loc("Sending");
    else this.render();
  },

  waiting(count) {
    this.waitingCount = count;
    if ( !this.el || talk.active || talk.busy || !count ) return;
    this.status(loc("Waiting", { count }), "ok");
  }
};

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(ID, "channelUrl", {
    name: "TABLETALK.Settings.ChannelUrl.Name",
    hint: "TABLETALK.Settings.ChannelUrl.Hint",
    scope: "client",
    config: true,
    type: String,
    default: "http://127.0.0.1:8796",
    onChange: () => link.check()
  });
  game.settings.register(ID, "engine", {
    name: "TABLETALK.Settings.Engine.Name",
    hint: "TABLETALK.Settings.Engine.Hint",
    scope: "client",
    config: true,
    type: String,
    choices: {
      auto: "TABLETALK.Settings.Engine.Auto",
      browser: "TABLETALK.Settings.Engine.Browser",
      whisper: "TABLETALK.Settings.Engine.Whisper"
    },
    default: "auto",
    onChange: () => {
      talk.forceWhisper = false;
      preloadWhisper();
    }
  });
  game.settings.register(ID, "language", {
    name: "TABLETALK.Settings.Language.Name",
    hint: "TABLETALK.Settings.Language.Hint",
    scope: "client",
    config: true,
    type: String,
    default: ""
  });
  game.settings.register(ID, "spokenSend", {
    name: "TABLETALK.Settings.SpokenSend.Name",
    hint: "TABLETALK.Settings.SpokenSend.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.keybindings.register(ID, "talk", {
    name: "TABLETALK.Keys.Talk.Name",
    hint: "TABLETALK.Keys.Talk.Hint",
    editable: [{ key: "KeyG" }],
    repeat: false,
    onDown: () => { startTalking(); return true; },
    onUp: () => { stopTalking(); return true; },
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
  });
  game.keybindings.register(ID, "send", {
    name: "TABLETALK.Keys.Send.Name",
    hint: "TABLETALK.Keys.Send.Hint",
    editable: [{ key: "KeyG", modifiers: ["Shift"] }],
    restricted: true,
    repeat: false,
    onDown: () => { queue.send(); return true; },
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
  });
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, onSocket);
  if ( queue.isOwner ) queue.restore();
  panel.create();
  if ( game.user.isGM ) link.start();
  game.socket.emit(SOCKET, { type: "hello" });
  // A GM taking over (or leaving) changes who owns the queue.
  Hooks.on("userConnected", () => {
    if ( queue.isOwner && !queue.lines.length ) queue.restore();
    panel.render();
    panel.place();
  });
  preloadWhisper();
});
