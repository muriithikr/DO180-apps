'use strict';

/**
 * Minimal client for Safaricom's Daraja API (Lipa na M-Pesa Online / STK Push).
 *
 * Modes (MPESA_ENV):
 *   - "sandbox"    -> https://sandbox.safaricom.co.ke
 *   - "production" -> https://api.safaricom.co.ke
 *   - "mock"       -> no network calls; payments auto-complete (for local dev/demo)
 *
 * If MPESA_ENV is not set, "mock" is used when no consumer key is configured,
 * otherwise "sandbox".
 */

const BASE_URLS = {
  sandbox: 'https://sandbox.safaricom.co.ke',
  production: 'https://api.safaricom.co.ke',
};

// Public sandbox test shortcode/passkey published by Safaricom for STK Push testing.
const SANDBOX_SHORTCODE = '174379';
const SANDBOX_PASSKEY = 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';

function loadConfig(env = process.env) {
  const mode = env.MPESA_ENV || (env.MPESA_CONSUMER_KEY ? 'sandbox' : 'mock');
  if (!['sandbox', 'production', 'mock'].includes(mode)) {
    throw new Error(`Invalid MPESA_ENV "${mode}" (expected sandbox, production or mock)`);
  }
  const cfg = {
    mode,
    baseUrl: BASE_URLS[mode] || null,
    consumerKey: env.MPESA_CONSUMER_KEY || '',
    consumerSecret: env.MPESA_CONSUMER_SECRET || '',
    shortcode: env.MPESA_SHORTCODE || (mode === 'sandbox' ? SANDBOX_SHORTCODE : ''),
    passkey: env.MPESA_PASSKEY || (mode === 'sandbox' ? SANDBOX_PASSKEY : ''),
    // CustomerPayBillOnline (paybill) or CustomerBuyGoodsOnline (till number)
    transactionType: env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline',
    // For till numbers the PartyB differs from the BusinessShortCode (store number vs till).
    partyB: env.MPESA_PARTY_B || '',
    callbackUrl: env.MPESA_CALLBACK_URL || '',
    accountReference: env.MPESA_ACCOUNT_REFERENCE || 'MpesaShop',
    mockDelayMs: Number(env.MPESA_MOCK_DELAY_MS || 6000),
  };
  if (mode !== 'mock') {
    const missing = ['consumerKey', 'consumerSecret', 'shortcode', 'passkey', 'callbackUrl']
      .filter((k) => !cfg[k]);
    if (missing.length) {
      throw new Error(`M-Pesa ${mode} mode is missing config: ${missing.join(', ')}`);
    }
    if (!/^https:\/\//.test(cfg.callbackUrl)) {
      throw new Error('MPESA_CALLBACK_URL must be a public https:// URL reachable by Safaricom');
    }
  }
  return cfg;
}

/**
 * Normalise a Kenyan mobile number to the 2547XXXXXXXX / 2541XXXXXXXX format Daraja expects.
 * Returns null if the number is not a valid Safaricom-style mobile number.
 */
function normalizePhone(input) {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const digits = String(input).replace(/[\s\-()]/g, '').replace(/^\+/, '');
  let m;
  if ((m = /^0([17]\d{8})$/.exec(digits))) return `254${m[1]}`;
  if ((m = /^254([17]\d{8})$/.exec(digits))) return `254${m[1]}`;
  if ((m = /^([17]\d{8})$/.exec(digits))) return `254${m[1]}`;
  return null;
}

/** Daraja timestamp: YYYYMMDDHHmmss in East Africa Time (UTC+3). */
function timestamp(date = new Date()) {
  const eat = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return (
    eat.getUTCFullYear() +
    p(eat.getUTCMonth() + 1) +
    p(eat.getUTCDate()) +
    p(eat.getUTCHours()) +
    p(eat.getUTCMinutes()) +
    p(eat.getUTCSeconds())
  );
}

function stkPassword(shortcode, passkey, ts) {
  return Buffer.from(`${shortcode}${passkey}${ts}`).toString('base64');
}

class MpesaClient {
  constructor(config = loadConfig(), { fetchImpl = globalThis.fetch } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this._token = null;
    this._tokenExpiresAt = 0;
  }

  get isMock() {
    return this.config.mode === 'mock';
  }

