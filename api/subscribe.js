// POST /api/subscribe  { email }
// Validates and forwards a newsletter signup to NEWSLETTER_WEBHOOK (Formspree /
// Discord / Slack / Zapier / Google Apps Script). Destination stays server-side.
export const config = { runtime: 'edge' };

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body = {};
  try { body = await request.json(); } catch (e) {}
  // honeypot (silently accept)
  if (body && body.company_website) return json({ ok: true }, 200);
  const email = (body && body.email ? String(body.email) : '').trim().slice(0, 160);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Please enter a valid email.' }, 400);

  const webhook = process.env.NEWSLETTER_WEBHOOK || '';
  if (!webhook) return json({ error: 'not_configured' }, 503);

  const content = `📬 New PPCBench newsletter signup\n• Email: ${email}`;
  try {
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ content, text: content, _subject: 'New PPCBench newsletter signup', email, source: 'ppcbench-newsletter' })
    });
    if (!r.ok) return json({ error: 'forward_failed' }, 502);
  } catch (e) {
    return json({ error: 'forward_failed' }, 502);
  }
  return json({ ok: true }, 200);
}
