/* AI Voice Assistant - frontend logic
 * Sections: 1) state  2) helpers  3) markdown  4) rendering  5) chat actions
 *           6) backend call  7) text-to-speech  8) speech-to-text  9) events
 *           10) attachments (photos + files)
 */
"use strict";

// ---------------------------------------------------------------------------
// 1) State
// ---------------------------------------------------------------------------
const STORAGE_KEY = "ai-voice-assistant-chats";
const ACTIVE_KEY = "ai-voice-assistant-active-chat";
const DEFAULT_TITLE = "New chat";
const MAX_IMAGES = 4;            // photos per message
const MAX_DOCS = 3;              // files per message
const IMAGE_MAX_SIDE = 1024;     // photos are shrunk before sending (faster + fits small models)
const MAX_FILE_CHARS = 12000;    // must match the server limit

const $ = (id) => document.getElementById(id);
const els = {
  sidebar: $("sidebar"), overlay: $("overlay"), menuBtn: $("menuBtn"),
  newChatBtn: $("newChatBtn"), chatList: $("chatList"), chatTitle: $("chatTitle"),
  messages: $("messages"), input: $("messageInput"), sendBtn: $("sendBtn"),
  micBtn: $("micBtn"), listening: $("listening"), stopSpeakBtn: $("stopSpeakBtn"),
  clearBtn: $("clearBtn"), autoSpeak: $("autoSpeak"), toast: $("toast"), banner: $("statusBanner"),
  attachBtn: $("attachBtn"), fileInput: $("fileInput"), attachTray: $("attachTray"), dropOverlay: $("dropOverlay"),
};

let chats = loadChats();            // [{ id, title, messages: [{role, content, time, isError?}] }]
let activeChatId = localStorage.getItem(ACTIVE_KEY);
let isLoading = false;
let pending = [];                 // attachments waiting to be sent: [{ id, kind: "image"|"file", name, thumb, data, text, loading }]
let visionReady = true;           // set by the health check (is the image model installed?)
let visionModelName = "llava";

// ---------------------------------------------------------------------------
// 2) Helpers
// ---------------------------------------------------------------------------
function loadChats() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function saveChats() {
  try {
    // Keys starting with "_" (full-size images) stay in memory only - localStorage is too small for them.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(chats, (key, value) => (key.startsWith("_") ? undefined : value)));
    localStorage.setItem(ACTIVE_KEY, activeChatId || "");
  } catch (error) {
    showToast("Could not save chat history (browser storage is full or blocked).");
  }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function getActiveChat() {
  return chats.find((chat) => chat.id === activeChatId) || null;
}

function formatTime(isoString) {
  return new Date(isoString).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

let toastTimer = null;
function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 5000);
}

// ---------------------------------------------------------------------------
// 3) Safe Markdown (everything is HTML-escaped FIRST, so no script injection)
// ---------------------------------------------------------------------------
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatInline(escapedText) {
  return escapedText
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
}

