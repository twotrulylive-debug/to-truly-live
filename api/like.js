// "This stayed with me" counter for to truly live.
// Runs on Vercel. Stores one number per answer in a free Upstash Redis database.
// GET  /api/like?ids=w1-1,w1-2   -> { counts: { "w1-1": 3, "w1-2": 0 } }
// POST /api/like  {id, action}   -> { count }   (action: "like" or "unlike")

const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const ID = /^[a-z0-9-]{1,40}$/;

async function redis(cmd) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).result;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !TOKEN) return res.status(503).json({ error: 'not configured' });
  try {
    if (req.method === 'GET') {
      const ids = String(req.query.ids || '').split(',').filter((x) => ID.test(x)).slice(0, 100);
      if (!ids.length) return res.status(200).json({ counts: {} });
      const vals = await redis(['MGET', ...ids.map((i) => 'like:' + i)]);
      const counts = {};
      ids.forEach((id, i) => { counts[id] = Math.max(0, parseInt(vals[i] || '0', 10) || 0); });
      return res.status(200).json({ counts });
    }
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const id = String(body.id || '');
      const action = body.action === 'unlike' ? 'unlike' : 'like';
      if (!ID.test(id)) return res.status(400).json({ error: 'bad id' });

      // simple limit: 30 taps per minute per visitor address
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
      const rk = 'rl:' + ip + ':' + Math.floor(Date.now() / 60000);
      const n = await redis(['INCR', rk]);
      if (n === 1) await redis(['EXPIRE', rk, 120]);
      if (n > 30) return res.status(429).json({ error: 'slow down' });

      let v;
      if (action === 'like') {
        v = await redis(['INCR', 'like:' + id]);
      } else {
        v = await redis(['DECR', 'like:' + id]);
        if (v < 0) { await redis(['SET', 'like:' + id, 0]); v = 0; }
      }
      return res.status(200).json({ count: v });
    }
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'server error' });
  }
};
