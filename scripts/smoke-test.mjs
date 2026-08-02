// Exercita api/n8n.ts e api/callback.ts localmente, sem precisar de um n8n
// real: um servidor HTTP local finge ser o webhook do n8n (incluindo o
// callback assincrono) e os handlers das duas Vercel Functions sao
// importados e testados diretamente com requests reais em loopback.
//
// Uso: npm test  (ou: npx tsx scripts/smoke-test.mjs)

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.N8N_WEBHOOK_URL = 'http://localhost:4602/webhook';
process.env.N8N_OUTBOUND_SECRET = 'test-outbound-secret';
process.env.VERCEL_CALLBACK_SECRET = 'test-callback-secret';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const { default: n8nHandler } = await import(pathToFileURL(path.join(repoRoot, 'api/n8n.ts')).href);
const { default: callbackHandler } = await import(pathToFileURL(path.join(repoRoot, 'api/callback.ts')).href);

function wireResponse(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj));
    return res;
  };
  return res;
}

function createHandlerServer(handler) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        req.body = raw ? JSON.parse(raw) : undefined;
      } catch {
        req.body = undefined;
      }
      const url = new URL(req.url, 'http://localhost');
      req.query = Object.fromEntries(url.searchParams);
      wireResponse(res);
      try {
        await handler(req, res);
      } catch (err) {
        console.error('HANDLER THREW:', err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'harness_uncaught' }));
        }
      }
    });
  });
}

// --- Fake n8n: responde as 4 operacoes e, para async-callback, chama de
// volta /api/callback depois de um pequeno atraso, como o Wait do n8n real.
let n8nBehavior = 'normal';
const fakeN8n = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const auth = req.headers.authorization || '';

    if (n8nBehavior === 'reject-auth' || auth !== 'Bearer test-outbound-secret') {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const op = body.operation;
    if (op === 'confirm') {
      res.statusCode = 200;
      res.end(JSON.stringify({ status: 'ok', echoedCorrelationId: body.correlationId }));
    } else if (op === 'transform') {
      res.statusCode = 200;
      res.end(JSON.stringify({
        status: 'processed',
        n8nId: 'n8n-exec-1',
        processedAt: new Date().toISOString(),
        original: body.payload,
      }));
    } else if (op === 'notify') {
      res.statusCode = 200;
      res.end(JSON.stringify({ status: 'accepted', notificationId: 'notif-' + randomUUID() }));
    } else if (op === 'async-callback') {
      res.statusCode = 200;
      res.end(JSON.stringify({ status: 'queued', jobId: 'job-' + randomUUID() }));
      setTimeout(() => {
        const eventBody = JSON.stringify({
          eventId: randomUUID(),
          eventType: 'async-callback',
          correlationId: body.correlationId,
          jobId: 'job-async',
          status: 'completed',
          occurredAt: new Date().toISOString(),
          data: { resultado: 'ok-do-mock' },
        });
        const req2 = http.request(
          {
            hostname: 'localhost',
            port: 4601,
            path: '/api/callback',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(eventBody),
              Authorization: 'Bearer test-callback-secret',
            },
          },
          (r2) => { r2.resume(); }
        );
        req2.on('error', (e) => console.error('mock n8n -> callback POST failed:', e.message));
        req2.write(eventBody);
        req2.end();
      }, 800);
    } else {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'unknown_operation' }));
    }
  });
});

const n8nServer = createHandlerServer(n8nHandler);
const callbackServer = createHandlerServer(callbackHandler);