function renderMarkdown(text) {
  // Pull out ``` code blocks first and replace them with placeholders.
  const codeBlocks = [];
  const withPlaceholders = text.replace(/```[\w+-]*\n?([\s\S]*?)```/g, (match, code) => {
    codeBlocks.push(code.replace(/\n$/, ""));
    return "\n\u0000CODE" + (codeBlocks.length - 1) + "\u0000\n";
  });

  const lines = escapeHtml(withPlaceholders).split("\n");
  let html = "";
  let openList = null;       // "ul" | "ol" | null
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) { html += "<p>" + formatInline(paragraph.join("<br>")) + "</p>"; paragraph = []; }
  };
  const closeList = () => {
    if (openList) { html += "</" + openList + ">"; openList = null; }
  };
  const openListType = (type) => {
    if (openList !== type) { closeList(); html += "<" + type + ">"; openList = type; }
  };

  for (const line of lines) {
    let match;
    if ((match = line.match(/^\u0000CODE(\d+)\u0000$/))) {
      flushParagraph(); closeList();
      html += "<pre><code>" + escapeHtml(codeBlocks[Number(match[1])]) + "</code></pre>";
    } else if ((match = line.match(/^\s*[-*]\s+(.*)$/))) {
      flushParagraph(); openListType("ul");
      html += "<li>" + formatInline(match[1]) + "</li>";
    } else if ((match = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushParagraph(); openListType("ol");
      html += "<li>" + formatInline(match[1]) + "</li>";
    } else if ((match = line.match(/^#{1,6}\s+(.*)$/))) {
      flushParagraph(); closeList();
      html += "<h4>" + formatInline(match[1]) + "</h4>";
    } else if (line.trim() === "") {
      flushParagraph(); closeList();
    } else {
      closeList(); paragraph.push(line);
    }
  }
  flushParagraph(); closeList();
  return html;
}

// ---------------------------------------------------------------------------
// 4) Rendering
// ---------------------------------------------------------------------------
function renderSidebar() {
  els.chatList.innerHTML = "";
  if (chats.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-history";
    empty.textContent = "No chats yet";
    els.chatList.appendChild(empty);
    return;
  }
  [...chats].reverse().forEach((chat) => {
    const item = document.createElement("li");
    item.className = "chat-item" + (chat.id === activeChatId ? " active" : "");

    const openBtn = document.createElement("button");
    openBtn.className = "chat-open";
    openBtn.type = "button";
    openBtn.textContent = chat.title;          // textContent = safe
    openBtn.dataset.id = chat.id;
    openBtn.dataset.action = "open";

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "chat-delete";
    deleteBtn.type = "button";
    deleteBtn.textContent = "🗑";
    deleteBtn.setAttribute("aria-label", "Delete chat: " + chat.title);
    deleteBtn.dataset.id = chat.id;
    deleteBtn.dataset.action = "delete";

    item.append(openBtn, deleteBtn);
    els.chatList.appendChild(item);
  });
}

function buildMessageElement(message, index) {
  const wrapper = document.createElement("div");
  wrapper.className = "message " + message.role + (message.isError ? " error" : "");

  if (message.role === "assistant") {
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = "🤖";
    avatar.setAttribute("aria-hidden", "true");
    wrapper.appendChild(avatar);
  }

  const column = document.createElement("div");
  column.className = "bubble-col";

  if (Array.isArray(message.attachments) && message.attachments.length) {
    column.appendChild(buildAttachmentList(message.attachments));
  }

  if (message.content) {
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (message.role === "assistant" && !message.isError) {
      bubble.innerHTML = renderMarkdown(message.content);   // safe: escaped first
    } else {
      bubble.textContent = message.content;
    }
    column.appendChild(bubble);
  }

  const meta = document.createElement("div");
  meta.className = "meta";
  const time = document.createElement("span");
  time.textContent = formatTime(message.time);
  meta.appendChild(time);

  if (message.role === "assistant" && !message.isError) {
    meta.appendChild(makeActionButton("🔊", "Read aloud", "speak", index));
    meta.appendChild(makeActionButton("⏹", "Stop speaking", "stop", index));
    meta.appendChild(makeActionButton("📋 Copy", "Copy response", "copy", index));
  }
  column.appendChild(meta);
  wrapper.appendChild(column);
  return wrapper;
}

function buildAttachmentList(attachments) {
  const list = document.createElement("div");
  list.className = "msg-attachments";
  attachments.forEach((item) => {
    if (item.kind === "image" && typeof item.thumb === "string" && item.thumb.startsWith("data:image/jpeg;base64,")) {
      const img = document.createElement("img");
      img.className = "msg-thumb";
      img.src = item.thumb;
      img.alt = item.name || "Attached image";
      list.appendChild(img);
    } else {
      const chip = document.createElement("span");
      chip.className = "file-chip";
      chip.textContent = (item.kind === "image" ? "🖼 " : "📄 ") + (item.name || "file");   // textContent = safe
      list.appendChild(chip);
    }
  });
  return list;
}

function makeActionButton(label, ariaLabel, action, index) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "action-btn";
  button.textContent = label;
  button.title = ariaLabel;
  button.setAttribute("aria-label", ariaLabel);
  button.dataset.action = action;
  button.dataset.index = String(index);
  return button;
}

function renderWelcome() {
  els.messages.innerHTML = `
    <div class="welcome">
      <div class="logo" aria-hidden="true">🎙</div>
      <h2>How can I help you today?</h2>
      <p>Type a question, press the microphone and speak, or attach a photo or file with the paperclip.</p>
      <div class="suggestions">
        <button class="suggestion" type="button">Explain inheritance in Java in simple words</button>
        <button class="suggestion" type="button">What is object oriented programming?</button>
        <button class="suggestion" type="button">Give me tips for a placement interview</button>
      </div>
    </div>`;
}

function renderMessages() {
  const chat = getActiveChat();
  els.chatTitle.textContent = chat ? chat.title : DEFAULT_TITLE;
  els.messages.innerHTML = "";

  if (!chat || chat.messages.length === 0) {
    if (!isLoading) { renderWelcome(); return; }
  }
  if (chat) {
    chat.messages.forEach((message, index) => els.messages.appendChild(buildMessageElement(message, index)));
  }
  if (isLoading) {
    const typing = document.createElement("div");
    typing.className = "message assistant";
    typing.innerHTML = '<div class="avatar" aria-hidden="true">🤖</div><div class="bubble-col"><div class="bubble typing">' +
      '<span class="dots"><span></span><span></span><span></span></span> AI is thinking...</div></div>';
    els.messages.appendChild(typing);
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

function setLoading(loading) {
  isLoading = loading;
  els.sendBtn.disabled = loading;
  els.input.disabled = loading;
  els.micBtn.disabled = loading;
  els.attachBtn.disabled = loading;
  renderMessages();
  if (!loading) els.input.focus();
}

// ---------------------------------------------------------------------------
// 5) Chat actions
// ---------------------------------------------------------------------------
function createChat() {
  const chat = { id: newId(), title: DEFAULT_TITLE, messages: [] };
  chats.push(chat);
  activeChatId = chat.id;
  saveChats();
  return chat;
}

function startNewChat() {
  stopSpeaking();
  const current = getActiveChat();
  if (current && current.messages.length === 0) { renderMessages(); closeSidebar(); return; } // reuse empty chat
  createChat();
  renderSidebar(); renderMessages(); closeSidebar();
  els.input.focus();
}

function openChat(id) {
  stopSpeaking();
  activeChatId = id;
  saveChats(); renderSidebar(); renderMessages(); closeSidebar();
}

function deleteChat(id) {
  chats = chats.filter((chat) => chat.id !== id);
  if (activeChatId === id) {
    activeChatId = chats.length ? chats[chats.length - 1].id : null;
    stopSpeaking();
  }
  saveChats(); renderSidebar(); renderMessages();
}

function clearConversation() {
  const chat = getActiveChat();
  if (!chat || chat.messages.length === 0) return;
  if (!window.confirm("Clear all messages in this chat?")) return;
  stopSpeaking();
  chat.messages = [];
  chat.title = DEFAULT_TITLE;
  saveChats(); renderSidebar(); renderMessages();
}

// What the AI should "read" for one stored message: attached file text + the typed text.
function modelText(message) {
  const attachments = message.attachments || [];
  const blocks = attachments
    .filter((item) => item.kind === "file" && item.text)
    .map((item) => "[Attached file: " + item.name + "]\n```\n" + item.text + "\n```");
  let body = message.content || "";
  if (!body && message.role === "user") {
    if (attachments.some((item) => item.kind === "image")) body = "Describe this image in detail.";
    else if (attachments.length) body = "Summarize this file.";
  }
  return [...blocks, body].filter(Boolean).join("\n\n");
}

// Earlier messages sent to the AI. Only the most recent photo is re-sent (keeps requests small and fast).
function buildHistory(chat) {
  const valid = chat.messages.filter((m) => !m.isError);
  let lastImageIndex = -1;
  valid.forEach((m, i) => { if (m.role === "user" && m._images && m._images.length) lastImageIndex = i; });
  return valid.map((m, i) => {
    const item = { role: m.role, content: modelText(m) };
    if (i === lastImageIndex) item.images = m._images;
    return item;
  });
}

async function sendMessage(rawText) {
  const text = (rawText || "").trim();
  if (isLoading) return;                                // blocks duplicate sends
  if (pending.some((item) => item.loading)) { showToast("Please wait - your attachment is still being read."); return; }
  if (!text && pending.length === 0) return;            // blocks empty sends

  stopSpeaking();
  const chat = getActiveChat() || createChat();
  const history = buildHistory(chat);

  const images = pending.filter((item) => item.kind === "image").map((item) => item.data);
  const files = pending.filter((item) => item.kind === "file").map((item) => ({ name: item.name, text: item.text }));
  const attachments = pending.map((item) => (
    item.kind === "image"
      ? { kind: "image", name: item.name, thumb: item.thumb }
      : { kind: "file", name: item.name, text: item.text }
  ));

  const userMessage = { role: "user", content: text, time: new Date().toISOString() };
  if (attachments.length) {
    userMessage.attachments = attachments;
    userMessage._images = images;                        // memory only, never saved to localStorage
  }
  chat.messages.push(userMessage);
  if (chat.title === DEFAULT_TITLE) {
    const titleSource = text || (attachments[0] ? attachments[0].name : DEFAULT_TITLE);
    chat.title = titleSource.length > 40 ? titleSource.slice(0, 40) + "…" : titleSource;
  }
  els.input.value = "";
  autoResizeInput();
  pending = [];
  renderTray();
  saveChats(); renderSidebar();
  setLoading(true);

  try {
    const reply = await requestAiReply(text, history, files, images);
    chat.messages.push({ role: "assistant", content: reply, time: new Date().toISOString() });
    saveChats();
    setLoading(false);
    if (els.autoSpeak.checked) speak(reply);
  } catch (error) {
    chat.messages.push({ role: "assistant", content: error.message, time: new Date().toISOString(), isError: true });
    saveChats();
    setLoading(false);
  }
}

// ---------------------------------------------------------------------------
// 6) Backend call
// ---------------------------------------------------------------------------
async function requestAiReply(message, history, files = [], images = []) {
  let response;
  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history, files, images }),
    });
  } catch (networkError) {
    throw new Error("Cannot reach the Flask server. Is it still running in your terminal?");
  }

  let data;
  try {
    data = await response.json();
  } catch (parseError) {
    throw new Error("The server sent an invalid response. Please try again.");
  }

  if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  if (typeof data.reply !== "string" || !data.reply) throw new Error("The server sent an invalid response.");
  return data.reply;
}

