// Public: what the Write page shows. Only published answers are ever returned.
// GET /api/week -> same shape as responses.json
const L = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!L.configured()) return res.status(503).json({ error: 'not configured' });
  try {
    const site = await L.getSite();
    const published = site.state === 'reading' ? await L.getJSON('pub:' + site.week, []) : [];
    const archive = await L.getJSON('archive', []);
    return res.status(200).json({
      state: L.closedNow(site) ? 'closed' : site.state, week: site.week, label: site.label, prompt: site.prompt,
      note: site.note || '', nextOpens: site.nextOpens || 'Wednesday',
      responses: published, archive
    });
  } catch (e) {
    return res.status(500).json({ error: 'server error' });
  }
};