  async getAccessToken() {
    if (this._token && Date.now() < this._tokenExpiresAt) return this._token;
    const { baseUrl, consumerKey, consumerSecret } = this.config;
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const res = await this.fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    const body = await safeJson(res);
    if (!res.ok || !body.access_token) {
      throw new Error(`M-Pesa auth failed (${res.status}): ${JSON.stringify(body)}`);
    }
    this._token = body.access_token;
    // Refresh a minute before the token actually expires.
    this._tokenExpiresAt = Date.now() + (Number(body.expires_in || 3599) - 60) * 1000;
    return this._token;
  }

  /**
   * Send an STK Push prompt to the customer's phone.
   * Resolves to { merchantRequestId, checkoutRequestId, customerMessage }.
   */
  async stkPush({ phone, amount, reference, description }) {
    const msisdn = normalizePhone(phone);
    if (!msisdn) throw new Error('Invalid phone number');
    const amt = Math.round(Number(amount));
    if (!Number.isFinite(amt) || amt < 1) throw new Error('Invalid amount');

    if (this.isMock) {
      const id = `ws_CO_MOCK_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      return {
        merchantRequestId: `MOCK-${Date.now()}`,
        checkoutRequestId: id,
        customerMessage: 'Mock mode: payment will auto-complete in a few seconds',
      };
    }

    const { baseUrl, shortcode, passkey, transactionType, partyB, callbackUrl } = this.config;
    const ts = timestamp();
    const payload = {
      BusinessShortCode: shortcode,
      Password: stkPassword(shortcode, passkey, ts),
      Timestamp: ts,
      TransactionType: transactionType,
      Amount: amt,
      PartyA: msisdn,
      PartyB: partyB || shortcode,
      PhoneNumber: msisdn,
      CallBackURL: callbackUrl,
      AccountReference: String(reference || this.config.accountReference).slice(0, 12),
      TransactionDesc: String(description || 'Payment').slice(0, 13),
    };
    const token = await this.getAccessToken();
    const res = await this.fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await safeJson(res);
    if (!res.ok || String(body.ResponseCode) !== '0') {
      const msg = body.errorMessage || body.ResponseDescription || JSON.stringify(body);
      throw new Error(`STK Push failed: ${msg}`);
    }
    return {
      merchantRequestId: body.MerchantRequestID,
      checkoutRequestId: body.CheckoutRequestID,
      customerMessage: body.CustomerMessage,
    };
  }

  /**
   * Ask Daraja for the status of an STK Push (used when the callback is slow or lost).
   * Resolves to { resultCode, resultDesc } or null if the request is still processing.
   */
  async stkQuery(checkoutRequestId) {
    if (this.isMock) return null;
    const { baseUrl, shortcode, passkey } = this.config;
    const ts = timestamp();
    const token = await this.getAccessToken();
    const res = await this.fetch(`${baseUrl}/mpesa/stkpushquery/v1/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: stkPassword(shortcode, passkey, ts),
        Timestamp: ts,
        CheckoutRequestID: checkoutRequestId,
      }),
    });
    const body = await safeJson(res);
    // While the customer hasn't responded yet Daraja returns an error like
    // "The transaction is being processed" (errorCode 500.001.1001).
    if (!res.ok || body.ResultCode === undefined) return null;
    return { resultCode: Number(body.ResultCode), resultDesc: body.ResultDesc };
  }
}

/** Parse the body Safaricom POSTs to the callback URL. */
function parseStkCallback(body) {
  const cb = body && body.Body && body.Body.stkCallback;
  if (!cb || !cb.CheckoutRequestID) return null;
  const meta = {};
  for (const item of (cb.CallbackMetadata && cb.CallbackMetadata.Item) || []) {
    meta[item.Name] = item.Value;
  }
  return {
    merchantRequestId: cb.MerchantRequestID,
    checkoutRequestId: cb.CheckoutRequestID,
    resultCode: Number(cb.ResultCode),
    resultDesc: cb.ResultDesc,
    amount: meta.Amount,
    receipt: meta.MpesaReceiptNumber,
    phone: meta.PhoneNumber ? String(meta.PhoneNumber) : undefined,
    transactionDate: meta.TransactionDate ? String(meta.TransactionDate) : undefined,
  };
}

async function safeJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

module.exports = { MpesaClient, loadConfig, normalizePhone, timestamp, stkPassword, parseStkCallback };
