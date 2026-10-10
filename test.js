// Self-test for the app. Run it with:  node test.js
// It starts the app against a FAKE AI service and a temporary memory folder,
// so it never uses your real API key, costs nothing, and never touches your real memory.
'use strict';

const assert = require('assert');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok    ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL  ' + name + '\n        ' + (err && err.message));
  }
}

function request({ port, method = 'GET', pathName, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathName,
        headers: { Host: `localhost:${port}`, ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode, text, json });
        });
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// A stand-in for the AI service that records what it receives.
function startFakeApi() {
  const seen = [];
  let mode = 'ok';
  let count = 0;
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({ headers: req.headers, body });
      if (mode === 'fail') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'fake failure' } }));
        return;
      }
      count++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'fake reply ' + count }] }));
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () =>
      resolve({
        srv,
        seen,
        port: srv.address().port,
        setMode: (m) => {
          mode = m;
        },
      })
    )
  );
}

function startApp(env) {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('app did not start: ' + out)), 8000);
    const poll = setInterval(() => {
      if (out.includes('is running')) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(child);
      }
    }, 50);
    child.on('exit', () => {
      clearTimeout(timer);
      clearInterval(poll);
      reject(new Error('app exited early: ' + out));
    });
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'second-brain-test-'));
  const memoryDir = path.join(tmp, 'memory');
  const convDir = path.join(memoryDir, 'conversations');
  const fake = await startFakeApi();
  const apiUrl = `http://127.0.0.1:${fake.port}/v1/messages`;
  const port = await freePort();
  const noKeyPort = await freePort();
  const noKeyMemory = path.join(tmp, 'memory-nokey');

  const baseEnv = { MOCK_AI: '', ANTHROPIC_API_URL: apiUrl };
  const app = await startApp({
    ...baseEnv,
    PORT: String(port),
    MEMORY_DIR: memoryDir,
    ANTHROPIC_API_KEY: 'test-key',
  });
  const appNoKey = await startApp({
    ...baseEnv,
    PORT: String(noKeyPort),
    MEMORY_DIR: noKeyMemory,
    ANTHROPIC_API_KEY: '',
  });

  const chat = (body, headers = {}, p = port) =>
    request({
      port: p,
      method: 'POST',
      pathName: '/api/chat',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  console.log('\nRunning checks\n');
  let convId = null;

  await check('status reports a key without revealing it', async () => {
    const r = await request({ port, pathName: '/api/status' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.hasKey, true);
    assert.ok(!r.text.includes('test-key'), 'the key must never appear in a response');
  });

  await check('the chat page is served', async () => {
    const r = await request({ port, pathName: '/' });
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.includes('<title>Second Brain</title>'));
  });

  await check('first message creates a conversation and returns the reply', async () => {
    const r = await chat({ message: 'hello there' });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.reply, 'fake reply 1');
    assert.match(r.json.conversationId, /^\d{4}-\d{2}-\d{2}_\d{4}_[0-9a-f]{4}$/);
    convId = r.json.conversationId;
  });

  await check('the conversation is saved as .jsonl and a readable .md', async () => {
    const md = fs.readFileSync(path.join(convDir, convId + '.md'), 'utf8');
    assert.ok(fs.existsSync(path.join(convDir, convId + '.jsonl')));
    assert.ok(md.includes('## You'));
    assert.ok(md.includes('hello there'));
    assert.ok(md.includes('## AI'));
    assert.ok(md.includes('fake reply 1'));
  });

  await check('the AI request has the right key, version, model, system prompt and messages', async () => {
    const req = fake.seen[0];
    assert.strictEqual(req.headers['x-api-key'], 'test-key');
    assert.strictEqual(req.headers['anthropic-version'], '2023-06-01');
    assert.strictEqual(req.body.model, 'claude-sonnet-5-5');
    assert.ok(req.body.system.includes('thinking partner'));
    assert.deepStrictEqual(req.body.messages, [{ role: 'user', content: 'hello there' }]);
  });

  await check('a second message sends the whole conversation so far', async () => {
    const r = await chat({ conversationId: convId, message: 'and another thing' });
    assert.strictEqual(r.status, 200, r.text);
    const roles = fake.seen[1].body.messages.map((m) => m.role);
    assert.deepStrictEqual(roles, ['user', 'assistant', 'user']);
  });

  await check('the conversation appears in the list with its title', async () => {
    const r = await request({ port, pathName: '/api/conversations' });
    assert.strictEqual(r.json.conversations.length, 1);
    assert.strictEqual(r.json.conversations[0].title, 'hello there');
  });

  await check('a saved conversation can be loaded back', async () => {
    const r = await request({ port, pathName: '/api/conversations/' + convId });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(
      r.json.messages.map((m) => m.role),
      ['user', 'assistant', 'user', 'assistant']
    );
  });

  await check('if the AI fails, the message is still saved and the error is explained', async () => {
    fake.setMode('fail');
    const r = await chat({ conversationId: convId, message: 'saved-even-if-ai-fails' });
    assert.strictEqual(r.status, 502);
    assert.ok(r.json.error.includes('fake failure'));
    assert.ok(r.json.error.includes('saved'));
    const saved = await request({ port, pathName: '/api/conversations/' + convId });
    assert.strictEqual(saved.json.messages.length, 5);
    assert.strictEqual(saved.json.messages[4].text, 'saved-even-if-ai-fails');
  });

  await check('after a failure, the unanswered message is merged into the next request', async () => {
    fake.setMode('ok');
    const r = await chat({ conversationId: convId, message: 'trying again' });
    assert.strictEqual(r.status, 200, r.text);
    const last = fake.seen[fake.seen.length - 1].body.messages;
    assert.deepStrictEqual(
      last.map((m) => m.role),
      ['user', 'assistant', 'user', 'assistant', 'user']
    );
    assert.ok(last[4].content.includes('saved-even-if-ai-fails'));
    assert.ok(last[4].content.includes('trying again'));
  });

  await check('an empty message is rejected', async () => {
    const r = await chat({ message: '   ' });
    assert.strictEqual(r.status, 400);
  });

  await check('requests addressed to another host are refused', async () => {
    const r = await request({ port, pathName: '/api/status', headers: { Host: 'evil.example' } });
    assert.strictEqual(r.status, 403);
  });

  await check('posts from another website are refused', async () => {
    const r = await chat({ message: 'x' }, { Origin: 'http://evil.example' });
    assert.strictEqual(r.status, 403);
  });

  await check('posts that are not JSON are refused', async () => {
    const r = await request({
      port,
      method: 'POST',
      pathName: '/api/chat',
      headers: { 'Content-Type': 'text/plain' },
      body: '{"message":"x"}',
    });
    assert.strictEqual(r.status, 403);
  });

  await check('files outside public/ cannot be read', async () => {
    for (const p of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js']) {
      const r = await request({ port, pathName: p });
      assert.notStrictEqual(r.status, 200, p);
      assert.ok(!r.text.includes('createServer'), p);
    }
  });

  await check('a bad conversation id is refused', async () => {
    const r = await request({ port, pathName: '/api/conversations/..%2F..%2Fetc' });
    assert.strictEqual(r.status, 400);
  });

  await check('without an API key the message is saved and the fix is explained', async () => {
    const r = await chat({ message: 'no key yet' }, {}, noKeyPort);
    assert.strictEqual(r.status, 502);
    assert.ok(r.json.error.includes('.env'));
    assert.ok(r.json.error.includes('saved'));
    const md = fs.readFileSync(
      path.join(noKeyMemory, 'conversations', r.json.conversationId + '.md'),
      'utf8'
    );
    assert.ok(md.includes('no key yet'));
  });

  await check('the page never inserts text as HTML', async () => {
    const js = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
    assert.ok(!js.includes('innerHTML'));
  });

  app.kill();
  appNoKey.kill();
  fake.srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
