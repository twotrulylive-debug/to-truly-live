// Private admin actions. Every request needs the password in the "x-admin-password" header.
// The password is set in Vercel as the environment variable ADMIN_PASSWORD.
//
// GET  /api/admin                      -> { site, subs, mod, contacts, archiveCount }
// POST /api/admin { action: "mark", id, status: "publish"|"skip"|"pending" }
// POST /api/admin { action: "golive" }                 -> publish approved answers, page switches to "Now reading"
// POST /api/admin { action: "reopen" }                 -> switch back to "Open for writing" (same week)
// POST /api/admin { action: "newweek", prompt, note, label, short }  -> archive this week, open the next
// POST /api/admin { action: "edit", prompt, note, label }            -> fix this week's wording
// POST /api/admin { action: "delcontact", id }
const L = require('./_lib');

async function authed(req, res) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) { res.status(503).json({ error: 'no password set' }); return false; }
  // at most 10 wrong guesses per 15 minutes per address
  const key = 'rl:admfail:' + L.ipOf(req) + ':' + Math.floor(Date.now() / 900000);
  const fails = parseInt((await L.redis(['GET', key])) || '0', 10);
  if (fails >= 10) { res.status(429).json({ error: 'too many tries, wait 15 minutes' }); return false; }
  const given = String(req.headers['x-admin-password'] || '');
  if (!given || !L.safeEqual(given, pw)) {
    await L.redis(['INCR', key]); await L.redis(['EXPIRE', key, 1800]);
    res.status(401).json({ error: 'wrong password' });
    return false;
  }
  return true;
}

async function loadSubs(week) {
  const raw = (await L.redis(['LRANGE', 'subs:' + week, 0, -1])) || [];
  return raw.map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!L.configured()) return res.status(503).json({ error: 'not configured' });
  try {
    if (!(await authed(req, res))) return;
    const site = await L.getSite();

    if (req.method === 'GET') {
      const subs = await loadSubs(site.week);
      const mod = (await L.getJSON('mod:' + site.week, {})) || {};
      const contactsRaw = (await L.redis(['LRANGE', 'contacts', 0, 199])) || [];
      const contacts = contactsRaw.map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
      const optRaw = (await L.redis(['LRANGE', 'optins', 0, -1])) || [];
      const optins = optRaw.map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
      const archive = await L.getJSON('archive', []);
      const likeIds = subs.map((s) => 'w' + site.week + '-' + s.id);
      const likeVals = likeIds.length ? (await L.redis(['MGET', ...likeIds.map((i) => 'like:' + i)])) || [] : [];
      const likes = {};
      subs.forEach((s, i) => { likes[s.id] = Math.max(0, parseInt(likeVals[i] || '0', 10) || 0); });
      return res.status(200).json({ likes, optins, site, closed: L.closedNow(site), subs, mod, contacts, archiveCount: archive.length });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

    const b = L.body(req);
    const modKey = 'mod:' + site.week;

    if (b.action === 'mark') {
      const id = L.clean(b.id, 20), st = ['publish', 'skip', 'pending'].includes(b.status) ? b.status : 'pending';
      const mod = (await L.getJSON(modKey, {})) || {};
      mod[id] = st; await L.setJSON(modKey, mod);
      return res.status(200).json({ ok: true, mod });
    }

    if (b.action === 'golive') {
      const subs = await loadSubs(site.week);
      const mod = (await L.getJSON(modKey, {})) || {};
      const pub = subs.filter((s) => mod[s.id] === 'publish').map((s, i) => ({
        id: 'w' + site.week + '-' + s.id, name: s.name, text: s.text
      }));
      await L.setJSON('pub:' + site.week, pub);
      site.state = 'reading'; await L.setJSON('site', site);
      return res.status(200).json({ ok: true, published: pub.length, site });
    }

    if (b.action === 'reopen') {
      site.state = 'open'; site.openedAt = new Date().toISOString(); await L.setJSON('site', site);
      return res.status(200).json({ ok: true, site });
    }

    if (b.action === 'edit') {
      if (b.prompt) site.prompt = L.clean(b.prompt, 200);
      if (b.note != null) site.note = L.clean(b.note, 400);
      if (b.label) site.label = L.clean(b.label, 40);
      await L.setJSON('site', site);
      return res.status(200).json({ ok: true, site });
    }

    if (b.action === 'newweek') {
      const prompt = L.clean(b.prompt, 200), label = L.clean(b.label, 40);
      if (!prompt || !label) return res.status(400).json({ error: 'prompt and dates needed' });
      const archive = await L.getJSON('archive', []);
      const pub = await L.getJSON('pub:' + site.week, []);
      archive.unshift({
        week: site.week, label: site.label, prompt: site.prompt,
        short: L.clean(b.short, 24) || ('Week ' + site.week), responses: pub
      });
      await L.setJSON('archive', archive);
      const next = { state: 'open', week: site.week + 1, label, prompt, note: L.clean(b.note, 400), nextOpens: 'Wednesday', openedAt: new Date().toISOString() };
      await L.setJSON('site', next);
      return res.status(200).json({ ok: true, site: next });
    }

    if (b.action === 'delcontact') {
      const id = L.clean(b.id, 20);
      const raw = (await L.redis(['LRANGE', 'contacts', 0, -1])) || [];
      for (const x of raw) { try { if (JSON.parse(x).id === id) { await L.redis(['LREM', 'contacts', 1, x]); break; } } catch (e) {} }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ error: 'server error' });
  }
};