await new Promise((r) => fakeN8n.listen(4602, r));
await new Promise((r) => n8nServer.listen(4600, r));
await new Promise((r) => callbackServer.listen(4601, r));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('PASS -', name);
  } else {
    fail++;
    console.log('FAIL -', name, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

async function callN8n(port, path_, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(`http://localhost:${port}${path_}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function run() {
  {
    const r = await callN8n(4600, '/api/n8n', { method: 'GET' });
    check('GET /api/n8n -> 405', r.status === 405, r);
  }
  {
    const r = await fetch('http://localhost:4600/api/n8n', { method: 'POST', body: JSON.stringify({ operation: 'confirm' }) });
    check('POST /api/n8n no content-type -> 415', r.status === 415, r.status);
  }
  {
    const r = await callN8n(4600, '/api/n8n', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { operation: 'bogus', payload: {} } });
    check('POST /api/n8n invalid operation -> 400', r.status === 400, r);
  }
  {
    const r = await callN8n(4600, '/api/n8n', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { operation: 'confirm', payload: { nome: 'teste' } } });
    check('confirm -> 200', r.status === 200, r);
    check('confirm -> success true', r.json && r.json.success === true, r.json);
    check('confirm -> correlationId looks like uuid', /^[0-9a-f-]{36}$/i.test(r.json && r.json.correlationId), r.json);
    check('confirm -> data.status ok', r.json && r.json.data && r.json.data.status === 'ok', r.json);
  }
  {
    const r = await callN8n(4600, '/api/n8n', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { operation: 'transform', payload: { valorOriginal: 100 } } });
    check('transform -> 200', r.status === 200, r);
    check('transform -> data has n8nId (novo campo)', r.json && r.json.data && r.json.data.n8nId === 'n8n-exec-1', r.json);
    check('transform -> payload original preservado', r.json && r.json.data && r.json.data.original && r.json.data.original.valorOriginal === 100, r.json);
  }
  {
    const r = await callN8n(4600, '/api/n8n', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { operation: 'notify', payload: { canal: 'teste' } } });
    check('notify -> 200', r.status === 200, r);
    check('notify -> notificationId presente', r.json && r.json.data && typeof r.json.data.notificationId === 'string', r.json);
  }
  {
    const r = await callN8n(4600, '/api/n8n', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { operation: 'async-callback', payload: { documento: 'x' } } });
    check('async-callback -> 200 queued', r.status === 200 && r.json && r.json.data && r.json.data.status === 'queued', r.json);
    const correlationId = r.json && r.json.correlationId;

    let found = null;
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      const poll = await callN8n(4601, '/api/callback?correlationId=' + correlationId, { method: 'GET' });
      if (poll.json && poll.json.found) { found = poll.json.event; break; }
    }
    check('async-callback -> callback recebido eventualmente', !!found, found);
    check('callback -> status completed', found && found.status === 'completed', found);
    check('callback -> correlationId bate', found && found.correlationId === correlationId, found);
  }
  {
    const r = await callN8n(4601, '/api/callback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { eventId: 'e1', correlationId: 'c1' } });
    check('POST /api/callback sem auth -> 401', r.status === 401, r);
  }
  {
    const r = await callN8n(4601, '/api/callback', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer WRONG' }, body: { eventId: 'e1', correlationId: 'c1' } });
    check('POST /api/callback auth errada -> 401', r.status === 401, r);
  }
  {
    const body = { eventId: 'dup-1', correlationId: 'dup-corr-1', eventType: 'async-callback', status: 'completed' };
    const r1 = await callN8n(4601, '/api/callback', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-callback-secret' }, body });
    const r2 = await callN8n(4601, '/api/callback', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-callback-secret' }, body });
    check('POST /api/callback 1a vez -> duplicate:false', r1.json && r1.json.duplicate === false, r1.json);
    check('POST /api/callback eventId repetido -> duplicate:true', r2.json && r2.json.duplicate === true, r2.json);
  }
  {
    const r = await callN8n(4601, '/api/callback', { method: 'GET' });
    check('GET /api/callback sem correlationId -> 400', r.status === 400, r);
  }
  {
    const r = await callN8n(4601, '/api/callback?correlationId=nao-existe', { method: 'GET' });
    check('GET /api/callback correlationId desconhecido -> found:false', r.json && r.json.found === false, r.json);
  }
  {
    const r = await fetch('http://localhost:4600/api/n8n', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json',
    });
    const json = await r.json().catch(() => null);
    check('POST /api/n8n JSON malformado -> 400 invalid_json_body', r.status === 400 && json && json.error === 'invalid_json_body', { status: r.status, json });
  }
  {
    n8nBehavior = 'reject-auth';
    const r = await callN8n(4600, '/api/n8n', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { operation: 'confirm', payload: {} } });
    check('n8n rejeita auth -> proxy devolve 502', r.status === 502, r);
    n8nBehavior = 'normal';
  }
  {
    const saved = process.env.N8N_WEBHOOK_URL;
    delete process.env.N8N_WEBHOOK_URL;
    const r = await callN8n(4600, '/api/n8n', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { operation: 'confirm', payload: {} } });
    check('N8N_WEBHOOK_URL ausente -> 500 server_misconfigured', r.status === 500 && r.json.error === 'server_misconfigured', r);
    process.env.N8N_WEBHOOK_URL = saved;
  }
  {
    const saved = process.env.VERCEL_CALLBACK_SECRET;
    delete process.env.VERCEL_CALLBACK_SECRET;
    const r = await callN8n(4601, '/api/callback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { eventId: 'x', correlationId: 'y' } });
    check('VERCEL_CALLBACK_SECRET ausente -> 500 server_misconfigured', r.status === 500 && r.json.error === 'server_misconfigured', r);
    process.env.VERCEL_CALLBACK_SECRET = saved;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  fakeN8n.close();
  n8nServer.close();
  callbackServer.close();
  process.exit(fail > 0 ? 1 : 0);
}

run();
