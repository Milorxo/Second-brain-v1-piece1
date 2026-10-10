// Second Brain: version 1, piece 1.
// A small local chat app. It uses only what Node.js already includes (Node 18 or newer),
// so there is nothing to install besides Node itself.
//
// What it does:
//   - serves the chat page from the public/ folder, on this computer only
//   - sends your conversation to the AI and shows the reply
//   - saves every conversation as plain files in the memory/ folder
//
// Your API key stays in this server process. It is never sent to the browser.
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Reads KEY=value lines from a .env file. Real environment variables win.
function loadEnvFile(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

loadEnvFile(path.join(ROOT, '.env'));

const defaults = {
  model: 'claude-sonnet-5-5',
  maxTokens: 2000,
  memoryDir: './memory',
  port: 3737,
  contextMessages: 40,
  apiUrl: 'https://api.anthropic.com/v1/messages',
};

const config = { ...defaults, ...readJson(path.join(ROOT, 'config.json'), {}) };
if (process.env.PORT) config.port = Number(process.env.PORT);
if (process.env.MEMORY_DIR) config.memoryDir = process.env.MEMORY_DIR;
if (process.env.ANTHROPIC_API_URL) config.apiUrl = process.env.ANTHROPIC_API_URL;

const MEMORY_DIR = path.resolve(ROOT, config.memoryDir);
const CONV_DIR = path.join(MEMORY_DIR, 'conversations');
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MOCK = process.env.MOCK_AI === '1'; // test mode: no real AI call

// An error whose message is safe and useful to show to the person using the app.
class UserError extends Error {}

// ---------------------------------------------------------------------------
// Time and ids
// ---------------------------------------------------------------------------

function pad(n) {
  return String(n).padStart(2, '0');
}

// Local time with its offset, for example 2026-10-09T23:55:00+07:00
function localIso(d = new Date()) {
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

// Example: 2026-10-09_2355_ab12
function newId(d = new Date()) {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${date}_${pad(d.getHours())}${pad(d.getMinutes())}_${crypto.randomBytes(2).toString('hex')}`;
}

const ID_RE = /^\d{4}-\d{2}-\d{2}_\d{4}_[0-9a-f]{4}$/;

// ---------------------------------------------------------------------------
// Saving conversations
//
// Each conversation is stored twice, side by side in memory/conversations/:
//   <id>.jsonl  the exact record, one JSON object per line (the source of truth)
//   <id>.md     a readable copy, rewritten from the .jsonl after every message
// ---------------------------------------------------------------------------

function convPaths(id) {
  return {
    jsonl: path.join(CONV_DIR, id + '.jsonl'),
    md: path.join(CONV_DIR, id + '.md'),
  };
}

async function readConversation(id) {
  let text;
  try {
    text = await fsp.readFile(convPaths(id).jsonl, 'utf8');
  } catch {
    return null;
  }
  const conv = { id, created: null, title: '', messages: [] };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === 'meta') {
      conv.created = rec.created;
      conv.title = rec.title;
    } else if (rec.type === 'msg') {
      conv.messages.push({ role: rec.role, text: rec.text, time: rec.time });
    }
  }
  return conv;
}

function renderMarkdown(conv) {
  const out = [
    '---',
    `id: ${conv.id}`,
    `created: ${conv.created}`,
    `title: ${JSON.stringify(conv.title)}`,
    '---',
    '',
  ];
  for (const m of conv.messages) {
    const who = m.role === 'user' ? 'You' : 'AI';
    out.push(`## ${who} · ${m.time}`, '', m.text, '');
  }
  return out.join('\n');
}

async function writeMarkdown(conv) {
  const { md } = convPaths(conv.id);
  const tmp = md + '.tmp';
  await fsp.writeFile(tmp, renderMarkdown(conv), 'utf8');
  await fsp.rename(tmp, md); // replace in one step so a crash never leaves half a file
}

async function createConversation(firstText) {
  await fsp.mkdir(CONV_DIR, { recursive: true });
  const id = newId();
  const created = localIso();
  const title = firstText.replace(/\s+/g, ' ').trim().slice(0, 60);
  const meta = { type: 'meta', id, created, title };
  await fsp.appendFile(convPaths(id).jsonl, JSON.stringify(meta) + '\n', 'utf8');
  return { id, created, title, messages: [] };
}

async function appendMessage(conv, role, text) {
  const msg = { role, text, time: localIso() };
  const line = JSON.stringify({ type: 'msg', ...msg }) + '\n';
  await fsp.appendFile(convPaths(conv.id).jsonl, line, 'utf8');
  conv.messages.push(msg);
  await writeMarkdown(conv);
  return msg;
}

async function listConversations() {
  let files = [];
  try {
    files = await fsp.readdir(CONV_DIR);
  } catch {
    return [];
  }
  const items = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const id = f.slice(0, -'.jsonl'.length);
    if (!ID_RE.test(id)) continue;
    try {
      const fd = await fsp.open(path.join(CONV_DIR, f), 'r');
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      await fd.close();
      const first = buf.subarray(0, bytesRead).toString('utf8').split('\n')[0];
      const rec = JSON.parse(first);
      items.push({ id, created: rec.created, title: rec.title || '(untitled)' });
    } catch {
      items.push({ id, created: '', title: '(unreadable)' });
    }
  }
  items.sort((a, b) => (a.id < b.id ? 1 : -1)); // newest first
  return items;
}

