// The chat page. It talks only to the local server (server.js) and shows text as plain text.
'use strict';

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const form = $('composer');
const input = $('input');
const sendBtn = $('send');
const micBtn = $('mic');
const listEl = $('conversation-list');
const statusEl = $('status');
const bannerEl = $('banner');

let conversationId = null;
let busy = false;

// "2026-10-09T23:55:00+07:00" becomes "23:55"
function clock(iso) {
  const m = /T(\d{2}:\d{2})/.exec(iso || '');
  return m ? m[1] : '';
}

function showWelcome() {
  messagesEl.replaceChildren($('welcome').content.cloneNode(true));
}

function addMessage(role, text, time, kind) {
  const welcome = messagesEl.querySelector('.welcome');
  if (welcome) welcome.remove();

  const row = document.createElement('div');
  row.className = 'msg ' + role + (kind ? ' ' + kind : '');

  const meta = document.createElement('div');
  meta.className = 'meta';
  const who = role === 'user' ? 'You' : role === 'assistant' ? 'AI' : '';
  meta.textContent = who + (time ? ' · ' + clock(time) : '');

  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = text; // plain text only, never HTML

  row.append(meta, body);
  messagesEl.append(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return row;
}

async function api(path, options) {
  const res = await fetch(path, options);
  let data = null;
  try {
    data = await res.json();
  } catch {
    // The reply was not JSON.
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'Request failed (' + res.status + ')');
    err.data = data;
    throw err;
  }
  return data;
}

async function loadStatus() {
  try {
    const s = await api('/api/status');
    statusEl.textContent =
      (s.mock ? 'Test mode, no real AI · ' : '') +
      'Model: ' + s.model + ' · Saving to: ' + s.memoryDir;
    if (!s.hasKey && !s.mock) {
      bannerEl.hidden = false;
      bannerEl.textContent =
        'No API key found yet. Create a file named .env next to server.js with the line ' +
        'ANTHROPIC_API_KEY=your-key, then restart the app. See README.md.';
    }
  } catch {
    statusEl.textContent = 'Cannot reach the app. Is it still running in Terminal?';
  }
}

async function refreshList() {
  let conversations = [];
  try {
    conversations = (await api('/api/conversations')).conversations;
  } catch {
    return;
  }
  listEl.replaceChildren();
  if (!conversations.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Nothing saved yet.';
    listEl.append(p);
    return;
  }
  for (const c of conversations) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'conv' + (c.id === conversationId ? ' active' : '');

    const t = document.createElement('span');
    t.className = 't';
    t.textContent = c.title;

    const d = document.createElement('span');
    d.className = 'd';
    d.textContent = c.id.slice(0, 10) + ' ' + c.id.slice(11, 13) + ':' + c.id.slice(13, 15);

    b.append(t, d);
    b.addEventListener('click', () => openConversation(c.id));
    listEl.append(b);
  }
}

async function openConversation(id) {
  try {
    const conv = await api('/api/conversations/' + encodeURIComponent(id));
    conversationId = conv.id;
    messagesEl.replaceChildren();
    for (const m of conv.messages) addMessage(m.role, m.text, m.time);
    document.body.classList.remove('menu-open');
    refreshList();
    input.focus();
  } catch (err) {
    addMessage('system', err.message, null, 'error');
  }
}

function newConversation() {
  conversationId = null;
  showWelcome();
  document.body.classList.remove('menu-open');
  refreshList();
  input.focus();
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}

function setBusy(value) {
  busy = value;
  sendBtn.disabled = value;
}

async function send() {
  const text = input.value.trim();
  if (!text || busy) return;

  setBusy(true);
  addMessage('user', text, null);
  input.value = '';
  autosize();
  const thinking = addMessage('assistant', 'Thinking…', null, 'thinking');

  try {
    const data = await api('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, message: text }),
    });
    conversationId = data.conversationId;
    thinking.remove();
    addMessage('assistant', data.reply, data.time);
    refreshList();
  } catch (err) {
    thinking.remove();
    if (err.data && err.data.conversationId) {
      conversationId = err.data.conversationId;
      refreshList();
    }
    addMessage('system', err.message, null, 'error');
  } finally {
    setBusy(false);
    input.focus();
  }
}

// ---- Voice input (the browser's built-in speech recognition) ----
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!Recognition) {
  micBtn.hidden = true;
} else {
  let recognition = null;
  let listening = false;
  let baseText = '';

  const stopped = () => {
    listening = false;
    micBtn.classList.remove('on');
    micBtn.setAttribute('aria-pressed', 'false');
    micBtn.textContent = 'Mic';
  };

  micBtn.addEventListener('click', () => {
    if (listening) {
      recognition.stop();
      return;
    }
    recognition = new Recognition();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.continuous = true;
    baseText = input.value ? input.value.trimEnd() + ' ' : '';

    recognition.onresult = (event) => {
      let heard = '';
      for (let i = 0; i < event.results.length; i++) heard += event.results[i][0].transcript;
      input.value = baseText + heard;
      autosize();
    };
    recognition.onerror = (event) => {
      addMessage('system', 'Voice input problem: ' + event.error, null, 'error');
    };
    recognition.onend = stopped;

    try {
      recognition.start();
      listening = true;
      micBtn.classList.add('on');
      micBtn.setAttribute('aria-pressed', 'true');
      micBtn.textContent = 'Stop';
    } catch {
      stopped();
    }
  });
}

// ---- Wiring ----
form.addEventListener('submit', (event) => {
  event.preventDefault();
  send();
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send();
  }
});

input.addEventListener('input', autosize);
$('new-conversation').addEventListener('click', newConversation);
$('menu').addEventListener('click', () => document.body.classList.toggle('menu-open'));

showWelcome();
loadStatus();
refreshList();
input.focus();
