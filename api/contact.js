// POST /api/contact  { name, email, topic, message }
// Validates and forwards a contact message to CONTACT_WEBHOOK (Formspree / Discord /
// Slack / Zapier / Google Apps Script). Destination stays server-side.
export const config = { runtime: 'edge' };

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const clip = (v, n) => (v == null ? '' : String(v)).trim().slice(0, n);
  if (clip(body.company_website, 80)) return json({ ok: true }, 200); // honeypot
  const name = clip(body.name, 120);
  const email = clip(body.email, 160);
  const topic = clip(body.topic, 60);
  const message = clip(body.message, 4000);

  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !message) {
    return json({ error: 'Please fill in your name, a valid email, and a message.' }, 400);
  }

  const webhook = process.env.CONTACT_WEBHOOK || '';
  if (!webhook) return json({ error: 'not_configured' }, 503);

  const content = `📨 New PPCBench contact\n• Name: ${name}\n• Email: ${email}\n• Topic: ${topic || '—'}\n• Message: ${message}`;
  try {
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ content, text: content, _subject: `PPCBench contact — ${topic || 'General'} — ${name}`, name, email, topic, message, source: 'ppcbench-contact' })
    });
    if (!r.ok) return json({ error: 'forward_failed' }, 502);
  } catch (e) {
    return json({ error: 'forward_failed' }, 502);
  }
  return json({ ok: true }, 200);
}
