// Golden-set runner for specs/002-ai-assist (T034, SC-006/SC-007). Run inside the api container:
//   docker compose exec -T api node /repo/specs/002-ai-assist/golden/run-golden.mjs
// It assumes the acme tenant already has a provider key, a reply mode of Auto-reply and a store
// connection. It loads policy.md (replacing a policy with the same title), then asks each question in
// questions.md as customer@acme.test in its own ticket, closing the ticket after the answer. It writes
// the raw transcript to golden/last-run.json; grading goes into results.md by hand.
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = process.env.GOLDEN_API ?? 'http://localhost:3000/api/v1';
const HOST = process.env.GOLDEN_HOST ?? 'acme.localhost:5173';
const MAILPIT = process.env.GOLDEN_MAILPIT ?? 'http://mailpit:8025';
const STAFF = { email: 'admin@acme.test', password: 'password-123456' };
const CUSTOMER = 'customer@acme.test';
const POLICY_TITLE = 'Golden: returns, refunds and shipping';
const ANSWER_WAIT_MS = 90_000;
const args = process.argv.slice(2);
const only = args.map(Number).filter(Boolean);
// Dev only: `--fake-key` saves a placeholder provider key (AI_PROVIDER=fake), and `--store <url>`
// connects the store with SPREE_DEV_API_KEY. Both also set Auto-reply. A real run sets these in the UI.
const fakeKey = args.includes('--fake-key');
const storeUrl = args.includes('--store') ? args[args.indexOf('--store') + 1] : undefined;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// node:http, not fetch: fetch drops the Host header, and the API resolves the tenant from it.
function send(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers: body === undefined ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = res.headers['set-cookie'] ?? [];
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), setCookies: Array.isArray(raw) ? raw : [raw] });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function client() {
  const jar = new Map();
  async function call(method, path, body) {
    const headers = { Host: HOST, Accept: 'application/json', Origin: `http://${HOST}` };
    if (jar.size > 0) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (jar.has('rx_csrf')) headers['X-CSRF-Token'] = jar.get('rx_csrf');
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await send(method, `${API}${path}`, headers, body === undefined ? undefined : JSON.stringify(body));
    for (const line of response.setCookies) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
    const text = response.text;
    const json = text === '' ? null : JSON.parse(text);
    if (response.status >= 400) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
    return json;
  }
  return call;
}

async function signInCustomer(call) {
  const since = Date.now();
  await call('POST', '/customer/auth/sign-in-link', { email: CUSTOMER });
  for (let i = 0; i < 40; i++) {
    const { messages } = await (await fetch(`${MAILPIT}/api/v1/messages?limit=20`)).json();
    const mail = messages.find((m) => m.To.some((t) => t.Address === CUSTOMER) && /sign-in link/i.test(m.Subject) && Date.parse(m.Created) >= since - 2000);
    if (mail) {
      const body = JSON.stringify(await (await fetch(`${MAILPIT}/api/v1/message/${mail.ID}`)).json());
      const token = /[?&]token=([A-Za-z0-9_\-.%]+)/.exec(body)?.[1];
      if (!token) throw new Error('No token in the sign-in email');
      await call('POST', '/customer/auth/sign-in-link/redeem', { token: decodeURIComponent(token), trustDevice: false });
      return;
    }
    await sleep(500);
  }
  throw new Error('No sign-in email');
}

function parseQuestions() {
  const rows = readFileSync(join(HERE, 'questions.md'), 'utf8').split(/\r?\n/).filter((l) => /^\| \d+ \|/.test(l));
  return rows.map((l) => {
    const [, n, q, e] = l.split('|').map((c) => c.trim());
    return { n: Number(n), question: q, expected: e };
  });
}

async function loadPolicy(staff) {
  const text = readFileSync(join(HERE, 'policy.md'), 'utf8');
  const { items } = await staff('GET', '/ai/policies');
  for (const doc of items) if (doc.title === POLICY_TITLE) await staff('DELETE', `/ai/policies/${doc.id}`);
  const doc = await staff('POST', '/ai/policies', { title: POLICY_TITLE, text });
  for (let i = 0; i < 120; i++) {
    const { items: now } = await staff('GET', '/ai/policies');
    const current = now.find((d) => d.id === doc.id);
    if (current?.status === 'ready') return current;
    if (current?.status === 'failed') throw new Error(`Policy indexing failed: ${JSON.stringify(current)}`);
    await sleep(1000);
  }
  throw new Error('Policy not ready after 120 s');
}

