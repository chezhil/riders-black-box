/**
 * Minimal SMS relay for Rider's Black Box.
 *
 * The app can't send SMS silently from Expo Go, so when a rider is
 * unresponsive it POSTs the alert here and this server sends it via Twilio.
 *
 *   TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... TWILIO_FROM=+1... \
 *   RELAY_KEY=some-shared-secret node relay/server.mjs
 *
 * POST /alert  { "to": ["+9198..."], "body": "..." }
 * Header       Authorization: Bearer <RELAY_KEY>
 */
import { createServer } from 'node:http';

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, RELAY_KEY, PORT = 8787 } = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM) {
  console.error('Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM.');
  process.exit(1);
}

const MAX_RECIPIENTS = 5;
const PHONE = /^\+?\d{8,15}$/;

async function sendSms(to, body) {
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body }),
    },
  );
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${await res.text()}`);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10_000) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
  });
}

createServer(async (req, res) => {
  const reply = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/alert') return reply(404, { error: 'Not found' });
  if (RELAY_KEY && req.headers.authorization !== `Bearer ${RELAY_KEY}`) {
    return reply(401, { error: 'Unauthorized' });
  }

  try {
    const { to, body } = await readJson(req);
    const recipients = (Array.isArray(to) ? to : [to]).filter((n) => PHONE.test(String(n)));
    if (!recipients.length || typeof body !== 'string' || !body.trim()) {
      return reply(400, { error: 'Need "to" phone numbers and a "body"' });
    }
    const results = await Promise.allSettled(
      recipients.slice(0, MAX_RECIPIENTS).map((n) => sendSms(n, body.slice(0, 1500))),
    );
    const sent = results.filter((r) => r.status === 'fulfilled').length;
    results.forEach((r) => r.status === 'rejected' && console.error(r.reason));
    return reply(sent ? 200 : 502, { sent, failed: results.length - sent });
  } catch (e) {
    return reply(400, { error: String(e.message ?? e) });
  }
}).listen(PORT, () => console.log(`SMS relay listening on :${PORT}`));