async function checkBackendHealth() {
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    visionReady = data.vision_installed !== false;
    visionModelName = data.vision_model || visionModelName;
    if (!data.ollama) {
      showBanner("Ollama is not running. Open the Ollama app, then refresh this page.");
    } else if (!data.model_installed) {
      showBanner("Model not installed. Run in a terminal:  ollama pull " + data.model);
    }
  } catch (error) {
    showBanner("Cannot reach the Flask server.");
  }
}

function showBanner(message) {
  els.banner.textContent = message;
  els.banner.hidden = false;
}

// ---------------------------------------------------------------------------
// 7) Text-to-speech (SpeechSynthesis)
// ---------------------------------------------------------------------------
let speechSession = 0;   // lets us ignore events from cancelled speech

function textForSpeech(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, " (code block skipped) ")
    .replace(/[`*#_>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitIntoChunks(text, maxLength = 180) {
  // Browsers can cut off long utterances, so we speak sentence-sized chunks.
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    if ((current + sentence).length > maxLength && current) { chunks.push(current); current = ""; }
    current += sentence;
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

function setSpeakingUi(isSpeaking) {
  els.stopSpeakBtn.hidden = !isSpeaking;
}

function speak(markdownText) {
  if (!("speechSynthesis" in window)) {
    showToast("Voice output is not supported in this browser.");
    return;
  }
  stopSpeaking();
  const cleanText = textForSpeech(markdownText);
  if (!cleanText) return;

  const session = ++speechSession;
  const chunks = splitIntoChunks(cleanText);
  let remaining = chunks.length;
  setSpeakingUi(true);

  chunks.forEach((chunk) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.lang = "en-US";
    utterance.rate = 1;
    const finish = () => {
      if (session !== speechSession) return;
      remaining -= 1;
      if (remaining <= 0) setSpeakingUi(false);
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    window.speechSynthesis.speak(utterance);
  });
}

function stopSpeaking() {
  speechSession += 1;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  setSpeakingUi(false);
}

// ---------------------------------------------------------------------------
// 8) Speech-to-text (SpeechRecognition)
// ---------------------------------------------------------------------------
const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isListening = false;

function setListeningUi(listening) {
  isListening = listening;
  els.micBtn.classList.toggle("recording", listening);
  els.micBtn.setAttribute("aria-label", listening ? "Stop voice input" : "Start voice input");
  els.listening.hidden = !listening;
}

function toggleListening() {
  if (!SpeechRecognitionApi) {
    showToast("Voice input is not supported in this browser. Please use Google Chrome or Microsoft Edge.");
    return;
  }
  if (isListening) { recognition.stop(); return; }
  stopSpeaking();                         // don't let the AI talk over the user
  startListening();
}

function startListening() {
  recognition = new SpeechRecognitionApi();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = false;
  let finalText = "";

  recognition.onstart = () => setListeningUi(true);

  recognition.onresult = (event) => {
    let interimText = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += transcript; else interimText += transcript;
    }
    els.input.value = (finalText + interimText).trim();
    autoResizeInput();
  };

  recognition.onerror = (event) => {
    const messages = {
      "not-allowed": "Microphone permission was denied. Allow the microphone in your browser's address bar and try again.",
      "service-not-allowed": "Microphone permission was denied. Allow the microphone in your browser's address bar and try again.",
      "no-speech": "I didn't hear anything. Click the microphone and try again.",
      "audio-capture": "No microphone was found. Please connect one and try again.",
      "network": "Speech recognition needs an internet connection in this browser.",
    };
    showToast(messages[event.error] || "Voice input error: " + event.error);
    finalText = "";                       // don't auto-send after an error
  };

  recognition.onend = () => {
    setListeningUi(false);
    if (finalText.trim()) sendMessage(finalText);   // auto-send what was recognised
  };

  try {
    recognition.start();
  } catch (error) {
    showToast("Could not start the microphone. Please try again.");
  }
}

// ---------------------------------------------------------------------------
// 9) Events
// ---------------------------------------------------------------------------
function autoResizeInput() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + "px";
}

function openSidebar() { els.sidebar.classList.add("open"); els.overlay.classList.add("show"); }
function closeSidebar() { els.sidebar.classList.remove("open"); els.overlay.classList.remove("show"); }

els.sendBtn.addEventListener("click", () => sendMessage(els.input.value));
els.input.addEventListener("input", autoResizeInput);
els.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(els.input.value); }
});
els.micBtn.addEventListener("click", toggleListening);
els.stopSpeakBtn.addEventListener("click", stopSpeaking);
els.newChatBtn.addEventListener("click", startNewChat);
els.clearBtn.addEventListener("click", clearConversation);
els.menuBtn.addEventListener("click", openSidebar);
els.overlay.addEventListener("click", closeSidebar);

els.chatList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  if (button.dataset.action === "open") openChat(button.dataset.id);
  if (button.dataset.action === "delete") deleteChat(button.dataset.id);
});

els.messages.addEventListener("click", (event) => {
  const suggestion = event.target.closest(".suggestion");
  if (suggestion) { sendMessage(suggestion.textContent); return; }

  const button = event.target.closest("button[data-action]");
  const chat = getActiveChat();
  if (!button || !chat) return;
  const message = chat.messages[Number(button.dataset.index)];
  if (!message) return;

  if (button.dataset.action === "speak") speak(message.content);
  if (button.dataset.action === "stop") stopSpeaking();
  if (button.dataset.action === "copy") {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(message.content)
        .then(() => showToast("Copied to clipboard"))
        .catch(() => showToast("Could not copy. Please select the text manually."));
    } else {
      showToast("Copy is not supported in this browser.");
    }
  }
});

window.addEventListener("beforeunload", stopSpeaking);

// ---------------------------------------------------------------------------
// 10) Attachments (photos + files)
// ---------------------------------------------------------------------------
function renderTray() {
  els.attachTray.innerHTML = "";
  els.attachTray.hidden = pending.length === 0;
  pending.forEach((item) => {
    const box = document.createElement("div");
    const isImage = item.kind === "image" && item.thumb;
    box.className = "tray-item" + (isImage ? " is-image" : "") + (item.loading ? " loading" : "");

    if (isImage) {
      const img = document.createElement("img");
      img.className = "tray-thumb";
      img.src = item.thumb;
      img.alt = item.name;
      box.appendChild(img);
    } else {
      const icon = document.createElement("span");
      icon.className = "tray-icon";
      icon.textContent = item.kind === "image" ? "🖼" : "📄";
      const name = document.createElement("span");
      name.className = "tray-name";
      name.textContent = item.name;
      box.append(icon, name);
      if (item.loading) {
        const status = document.createElement("span");
        status.className = "tray-status";
        status.textContent = "Reading...";
        box.appendChild(status);
      }
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "tray-remove";
    remove.textContent = "✕";
    remove.dataset.id = item.id;
    remove.setAttribute("aria-label", "Remove " + item.name);
    box.appendChild(remove);
    els.attachTray.appendChild(box);
  });
}

// Shrink a photo and re-encode as JPEG. Smaller upload, and the AI model does not need 12-megapixel photos.
function bitmapToJpegDataUrl(bitmap, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";                           // transparent PNGs become white instead of black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

async function readImage(file, item) {
  if (file.size > 20 * 1024 * 1024) throw new Error(item.name + " is too large (maximum 20 MB).");
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (error) {
    throw new Error("Could not open " + item.name + ". Please use a JPG, PNG, WEBP or GIF image.");
  }
  item.data = bitmapToJpegDataUrl(bitmap, IMAGE_MAX_SIDE, 0.85).split(",")[1];   // base64 only
  item.thumb = bitmapToJpegDataUrl(bitmap, 160, 0.7);
  if (bitmap.close) bitmap.close();
}

async function readDocument(file, item) {
  if (file.size > 10 * 1024 * 1024) throw new Error(item.name + " is too large (maximum 10 MB).");
  const form = new FormData();
  form.append("file", file);
  let response;
  try {
    response = await fetch("/api/extract", { method: "POST", body: form });
  } catch (networkError) {
    throw new Error("Cannot reach the Flask server. Is it still running in your terminal?");
  }
  let data;
  try {
    data = await response.json();
  } catch (parseError) {
    throw new Error("The server sent an invalid response. Please try again.");
  }
  if (!response.ok) throw new Error(data.error || "Could not read " + item.name + ".");
  item.text = data.text;
  if (data.truncated) showToast(item.name + " is long - only the first " + MAX_FILE_CHARS.toLocaleString() + " characters will be used.");
}

async function addFiles(fileList) {
  for (const file of Array.from(fileList || [])) {
    const isImage = file.type.startsWith("image/");
    const imageCount = pending.filter((item) => item.kind === "image").length;
    const docCount = pending.length - imageCount;
    if (isImage && imageCount >= MAX_IMAGES) { showToast("You can attach up to " + MAX_IMAGES + " photos per message."); continue; }
    if (!isImage && docCount >= MAX_DOCS) { showToast("You can attach up to " + MAX_DOCS + " files per message."); continue; }
    if (isImage && !visionReady) {
      showToast("To understand photos, install a vision model. In a terminal run:  ollama pull " + visionModelName);
    }

    const item = { id: newId(), kind: isImage ? "image" : "file", name: file.name || "pasted-image.png", loading: true };
    pending.push(item);
    renderTray();
    try {
      if (isImage) await readImage(file, item); else await readDocument(file, item);
      item.loading = false;
    } catch (error) {
      pending = pending.filter((entry) => entry !== item);
      showToast(error.message);
    }
    renderTray();
  }
  els.input.focus();
}

els.attachBtn.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => {
  addFiles(els.fileInput.files);
  els.fileInput.value = "";                            // lets the user pick the same file again
});
els.attachTray.addEventListener("click", (event) => {
  const button = event.target.closest(".tray-remove");
  if (!button) return;
  pending = pending.filter((item) => item.id !== button.dataset.id);
  renderTray();
});

// Paste a screenshot / copied image straight into the message box (Ctrl+V)
els.input.addEventListener("paste", (event) => {
  const files = Array.from((event.clipboardData && event.clipboardData.files) || []);
  if (files.length) { event.preventDefault(); addFiles(files); }
});

// Drag & drop anywhere on the page
let dragDepth = 0;
const hasFiles = (event) => event.dataTransfer && Array.from(event.dataTransfer.types || []).includes("Files");
window.addEventListener("dragenter", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault(); dragDepth += 1; els.dropOverlay.hidden = false;
});
window.addEventListener("dragover", (event) => { if (hasFiles(event)) event.preventDefault(); });
window.addEventListener("dragleave", (event) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) els.dropOverlay.hidden = true;
});
window.addEventListener("drop", (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault(); dragDepth = 0; els.dropOverlay.hidden = true;
  if (!isLoading) addFiles(event.dataTransfer.files);
});

// ---- Start-up ----
if (!getActiveChat()) activeChatId = chats.length ? chats[chats.length - 1].id : null;
renderSidebar();
renderMessages();
checkBackendHealth();
if (!SpeechRecognitionApi) els.micBtn.title = "Voice input is not supported in this browser";
