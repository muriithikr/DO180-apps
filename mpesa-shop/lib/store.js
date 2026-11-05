'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Tiny order store. Keeps orders in memory and, if a file path is given,
 * persists them as JSON so they survive restarts. Swap for a real database
 * (PostgreSQL, MySQL, MongoDB...) before running at scale.
 */
class OrderStore {
  constructor(file) {
    this.file = file || null;
    this.orders = new Map();
    if (this.file && fs.existsSync(this.file)) {
      for (const o of JSON.parse(fs.readFileSync(this.file, 'utf8'))) this.orders.set(o.id, o);
    }
  }

  create(fields) {
    const now = new Date().toISOString();
    const order = {
      id: crypto.randomBytes(6).toString('hex').toUpperCase(),
      createdAt: now,
      updatedAt: now,
      ...fields,
    };
    this.orders.set(order.id, order);
    this._save();
    return order;
  }

  get(id) {
    return this.orders.get(id) || null;
  }

  findByCheckoutId(checkoutRequestId) {
    for (const o of this.orders.values()) {
      if (o.payment && o.payment.checkoutRequestId === checkoutRequestId) return o;
    }
    return null;
  }

  update(id, patch) {
    const o = this.orders.get(id);
    if (!o) return null;
    Object.assign(o, patch, { updatedAt: new Date().toISOString() });
    this._save();
    return o;
  }

  all() {
    return [...this.orders.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  _save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.all(), null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { OrderStore };
