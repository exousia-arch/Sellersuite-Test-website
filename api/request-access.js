// POST /api/request-access  { name, email, role, spend, usecase }
// Validates and forwards the request to REQUEST_WEBHOOK (Formspree / Discord / Slack /
// Zapier / Google Apps Script — anything that accepts a JSON POST). Keeps the
// destination server-side (not exposed in the page) and avoids CORS.
export const config = { runtime: 'edge' };

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const clip = (v, n) => (v == null ? '' : String(v)).trim().slice(0, n);
  const name = clip(body.name, 120);
  const email = clip(body.email, 160);
  const role = clip(body.role, 80);
  const spend = clip(body.spend, 40);
  const usecase = clip(body.usecase, 1000);
  // honeypot (optional hidden field) — silently accept to fool bots
  if (clip(body.company_website, 80)) return json({ ok: true }, 200);

  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: 'Please enter a valid name and email.' }, 400);
  }

  const webhook = process.env.REQUEST_WEBHOOK || '';
  if (!webhook) return json({ error: 'not_configured' }, 503);

  const content = `📥 New PPCBench access request\n• Name: ${name}\n• Email: ${email}\n• Role: ${role}\n• Monthly ad spend: ${spend}\n• Use case: ${usecase || '—'}`;
  try {
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      // `content` renders nicely in Discord/Slack; the flat fields suit Formspree/Sheets/Zapier.
      body: JSON.stringify({ content, text: content, name, email, role, spend, usecase, source: 'ppcbench-request-access' })
    });
    if (!r.ok) return json({ error: 'forward_failed' }, 502);
  } catch (e) {
    return json({ error: 'forward_failed' }, 502);
  }
  return json({ ok: true }, 200);
}
