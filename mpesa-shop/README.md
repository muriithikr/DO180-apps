# Duka Shop: e-commerce with M-Pesa checkout

A small online shop (Node.js + Express, plain HTML/CSS/JS front end) where customers can pay with
**M-Pesa** through Safaricom's Daraja *Lipa na M-Pesa Online* (STK Push) API, or choose
**cash on delivery**.

## How M-Pesa checkout works

1. The customer adds items to the cart, enters their phone number and picks **M-PESA**.
2. The server works out the total from its own product catalogue (it never trusts prices sent by
   the browser), creates an order and calls Daraja **STK Push**.
3. The customer gets a prompt on their phone and enters their M-Pesa PIN.
4. Safaricom POSTs the result to `MPESA_CALLBACK_URL`. The server marks the order `paid` and stores
   the M-Pesa receipt number, or marks it `payment_failed` if the customer cancelled or had too
   little balance.
5. The browser polls the order status and shows the receipt. If the callback never arrives, the
   server falls back to Daraja's **STK Push Query**. A failed or timed-out payment can be retried
   with "Resend M-Pesa prompt".

Order statuses: `pending_payment`, `paid`, `payment_failed`, `payment_review` (the amount paid did
not match the order), and `confirmed` (cash on delivery).

## Run locally (demo/mock mode)

```bash
npm install
npm start            # http://localhost:8080
npm test
```

If no Daraja credentials are configured, the app runs in **mock mode** and no money moves. Payments
complete automatically after about 6 seconds. A phone number ending in `0000` (for example
`0700000000`) simulates a customer cancelling the payment.

## Use the Safaricom sandbox

1. Create an app at <https://developer.safaricom.co.ke> with the *Lipa na M-Pesa Sandbox* product
   and copy its Consumer Key and Consumer Secret.
2. Safaricom has to reach your callback over public HTTPS. For local testing, expose the app with a
   tunnel such as `ngrok http 8080` or `cloudflared tunnel --url http://localhost:8080`.
3. Configure the app and start it (see `.env.example` for every option):

   ```bash
   export MPESA_ENV=sandbox
   export MPESA_CONSUMER_KEY=...
   export MPESA_CONSUMER_SECRET=...
   export MPESA_CALLBACK_TOKEN=$(openssl rand -hex 16)
   export MPESA_CALLBACK_URL=https://<your-tunnel-host>/api/mpesa/callback/$MPESA_CALLBACK_TOKEN
   npm start
   ```

   The sandbox uses Safaricom's public test shortcode `174379` and its passkey by default.

## Go live

- Apply for Daraja production access ("Go Live") with your Paybill or Till number. Safaricom then
  emails you the production **passkey**.
- Set `MPESA_ENV=production`, `MPESA_SHORTCODE` and `MPESA_PASSKEY`, plus your production key and
  secret.
- For a **Till (Buy Goods)** number: set `MPESA_TRANSACTION_TYPE=CustomerBuyGoodsOnline`, put the
  store number in `MPESA_SHORTCODE` and the till number in `MPESA_PARTY_B`.
- Always set `MPESA_CALLBACK_TOKEN`. Daraja does not sign its callbacks, so the app accepts a
  callback only when all of these hold: the secret token in the URL path matches, the
  `CheckoutRequestID` belongs to a payment this server started, and the amount equals the order
  total.
- Swap `lib/store.js` (in memory, with optional JSON file storage via `ORDERS_FILE`) for a real
  database before you take real traffic or run more than one replica.

## Deploy as a container / on OpenShift

```bash
podman build -t mpesa-shop -f Containerfile .
podman run -p 8080:8080 -e MPESA_ENV=mock mpesa-shop

# OpenShift
oc new-app --name mpesa-shop https://github.com/muriithikr/DO180-apps \
  --context-dir mpesa-shop --strategy docker
oc create secret generic mpesa --from-env-file=.env
oc set env deployment/mpesa-shop --from secret/mpesa
oc create route edge --service mpesa-shop        # HTTPS route = your callback host
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/products` | Product catalogue (`data/products.json`) |
| POST | `/api/orders` | Create an order: `{ items:[{id,qty}], customer:{name,phone,address}, paymentMethod:"mpesa"\|"cod" }` |
| GET | `/api/orders/:id` | Order status (the browser polls this) |
| POST | `/api/orders/:id/pay` | Resend the STK prompt, optionally with `{ phone }` |
| POST | `/api/mpesa/callback/:token` | Daraja STK callback |
| GET | `/api/admin/orders` | All orders; needs `Authorization: Bearer $ADMIN_TOKEN` |
| GET | `/healthz` | Liveness check |
