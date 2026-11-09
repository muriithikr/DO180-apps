'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../app');
const { MpesaClient, loadConfig, normalizePhone, timestamp, stkPassword, parseStkCallback } = require('../lib/mpesa');
const { OrderStore } = require('../lib/store');

const quiet = { info() {}, warn() {}, error() {} };
const products = [{ id: 'a', name: 'Thing', price: 150, image: 'x', description: '' }];

async function withServer(opts, fn) {
  const app = createApp({ products, store: new OrderStore(), logger: quiet, ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  try { await fn(call); } finally { server.close(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('normalizePhone accepts common Kenyan formats', () => {
  assert.equal(normalizePhone('0712345678'), '254712345678');
  assert.equal(normalizePhone('+254 712 345 678'), '254712345678');
  assert.equal(normalizePhone('254112345678'), '254112345678');
  assert.equal(normalizePhone('712345678'), '254712345678');
  assert.equal(normalizePhone('0812345678'), null);
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone(undefined), null);
});

test('timestamp is EAT and password is base64(shortcode+passkey+ts)', () => {
  assert.equal(timestamp(new Date('2026-01-31T22:30:05Z')), '20260201013005');
  assert.equal(Buffer.from(stkPassword('1', 'k', '2'), 'base64').toString(), '1k2');
});

test('loadConfig defaults to mock without credentials and validates live config', () => {
  assert.equal(loadConfig({}).mode, 'mock');
  assert.throws(() => loadConfig({ MPESA_ENV: 'production' }), /missing config/);
  assert.throws(
    () => loadConfig({ MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's', MPESA_CALLBACK_URL: 'http://x' }),
    /https/,
  );
  for (const bad of ['https://shop.example/api/mpesa/callback/t', 'https://shop.example/M-Pesa/cb', 'https://safaricom-pay.example/cb']) {
    assert.throws(
      () => loadConfig({ MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's', MPESA_CALLBACK_URL: bad }),
      /must not contain "mpesa"/,
    );
  }
  assert.equal(
    loadConfig({ MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's', MPESA_CALLBACK_URL: 'https://shop.example/api/payments/callback/t' }).mode,
    'sandbox',
  );
});

test('parseStkCallback extracts metadata', () => {
  const cb = parseStkCallback({ Body: { stkCallback: {
    MerchantRequestID: 'm', CheckoutRequestID: 'c', ResultCode: 0, ResultDesc: 'ok',
    CallbackMetadata: { Item: [
      { Name: 'Amount', Value: 150 }, { Name: 'MpesaReceiptNumber', Value: 'R1' }, { Name: 'PhoneNumber', Value: 254712345678 },
    ] },
  } } });
  assert.deepEqual(
    [cb.checkoutRequestId, cb.resultCode, cb.amount, cb.receipt, cb.phone],
    ['c', 0, 150, 'R1', '254712345678'],
  );
});

test('stkPush sends a correct Daraja request', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    const json = url.includes('oauth')
      ? { access_token: 'tok', expires_in: '3599' }
      : { ResponseCode: '0', MerchantRequestID: 'M1', CheckoutRequestID: 'C1', CustomerMessage: 'ok' };
    return { ok: true, status: 200, text: async () => JSON.stringify(json) };
  };
  const cfg = loadConfig({
    MPESA_ENV: 'sandbox', MPESA_CONSUMER_KEY: 'k', MPESA_CONSUMER_SECRET: 's',
    MPESA_CALLBACK_URL: 'https://example.com/api/payments/callback/t',
  });
  const client = new MpesaClient(cfg, { fetchImpl });
  const r = await client.stkPush({ phone: '0712345678', amount: 150.4, reference: 'ORDABC', description: 'Order ABC' });
  assert.equal(r.checkoutRequestId, 'C1');
  assert.match(calls[0].url, /oauth\/v1\/generate/);
  assert.equal(calls[0].opts.headers.Authorization, `Basic ${Buffer.from('k:s').toString('base64')}`);
  const body = JSON.parse(calls[1].opts.body);
  assert.equal(calls[1].opts.headers.Authorization, 'Bearer tok');
  assert.equal(body.Amount, 150);
  assert.equal(body.PartyA, '254712345678');
  assert.equal(body.BusinessShortCode, '174379');
  assert.equal(body.CallBackURL, 'https://example.com/api/payments/callback/t');
  // Token is cached between calls.
  await client.stkPush({ phone: '0712345678', amount: 1 });
  assert.equal(calls.filter((c) => c.url.includes('oauth')).length, 1);
});

test('server prices orders itself and rejects bad input', async () => {
  const mpesa = new MpesaClient(loadConfig({ MPESA_MOCK_DELAY_MS: '50' }));
  await withServer({ mpesa }, async (call) => {
    let r = await call('POST', '/api/orders', { items: [{ id: 'a', qty: 2, price: 1 }], customer: { name: 'A', phone: '0712345678' }, paymentMethod: 'cod' });
    assert.equal(r.status, 201);
    assert.equal(r.body.total, 300);
    assert.equal(r.body.status, 'confirmed');
    assert.equal(r.body.customer.phone, '254712***678');

    r = await call('POST', '/api/orders', { items: [{ id: 'nope', qty: 1 }], customer: { name: 'A', phone: '0712345678' }, paymentMethod: 'cod' });
    assert.equal(r.status, 400);
    r = await call('POST', '/api/orders', { items: [{ id: 'a', qty: 1 }], customer: { name: 'A', phone: '123' }, paymentMethod: 'mpesa' });
    assert.equal(r.status, 400);
    r = await call('POST', '/api/orders', { items: [{ id: 'a', qty: 1 }], customer: { name: 'A', phone: '0712345678' }, paymentMethod: 'paypal' });
    assert.equal(r.status, 400);
  });
});

test('mock M-Pesa payment completes and cancellation can be retried', async () => {
  const mpesa = new MpesaClient(loadConfig({ MPESA_MOCK_DELAY_MS: '50' }));
  await withServer({ mpesa }, async (call) => {
    let r = await call('POST', '/api/orders', { items: [{ id: 'a', qty: 1 }], customer: { name: 'A', phone: '0712345678' }, paymentMethod: 'mpesa' });
    assert.equal(r.body.status, 'pending_payment');
    await sleep(120);
    r = await call('GET', `/api/orders/${r.body.id}`);
    assert.equal(r.body.status, 'paid');
    assert.match(r.body.payment.receipt, /^MOCK/);

    r = await call('POST', '/api/orders', { items: [{ id: 'a', qty: 1 }], customer: { name: 'B', phone: '0700000000' }, paymentMethod: 'mpesa' });
    const id = r.body.id;
    await sleep(120);
    r = await call('GET', `/api/orders/${id}`);
    assert.equal(r.body.status, 'payment_failed');
    r = await call('POST', `/api/orders/${id}/pay`, { phone: '0712345678' });
    assert.equal(r.status, 200);
    await sleep(120);
    r = await call('GET', `/api/orders/${id}`);
    assert.equal(r.body.status, 'paid');
  });
});

test('callback marks order paid, checks token and amount', async () => {
  let n = 0;
  const mpesa = {
    config: { mode: 'sandbox' },
    isMock: false,
    stkPush: async () => ({ checkoutRequestId: `C${++n}`, merchantRequestId: 'M' }),
    stkQuery: async () => null,
  };
  const cb = (id, amount, code = 0) => ({ Body: { stkCallback: {
    MerchantRequestID: 'M', CheckoutRequestID: id, ResultCode: code, ResultDesc: code ? 'Cancelled' : 'ok',
    CallbackMetadata: code ? undefined : { Item: [{ Name: 'Amount', Value: amount }, { Name: 'MpesaReceiptNumber', Value: 'QWE123' }] },
  } } });

  await withServer({ mpesa, callbackToken: 'sekret' }, async (call) => {
    const o1 = (await call('POST', '/api/orders', { items: [{ id: 'a', qty: 1 }], customer: { name: 'A', phone: '0712345678' }, paymentMethod: 'mpesa' })).body;
    const o2 = (await call('POST', '/api/orders', { items: [{ id: 'a', qty: 1 }], customer: { name: 'A', phone: '0712345678' }, paymentMethod: 'mpesa' })).body;

    assert.equal((await call('POST', '/api/payments/callback/wrong', cb('C1', 150))).status, 403);
    assert.equal((await call('POST', '/api/payments/callback', cb('C1', 150))).status, 403);
    assert.equal((await call('GET', `/api/orders/${o1.id}`)).body.status, 'pending_payment');

    assert.equal((await call('POST', '/api/payments/callback/sekret', cb('C1', 150))).status, 200);
    let r = await call('GET', `/api/orders/${o1.id}`);
    assert.equal(r.body.status, 'paid');
    assert.equal(r.body.payment.receipt, 'QWE123');

    // Duplicate failure callback for an already-paid order is ignored.
    await call('POST', '/api/payments/callback/sekret', cb('C1', 150, 1032));
    assert.equal((await call('GET', `/api/orders/${o1.id}`)).body.status, 'paid');

    // Wrong amount is flagged for review instead of being marked paid (sent to the legacy path).
    assert.equal((await call('POST', '/api/mpesa/callback/sekret', cb('C2', 1))).status, 200);
    assert.equal((await call('GET', `/api/orders/${o2.id}`)).body.status, 'payment_review');
  });
});

test('admin endpoint requires token', async () => {
  await withServer({ adminToken: 'adm' }, async (call) => {
    assert.equal((await call('GET', '/api/admin/orders')).status, 401);
    assert.equal((await call('GET', '/api/admin/orders', null, { Authorization: 'Bearer adm' })).status, 200);
  });
});
