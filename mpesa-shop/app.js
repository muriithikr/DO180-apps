'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { MpesaClient, loadConfig, normalizePhone, parseStkCallback } = require('./lib/mpesa');
const { OrderStore } = require('./lib/store');

const PAYMENT_METHODS = ['mpesa', 'cod'];
// Re-query Daraja for a pending payment at most this often.
const STK_QUERY_INTERVAL_MS = 15000;
// Give the customer time to enter their PIN before we start querying.
const STK_QUERY_GRACE_MS = 20000;

function createApp({
  products = require('./data/products.json'),
  store = new OrderStore(process.env.ORDERS_FILE),
  mpesa = new MpesaClient(loadConfig()),
  callbackToken = process.env.MPESA_CALLBACK_TOKEN || '',
  adminToken = process.env.ADMIN_TOKEN || '',
  logger = console,
} = {}) {
  const app = express();
  const productById = new Map(products.map((p) => [p.id, p]));

  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/healthz', (req, res) => res.json({ ok: true, mpesaMode: mpesa.config.mode }));

  app.get('/api/config', (req, res) => {
    res.json({ currency: 'KES', paymentMethods: PAYMENT_METHODS, mpesaMode: mpesa.config.mode });
  });

  app.get('/api/products', (req, res) => res.json(products));

  // ---- Checkout -----------------------------------------------------------

  app.post('/api/orders', async (req, res) => {
    const { items, customer = {}, paymentMethod } = req.body || {};

    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({ error: 'Choose a payment method' });
    }
    if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
      return res.status(400).json({ error: 'Your cart is empty' });
    }

    // Always price the order on the server; never trust totals from the browser.
    const lines = [];
    for (const it of items) {
      const product = productById.get(it && it.id);
      const qty = Number(it && it.qty);
      if (!product || !Number.isInteger(qty) || qty < 1 || qty > 99) {
        return res.status(400).json({ error: 'Invalid item in cart' });
      }
      lines.push({ id: product.id, name: product.name, price: product.price, qty, subtotal: product.price * qty });
    }
    const total = lines.reduce((sum, l) => sum + l.subtotal, 0);

    const name = String(customer.name || '').trim().slice(0, 100);
    const address = String(customer.address || '').trim().slice(0, 300);
    const phone = normalizePhone(customer.phone);
    if (!name) return res.status(400).json({ error: 'Please enter your name' });
    if (!phone) {
      return res.status(400).json({ error: 'Enter a valid Kenyan mobile number, e.g. 0712 345 678' });
    }

    const order = store.create({
      items: lines,
      total,
      currency: 'KES',
      customer: { name, phone, address },
      paymentMethod,
      status: paymentMethod === 'cod' ? 'confirmed' : 'pending_payment',
      payment: null,
    });

    if (paymentMethod === 'cod') {
      return res.status(201).json(publicOrder(order));
    }

    try {
      await startMpesaPayment(order);
      return res.status(201).json(publicOrder(store.get(order.id)));
    } catch (err) {
      logger.error(`[order ${order.id}] STK push failed:`, err.message);
      store.update(order.id, { status: 'payment_failed', payment: { error: err.message } });
      return res.status(502).json({
        error: 'Could not send the M-Pesa prompt. Please try again.',
        order: publicOrder(store.get(order.id)),
      });
    }
  });

  // Re-send the STK prompt (e.g. the customer cancelled or it timed out).
  app.post('/api/orders/:id/pay', async (req, res) => {
    const order = store.get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.paymentMethod !== 'mpesa') return res.status(400).json({ error: 'Order is not an M-Pesa order' });
    if (order.status === 'paid') return res.status(409).json({ error: 'Order is already paid' });
    if (order.status === 'pending_payment' && order.payment && order.payment.checkoutRequestId &&
        Date.now() - Date.parse(order.payment.requestedAt) < 60000) {
      return res.status(429).json({ error: 'A payment prompt was just sent. Check your phone.' });
    }

    const phone = req.body && req.body.phone ? normalizePhone(req.body.phone) : order.customer.phone;
    if (!phone) return res.status(400).json({ error: 'Enter a valid Kenyan mobile number' });
    store.update(order.id, { customer: { ...order.customer, phone }, status: 'pending_payment' });

    try {
      await startMpesaPayment(store.get(order.id));
      return res.json(publicOrder(store.get(order.id)));
    } catch (err) {
      logger.error(`[order ${order.id}] STK push retry failed:`, err.message);
      store.update(order.id, { status: 'payment_failed', payment: { error: err.message } });
      return res.status(502).json({ error: 'Could not send the M-Pesa prompt. Please try again.' });
    }
  });

  app.get('/api/orders/:id', async (req, res) => {
    let order = store.get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Fallback in case Safaricom's callback never reaches us: query the status.
    if (order.status === 'pending_payment' && order.payment && order.payment.checkoutRequestId && !mpesa.isMock) {
      const now = Date.now();
      const requested = Date.parse(order.payment.requestedAt);
      const lastQuery = order.payment.lastQueryAt ? Date.parse(order.payment.lastQueryAt) : 0;
      if (now - requested > STK_QUERY_GRACE_MS && now - lastQuery > STK_QUERY_INTERVAL_MS) {
        store.update(order.id, { payment: { ...order.payment, lastQueryAt: new Date(now).toISOString() } });
        try {
          const result = await mpesa.stkQuery(order.payment.checkoutRequestId);
          if (result) {
            applyPaymentResult(store.get(order.id), {
              ...result,
              checkoutRequestId: order.payment.checkoutRequestId,
              source: 'query',
            });
          }
        } catch (err) {
          logger.warn(`[order ${order.id}] STK query failed:`, err.message);
        }
        order = store.get(order.id);
      }
    }
    res.json(publicOrder(order));
  });

  // ---- Safaricom callback -------------------------------------------------
  // Daraja does not sign callbacks, so: (1) put a secret token in the callback
  // URL, (2) only accept CheckoutRequestIDs we issued, (3) verify the amount.

  app.post(['/api/mpesa/callback', '/api/mpesa/callback/:token'], (req, res) => {
    // Always answer 200 quickly so Safaricom doesn't retry endlessly.
    const ack = () => res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

    if (callbackToken && !safeEqual(req.params.token || '', callbackToken)) {
      logger.warn('M-Pesa callback rejected: bad token');
      return res.status(403).json({ ResultCode: 1, ResultDesc: 'Forbidden' });
    }
    const cb = parseStkCallback(req.body);
    if (!cb) {
      logger.warn('M-Pesa callback ignored: unrecognised body');
      return ack();
    }
    const order = store.findByCheckoutId(cb.checkoutRequestId);
    if (!order) {
      logger.warn(`M-Pesa callback for unknown CheckoutRequestID ${cb.checkoutRequestId}`);
      return ack();
    }
    applyPaymentResult(order, { ...cb, source: 'callback' });
    return ack();
  });

  // ---- Admin (read-only order list) ---------------------------------------

  app.get('/api/admin/orders', (req, res) => {
    const auth = req.get('authorization') || '';
    if (!adminToken || !safeEqual(auth, `Bearer ${adminToken}`)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    res.json(store.all());
  });

  // ---- Helpers --------------------------------------------------------------

  async function startMpesaPayment(order) {
    const result = await mpesa.stkPush({
      phone: order.customer.phone,
      amount: order.total,
      reference: `ORD${order.id}`.slice(0, 12),
      description: `Order ${order.id}`,
    });
    store.update(order.id, {
      status: 'pending_payment',
      payment: {
        checkoutRequestId: result.checkoutRequestId,
        merchantRequestId: result.merchantRequestId,
        requestedAt: new Date().toISOString(),
      },
    });
    logger.info(`[order ${order.id}] STK push sent (${result.checkoutRequestId})`);

    if (mpesa.isMock) {
      // Simulate the customer's response. Numbers ending in 0000 simulate a cancellation.
      const cancelled = order.customer.phone.endsWith('0000');
      setTimeout(() => {
        const current = store.get(order.id);
        if (!current || current.payment.checkoutRequestId !== result.checkoutRequestId) return;
        applyPaymentResult(current, {
          checkoutRequestId: result.checkoutRequestId,
          resultCode: cancelled ? 1032 : 0,
          resultDesc: cancelled ? 'Request cancelled by user' : 'The service request is processed successfully.',
          amount: order.total,
          receipt: cancelled ? undefined : `MOCK${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
          phone: order.customer.phone,
          source: 'mock',
        });
      }, mpesa.config.mockDelayMs).unref();
    }
  }

  function applyPaymentResult(order, r) {
    if (order.status !== 'pending_payment') return; // already settled; ignore duplicates
    if (!order.payment || order.payment.checkoutRequestId !== r.checkoutRequestId) return; // stale prompt

    if (r.resultCode === 0) {
      if (r.amount !== undefined && Number(r.amount) !== order.total) {
        logger.error(`[order ${order.id}] amount mismatch: paid ${r.amount}, expected ${order.total}`);
        store.update(order.id, {
          status: 'payment_review',
          payment: { ...order.payment, ...paymentDetails(r) },
        });
        return;
      }
      store.update(order.id, {
        status: 'paid',
        payment: { ...order.payment, ...paymentDetails(r), paidAt: new Date().toISOString() },
      });
      logger.info(`[order ${order.id}] PAID via M-Pesa ${r.receipt || ''} (${r.source})`);
    } else {
      store.update(order.id, {
        status: 'payment_failed',
        payment: { ...order.payment, ...paymentDetails(r) },
      });
      logger.info(`[order ${order.id}] payment failed: ${r.resultCode} ${r.resultDesc} (${r.source})`);
    }
  }

  return app;
}

function paymentDetails(r) {
  const d = { resultCode: r.resultCode, resultDesc: r.resultDesc };
  if (r.receipt) d.receipt = r.receipt;
  if (r.transactionDate) d.transactionDate = r.transactionDate;
  return d;
}

/** Order as shown to the customer (hides internal payment identifiers). */
function publicOrder(o) {
  const p = o.payment || {};
  return {
    id: o.id,
    createdAt: o.createdAt,
    status: o.status,
    paymentMethod: o.paymentMethod,
    items: o.items,
    total: o.total,
    currency: o.currency,
    customer: { name: o.customer.name, phone: maskPhone(o.customer.phone), address: o.customer.address },
    payment: {
      receipt: p.receipt || null,
      message: p.resultDesc || null,
    },
  };
}

function maskPhone(phone) {
  return phone ? `${phone.slice(0, 6)}***${phone.slice(-3)}` : '';
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

module.exports = { createApp };
