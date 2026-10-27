// The invitation email. One place for the wording; the admin page previews exactly what is sent.
import { TIER_LABEL, toolsFor, TOOL_NAMES, isTier } from './_tiers.js';
import { SITE } from './_auth.js';

const esc = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
const line = (s, n) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

// { name, email, tier, note } -> { subject, text, html }. Throws on an unknown plan.
export function buildInvite({ name, email, tier, note }) {
  if (!isTier(tier)) throw new Error('bad tier');
  const who = line(name, 80), plan = TIER_LABEL[tier], tools = toolsFor(tier).map(t => TOOL_NAMES[t]), personal = String(note == null ? '' : note).replace(/\r/g, '').trim().slice(0, 600);
  const login = SITE + '/login', addr = line(email, 160);
  const subject = 'Your PPCBench access is ready';
  const text = [
    'Hi' + (who ? ' ' + who : '') + ',', '',
    ...(personal ? [personal, ''] : []),
    'Your access to PPCBench is approved. Your plan: ' + plan + '.', '',
    '1. Go to ' + login,
    '2. Click "Continue with Google" and use this address: ' + addr + ' (a different Google account will not work).',
    '3. You land in the app with the tools on your plan: ' + tools.join(', ') + '.', '',
    'Your Amazon files are read in your browser and never uploaded.' + (tier === 'pro' ? ' If you use the SQP Tracker you can choose to save a small numeric summary of the keywords you track; you can export or delete it at any time.' : ''), '',
    'Something not working? Just reply to this email.', '', 'PPCBench'
  ].join('\n');
  const html = '<div style="font-family:Inter,Arial,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;max-width:520px">'
    + '<p>Hi' + (who ? ' ' + esc(who) : '') + ',</p>'
    + (personal ? '<p style="white-space:pre-wrap">' + esc(personal) + '</p>' : '')
    + '<p>Your access to PPCBench is approved. Your plan: <strong>' + esc(plan) + '</strong>.</p>'
    + '<ol style="padding-left:20px"><li>Go to <a href="' + login + '" style="color:#c2410c">' + login + '</a></li>'
    + '<li>Click <strong>Continue with Google</strong> and use this address: <strong>' + esc(addr) + '</strong> (a different Google account will not work).</li>'
    + '<li>You land in the app with the tools on your plan: ' + esc(tools.join(', ')) + '.</li></ol>'
    + '<p style="color:#475569;font-size:13px">Your Amazon files are read in your browser and never uploaded.' + (tier === 'pro' ? ' If you use the SQP Tracker you can choose to save a small numeric summary of the keywords you track; you can export or delete it at any time.' : '') + '</p>'
    + '<p>Something not working? Just reply to this email.</p><p>PPCBench</p></div>';
  return { subject, text, html };
}

// Sends through Resend. -> { ok } | { ok:false, error }. Needs RESEND_API_KEY and INVITE_FROM (e.g. "PPCBench <hello@ppcbench.com>").
export async function sendInvite(to, mail) {
  const key = process.env.RESEND_API_KEY || '', from = process.env.INVITE_FROM || '';
  if (!key || !from) return { ok: false, error: 'email_not_configured' };
  try {
    const body = { from, to: [to], subject: mail.subject, text: mail.text, html: mail.html };
    if (process.env.INVITE_REPLY_TO) body.reply_to = process.env.INVITE_REPLY_TO;
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.ok ? { ok: true } : { ok: false, error: 'email_rejected' };
  } catch (e) { return { ok: false, error: 'email_unreachable' }; }
}
