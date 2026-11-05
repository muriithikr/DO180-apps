(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const fmt = (n) => `KES ${Number(n).toLocaleString('en-KE')}`;
  const CART_KEY = 'duka-cart';
  const ORDER_KEY = 'duka-pending-order';
  const POLL_MS = 3000;
  const POLL_TIMEOUT_MS = 2.5 * 60 * 1000;

  let products = [];
  let cart = load(CART_KEY, {}); // { productId: qty }
  let pollTimer = null;

  function load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
  }
  function save(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch { /* storage unavailable */ }
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || `Request failed (${res.status})`);
      err.body = body;
      throw err;
    }
    return body;
  }

  // ---- Catalogue -----------------------------------------------------------

  async function init() {
    const [config, list] = await Promise.all([api('/api/config'), api('/api/products')]);
    products = list;
    if (config.mpesaMode !== 'production') {
      const banner = $('#modeBanner');
      banner.hidden = false;
      banner.textContent = config.mpesaMode === 'mock'
        ? 'Demo mode: M-Pesa payments are simulated (no money moves). Numbers ending in 0000 simulate a cancelled payment.'
        : 'Sandbox mode: M-Pesa payments use the Safaricom test environment.';
    }
    renderProducts();
    renderCart();

    // Resume tracking an order if the page was reloaded mid-payment.
    const pending = load(ORDER_KEY, null);
    if (pending) {
      openDrawer();
      trackOrder(pending.id, pending.startedAt);
    }
  }

  function renderProducts() {
    const grid = $('#products');
    const tpl = $('#productTemplate');
    grid.replaceChildren(...products.map((p) => {
      const node = tpl.content.cloneNode(true);
      node.querySelector('.thumb').textContent = p.image;
      node.querySelector('.name').textContent = p.name;
      node.querySelector('.desc').textContent = p.description;
      node.querySelector('.price').textContent = fmt(p.price);
      node.querySelector('.add').addEventListener('click', (e) => {
        addToCart(p.id);
        e.target.textContent = 'Added ✓';
        setTimeout(() => { e.target.textContent = 'Add to cart'; }, 1000);
      });
      return node;
    }));
  }

  // ---- Cart ------------------------------------------------------------------

  function addToCart(id, delta = 1) {
    const qty = (cart[id] || 0) + delta;
    if (qty <= 0) delete cart[id];
    else cart[id] = Math.min(qty, 99);
    save(CART_KEY, cart);
    renderCart();
  }

  function cartLines() {
    return Object.entries(cart)
      .map(([id, qty]) => ({ product: products.find((p) => p.id === id), qty }))
      .filter((l) => l.product);
  }

  function renderCart() {
    const lines = cartLines();
    const count = lines.reduce((s, l) => s + l.qty, 0);
    const total = lines.reduce((s, l) => s + l.qty * l.product.price, 0);
    $('#cartCount').textContent = count;
    $('#cartTotal').textContent = fmt(total);
    $('#cartEmpty').hidden = lines.length > 0;
    $('#checkoutForm').hidden = lines.length === 0;

    $('#cartItems').replaceChildren(...lines.map(({ product, qty }) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = product.name;
      const price = document.createElement('strong');
      price.textContent = fmt(product.price * qty);
      const controls = document.createElement('span');
      controls.className = 'qty';
      const minus = document.createElement('button');
      minus.textContent = '−';
      minus.setAttribute('aria-label', `Remove one ${product.name}`);
      minus.onclick = () => addToCart(product.id, -1);
      const n = document.createElement('span');
      n.textContent = qty;
      const plus = document.createElement('button');
      plus.textContent = '+';
      plus.setAttribute('aria-label', `Add one ${product.name}`);
      plus.onclick = () => addToCart(product.id, 1);
      controls.append(minus, n, plus);
      const unit = document.createElement('span');
      unit.className = 'muted';
      unit.textContent = `${fmt(product.price)} each`;
      li.append(name, price, controls, unit);
      return li;
    }));
  }

  // ---- Drawer ------------------------------------------------------------------

  function openDrawer() {
    $('#drawer').classList.add('open');
    $('#drawer').setAttribute('aria-hidden', 'false');
  }
  function closeDrawer() {
    $('#drawer').classList.remove('open');
    $('#drawer').setAttribute('aria-hidden', 'true');
  }
  function showCartView() {
    stopPolling();
    $('#cartView').hidden = false;
    $('#statusView').hidden = true;
    $('#drawerTitle').textContent = 'Your cart';
  }

  $('#cartButton').addEventListener('click', () => { openDrawer(); });
  $('[data-close]').addEventListener('click', closeDrawer);
  $('#drawer').addEventListener('click', (e) => { if (e.target.id === 'drawer') closeDrawer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

  // ---- Checkout ------------------------------------------------------------------

  $('#checkoutForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = new FormData(form);
    const btn = $('#placeOrder');
    $('#formError').textContent = '';

    const phone = String(data.get('phone') || '').trim();
    if (!data.get('name').trim()) return void ($('#formError').textContent = 'Please enter your name.');
    if (!/^(\+?254|0)?[17]\d{8}$/.test(phone.replace(/[\s-]/g, ''))) {
      return void ($('#formError').textContent = 'Enter a valid Kenyan mobile number, e.g. 0712 345 678.');
    }

    btn.disabled = true;
    btn.textContent = data.get('paymentMethod') === 'mpesa' ? 'Sending M-Pesa prompt…' : 'Placing order…';
    try {
      const order = await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          items: cartLines().map((l) => ({ id: l.product.id, qty: l.qty })),
          customer: { name: data.get('name'), phone, address: data.get('address') },
          paymentMethod: data.get('paymentMethod'),
        }),
      });
      // The order exists now, so the cart is done with either way.
      cart = {};
      save(CART_KEY, cart);
      renderCart();
      if (order.paymentMethod === 'mpesa' && order.status === 'pending_payment') {
        const startedAt = Date.now();
        save(ORDER_KEY, { id: order.id, startedAt });
        trackOrder(order.id, startedAt, order);
      } else {
        showStatus(order);
      }
    } catch (err) {
      if (err.body && err.body.order) {
        cart = {};
        save(CART_KEY, cart);
        renderCart();
        showStatus(err.body.order);
      } else {
        $('#formError').textContent = err.message;
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Place order';
    }
  });

  function trackOrder(id, startedAt, initial) {
    stopPolling();
    if (initial) showStatus(initial);
    const tick = async () => {
      try {
        const order = await api(`/api/orders/${encodeURIComponent(id)}`);
        if (order.status === 'pending_payment' && Date.now() - startedAt > POLL_TIMEOUT_MS) {
          save(ORDER_KEY, null);
          return showStatus({ ...order, status: 'timeout' });
        }
        showStatus(order);
        if (order.status === 'pending_payment') pollTimer = setTimeout(tick, POLL_MS);
        else save(ORDER_KEY, null);
      } catch (err) {
        if (/not found/i.test(err.message)) { save(ORDER_KEY, null); return showCartView(); }
        pollTimer = setTimeout(tick, POLL_MS * 2);
      }
    };
    pollTimer = setTimeout(tick, initial ? POLL_MS : 0);
  }

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  const STATUS = {
    pending_payment: { icon: null, title: 'Check your phone', text: 'An M-Pesa prompt has been sent to {phone}. Enter your M-Pesa PIN to pay {total}.' },
    paid: { icon: '✅', title: 'Payment received', text: 'Thank you! Your order is confirmed and will be delivered soon.' },
    confirmed: { icon: '📦', title: 'Order placed', text: 'Please have {total} ready in cash when your order is delivered.' },
    payment_failed: { icon: '⚠️', title: 'Payment not completed', text: '{message}You can resend the M-Pesa prompt below.' },
    timeout: { icon: '⌛', title: 'Still waiting for payment', text: "We haven't received confirmation yet. If you paid, it will update shortly; otherwise resend the prompt." },
    payment_review: { icon: '🔎', title: 'Payment under review', text: 'We received a payment that needs checking. Our team will contact you.' },
  };

  function showStatus(order) {
    $('#cartView').hidden = true;
    $('#statusView').hidden = false;
    $('#drawerTitle').textContent = `Order #${order.id}`;
    const s = STATUS[order.status] || { icon: 'ℹ️', title: order.status, text: '' };

    const icon = $('#statusIcon');
    icon.className = s.icon ? 'status-icon' : 'spinner';
    icon.textContent = s.icon || '';
    $('#statusTitle').textContent = s.title;
    $('#statusText').textContent = s.text
      .replace('{phone}', order.customer.phone)
      .replace('{total}', fmt(order.total))
      .replace('{message}', order.payment && order.payment.message ? `${order.payment.message}. ` : '');

    const rows = [
      ['Order', `#${order.id}`],
      ['Items', order.items.map((i) => `${i.qty} × ${i.name}`).join(', ')],
      ['Total', fmt(order.total)],
      ['Payment', order.paymentMethod === 'mpesa' ? 'M-Pesa' : 'Cash on delivery'],
    ];
    if (order.payment && order.payment.receipt) rows.push(['M-Pesa receipt', order.payment.receipt]);
    $('#orderSummary').replaceChildren(...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      return [dt, dd];
    }));

    const canRetry = order.paymentMethod === 'mpesa' && ['payment_failed', 'timeout'].includes(order.status);
    $('#retryBox').hidden = !canRetry;
    $('#retryButton').dataset.orderId = order.id;
    $('#continueButton').hidden = order.status === 'pending_payment';
  }

  $('#retryButton').addEventListener('click', async (e) => {
    const btn = e.target;
    const id = btn.dataset.orderId;
    const phone = $('#retryPhone').value.trim();
    btn.disabled = true;
    try {
      const order = await api(`/api/orders/${encodeURIComponent(id)}/pay`, {
        method: 'POST',
        body: JSON.stringify(phone ? { phone } : {}),
      });
      const startedAt = Date.now();
      save(ORDER_KEY, { id, startedAt });
      trackOrder(id, startedAt, order);
    } catch (err) {
      $('#statusText').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  $('#continueButton').addEventListener('click', () => {
    save(ORDER_KEY, null);
    showCartView();
    closeDrawer();
  });

  init().catch((err) => {
    $('#products').textContent = `Could not load the shop: ${err.message}`;
  });
})();
