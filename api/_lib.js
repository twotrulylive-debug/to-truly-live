// Shared helpers for the to truly live API (files starting with _ are not public routes).
const crypto = require('crypto');

const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const configured = () => Boolean(URL_ && TOKEN);

async function redis(cmd) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).result;
}

async function getJSON(key, fallback) {
  const v = await redis(['GET', key]);
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch (e) { return fallback; }
}
const setJSON = (key, val) => redis(['SET', key, JSON.stringify(val)]);

function ipOf(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

// returns true if this visitor is over `max` hits in the window
async function limited(name, req, max, windowSec) {
  const k = 'rl:' + name + ':' + ipOf(req) + ':' + Math.floor(Date.now() / (windowSec * 1000));
  const n = await redis(['INCR', k]);
  if (n === 1) await redis(['EXPIRE', k, windowSec * 2]);
  return n > max;
}

function body(req) {
  if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; } }
  return req.body || {};
}

const clean = (s, max) => String(s == null ? '' : s).replace(/\u0000/g, '').trim().slice(0, max);

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

const newId = () => crypto.randomBytes(6).toString('hex');

// The current week. Seeded from responses.json the first time.
const DEFAULT_SITE = {
  state: 'open', week: 1, label: 'Nov 4 – 7',
  prompt: 'What have you stopped accepting as truth?',
  note: "Something you were told about yourself, your life, or how it's supposed to go. Write about the moment you stopped believing it.",
  nextOpens: 'Wednesday'
};
async function getSite() {
  const s = await getJSON('site', null);
  if (s) return s;
  await setJSON('site', DEFAULT_SITE);
  return DEFAULT_SITE;
}

// Answers close at the end of Saturday, Toronto time. From Sunday to Tuesday the form stays
// closed until the next week is opened. A week opened on (or after) the latest Sunday stays open,
// so opening early on a Tuesday works too.
function torontoDate(d) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(d);
  const g = (t) => (p.find((x) => x.type === t) || {}).value;
  return { ymd: g('year') + '-' + g('month') + '-' + g('day'), day: g('weekday') };
}
function closedNow(site, now) {
  if (!site || site.state !== 'open') return false;
  now = now || new Date();
  const t = torontoDate(now);
  const idx = ['Sun', 'Mon', 'Tue'].indexOf(t.day);
  if (idx < 0) return false;
  const lastSunday = new Date(t.ymd + 'T12:00:00Z'); lastSunday.setUTCDate(lastSunday.getUTCDate() - idx);
  const lastSundayYmd = lastSunday.toISOString().slice(0, 10);
  const opened = torontoDate(new Date(site.openedAt || '2026-11-04T12:00:00Z')).ymd;
  return opened < lastSundayYmd;
}

module.exports = { closedNow, redis, getJSON, setJSON, limited, body, clean, safeEqual, newId, getSite, configured, ipOf };
