// Receives answers and contact messages and saves them privately.
// POST /api/submit  { type: "answer", response, credit, display_name, email, _gotcha }
// POST /api/submit  { type: "contact", first_name, email, subject, message, _gotcha }
const L = require('./_lib');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!L.configured()) return res.status(503).json({ error: 'not configured' });
  try {
    const b = L.body(req);
    if (b._gotcha) return res.status(200).json({ ok: true }); // spam bot, pretend it worked
    if (await L.limited('sub', req, 6, 600)) return res.status(429).json({ error: 'slow down' });
    const now = new Date().toISOString();

    if (b.type === 'contact') {
      const m = {
        id: L.newId(), at: now,
        name: L.clean(b.first_name, 60), email: L.clean(b.email, 120),
        subject: L.clean(b.subject, 140), message: L.clean(b.message, 4000)
      };
      if (!m.name || !m.subject || !m.message || !EMAIL.test(m.email)) return res.status(400).json({ error: 'missing fields' });
      await L.redis(['LPUSH', 'contacts', JSON.stringify(m)]);
      return res.status(200).json({ ok: true });
    }

    if (b.type === 'answer') {
      const site = await L.getSite();
      if (site.state !== 'open' || L.closedNow(site)) return res.status(409).json({ error: 'closed' });
      const anon = b.credit === 'Anonymous';
      const a = {
        id: L.newId(), at: now, week: site.week,
        name: anon ? '' : L.clean(b.display_name, 30),
        text: L.clean(b.response, 1200),
        email: L.clean(b.email, 120)
      };
      if (a.text.length < 10) return res.status(400).json({ error: 'too short' });
      if (!anon && !a.name) return res.status(400).json({ error: 'name needed' });
      if (a.email && !EMAIL.test(a.email)) a.email = '';
      await L.redis(['RPUSH', 'subs:' + site.week, JSON.stringify(a)]);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'unknown type' });
  } catch (e) {
    return res.status(500).json({ error: 'server error' });
  }
};