// ---------------------------------------------------------------------------
// Talking to the AI
// ---------------------------------------------------------------------------

// Keeps the most recent messages, starts on a message from you, and merges
// consecutive messages from the same side (this happens if an earlier AI call failed).
function buildApiMessages(messages) {
  let recent = messages.slice(-config.contextMessages);
  while (recent.length && recent[0].role !== 'user') recent = recent.slice(1);
  const merged = [];
  for (const m of recent) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.text;
    else merged.push({ role: m.role, content: m.text });
  }
  return merged;
}

async function callAI(messages) {
  if (MOCK) {
    return '[test reply] You said: ' + messages[messages.length - 1].text;
  }
  if (!API_KEY) {
    throw new UserError(
      'No API key found. Create a file named .env next to server.js containing the line ' +
        'ANTHROPIC_API_KEY=your-key-here and restart the app. See README.md.'
    );
  }

  let system = '';
  try {
    system = await fsp.readFile(path.join(ROOT, 'prompts', 'system.md'), 'utf8');
  } catch {
    // The app still works without a system prompt.
  }

  const body = {
    model: config.model,
    max_tokens: config.maxTokens,
    messages: buildApiMessages(messages),
  };
  if (system.trim()) body.system = system;

  const res = await fetch(config.apiUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  const raw = await res.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    // Not JSON; handled below.
  }

  if (!res.ok) {
    const detail = (data && data.error && data.error.message) || raw.slice(0, 300);
    throw new UserError(`The AI service returned an error (${res.status}): ${detail}`);
  }

  const text = ((data && data.content) || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  if (!text) throw new UserError('The AI returned an empty reply. Please try again.');
  return text;
}

function friendlyError(err) {
  if (err instanceof UserError) return err.message;
  if (err && err.name === 'TimeoutError') {
    return 'The AI took too long to answer. Please try again.';
  }
  return 'Could not reach the AI service. Check your internet connection.';
}

// ---------------------------------------------------------------------------
// Web server (listens on this computer only)
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const ALLOWED_HOSTS = new Set([`localhost:${config.port}`, `127.0.0.1:${config.port}`]);
const busy = new Set(); // conversations currently waiting for the AI

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

// Only accept requests addressed to this computer's own address. This blocks
// other websites from talking to the app through your browser.
function hostOk(req) {
  return ALLOWED_HOSTS.has(req.headers.host || '');
}

function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin.startsWith('http://') && ALLOWED_HOSTS.has(origin.slice('http://'.length));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1000000) {
        reject(new UserError('That message is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(res, pathname) {
  const publicDir = path.join(ROOT, 'public');
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(publicDir, rel);
  if (!file.startsWith(publicDir + path.sep)) return send(res, 403, { error: 'Forbidden' });
  try {
    const data = await fsp.readFile(file);
    return send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  } catch {
    return send(res, 404, { error: 'Not found' });
  }
}

async function handleChat(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    return send(res, 400, { error: err instanceof UserError ? err.message : 'Bad request' });
  }

  const text = typeof payload.message === 'string' ? payload.message.trim() : '';
  if (!text) return send(res, 400, { error: 'The message is empty.' });

  let conv;
  if (payload.conversationId) {
    if (!ID_RE.test(String(payload.conversationId))) {
      return send(res, 400, { error: 'Bad conversation id' });
    }
    conv = await readConversation(payload.conversationId);
    if (!conv) return send(res, 404, { error: 'Conversation not found' });
  } else {
    conv = await createConversation(text);
  }

  if (busy.has(conv.id)) {
    return send(res, 409, { error: 'Still waiting for the previous reply.' });
  }
  busy.add(conv.id);
  try {
    // Saved before the AI is called, so nothing you write is ever lost.
    await appendMessage(conv, 'user', text);

    let reply;
    try {
      reply = await callAI(conv.messages);
    } catch (err) {
      return send(res, 502, {
        error: friendlyError(err) + ' Your message was saved.',
        conversationId: conv.id,
        saved: true,
      });
    }

    const msg = await appendMessage(conv, 'assistant', reply);
    return send(res, 200, { conversationId: conv.id, title: conv.title, reply, time: msg.time });
  } finally {
    busy.delete(conv.id);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostOk(req)) return send(res, 403, { error: 'Forbidden host' });

    const pathname = new URL(req.url, 'http://localhost').pathname;
    let m;

    if (req.method === 'GET' && pathname === '/api/status') {
      return send(res, 200, {
        hasKey: Boolean(API_KEY),
        mock: MOCK,
        model: config.model,
        memoryDir: MEMORY_DIR,
      });
    }

    if (req.method === 'GET' && pathname === '/api/conversations') {
      return send(res, 200, { conversations: await listConversations() });
    }

    if (req.method === 'GET' && (m = pathname.match(/^\/api\/conversations\/([^/]+)$/))) {
      if (!ID_RE.test(m[1])) return send(res, 400, { error: 'Bad conversation id' });
      const conv = await readConversation(m[1]);
      return conv ? send(res, 200, conv) : send(res, 404, { error: 'Not found' });
    }

    if (req.method === 'POST' && pathname === '/api/chat') {
      const type = req.headers['content-type'] || '';
      if (!originOk(req) || !type.includes('application/json')) {
        return send(res, 403, { error: 'Forbidden' });
      }
      return await handleChat(req, res);
    }

    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      return await serveStatic(res, pathname);
    }

    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('Unexpected error:', err);
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong inside the app.' });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${config.port} is already in use. Close the other copy of the app, ` +
        'or change "port" in config.json.'
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});

fsp
  .mkdir(CONV_DIR, { recursive: true })
  .then(() => {
    server.listen(config.port, '127.0.0.1', () => {
      console.log('');
      console.log('Second Brain is running.');
      console.log(`  Open:     http://localhost:${config.port}`);
      console.log(`  Saving to: ${MEMORY_DIR}`);
      console.log(`  Model:     ${config.model}`);
      console.log(
        `  AI:        ${MOCK ? 'test mode (no real AI)' : API_KEY ? 'API key found' : 'NO API KEY (see README.md)'}`
      );
      console.log('  Stop with Control+C.');
      console.log('');
    });
  })
  .catch((err) => {
    console.error('Could not create the memory folder:', err.message);
    process.exit(1);
  });