const messagesOf = (conversation) => conversation.items.filter((item) => item.type === 'message').map((item) => item.message);

/** Closes the customer's active tickets, so the next message starts a new ticket (follow-up). */
async function closeActive(staff, customerId) {
  for (const state of ['new', 'open', 'pending_reminder', 'pending_close', 'resolved']) {
    const { items } = await staff('GET', `/tickets?customerId=${customerId}&state=${state}`);
    for (const ticket of items) {
      for (const next of state === 'resolved' ? ['closed'] : ['resolved', 'closed']) {
        try { await staff('PATCH', `/tickets/${ticket.id}`, { state: next }); } catch (error) { console.log(`  close #${ticket.number}: ${error.message}`); }
      }
    }
  }
}

async function main() {
  const staff = client();
  await staff('POST', '/auth/sign-in', STAFF);
  if (fakeKey) await staff('PUT', '/ai/settings/provider-key', { apiKey: 'sk-or-v1-golden-dryrun-fake-GOLD' });
  if (storeUrl) {
    await staff('PUT', '/ai/store-connection', { kind: 'spree', baseUrl: storeUrl, apiKey: process.env.SPREE_DEV_API_KEY });
    await staff('POST', '/ai/store-connection/test');
  }
  if (fakeKey || storeUrl) await staff('PATCH', '/ai/settings', { replyMode: 'auto' });
  const settings = await staff('GET', '/ai/settings');
  console.log(`reply mode ${settings.replyMode}, paused ${JSON.stringify(settings.paused ?? null)}`);
  const policy = await loadPolicy(staff);
  console.log(`policy ${policy.id} ready`);

  const customer = client();
  await signInCustomer(customer);
  const me = await customer('GET', '/customer/me');
  const results = [];
  for (const q of parseQuestions()) {
    if (only.length > 0 && !only.includes(q.n)) continue;
    await closeActive(staff, me.id);
    const before = messagesOf(await customer('GET', '/customer/conversation'));
    const seen = new Set(before.map((m) => m.id));
    const sentAt = new Date().toISOString();
    await customer('POST', '/customer/messages', { body: q.question, clientMessageId: randomUUID() });
    let replies = [];
    const deadline = Date.now() + ANSWER_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(2000);
      replies = messagesOf(await customer('GET', '/customer/conversation')).filter((m) => !seen.has(m.id) && m.from.kind !== 'me');
      if (replies.length > 0) {
        await sleep(3000); // a hand-off notice or a second part may follow
        replies = messagesOf(await customer('GET', '/customer/conversation')).filter((m) => !seen.has(m.id) && m.from.kind !== 'me');
        break;
      }
    }
    const { items: runs } = await staff('GET', `/ai/runs?from=${encodeURIComponent(sentAt)}`);
    const ticketId = runs.find((r) => r.ticket?.id)?.ticket.id;
    let ticket = null;
    if (ticketId) ticket = await staff('GET', `/tickets/${ticketId}`);
    const chatRuns = runs.filter((r) => r.purpose === 'reply');
    const row = {
      n: q.n,
      question: q.question,
      expected: q.expected,
      replies: replies.map((m) => ({ isAi: m.isAi ?? false, from: m.from.name ?? m.from.kind, body: m.body })),
      handedOff: ticket?.ai?.stoppedReason === 'handoff',
      ticketNumber: ticket?.number ?? null,
      levels: chatRuns.map((r) => r.level),
      models: [...new Set(chatRuns.map((r) => r.model))],
      outcomes: runs.map((r) => `${r.purpose}:${r.outcome}`),
      costUsd: runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
    };
    results.push(row);
    console.log(`#${q.n} ${row.handedOff ? '[hand-off] ' : ''}${row.levels.join(',')} :: ${row.replies.map((r) => r.body).join(' / ').slice(0, 300)}`);
    await sleep(1500);
  }
  writeFileSync(join(HERE, 'last-run.json'), `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
