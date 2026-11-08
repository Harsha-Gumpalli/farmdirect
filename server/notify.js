// Email notifications through Resend (https://resend.com). Off until RESEND_API_KEY is set; then every
// order, booking, CSA request, RSVP and group order sends a short plain-text email.
const KEY = process.env.RESEND_API_KEY || '';
const FROM = process.env.EMAIL_FROM || 'FarmDirect <onboarding@resend.dev>';
const SITE = (process.env.SITE_URL || '').replace(/\/$/, '');

async function send(to, subject, lines, link = '') {
  if (!to) return;
  const text = [...[].concat(lines).filter(Boolean), '', SITE ? `${SITE}${link}` : '', '', 'FarmDirect: buy straight from the farm.'].join('\n');
  if (!KEY) { console.log(`[email not sent, RESEND_API_KEY missing] to=${to} subject="${subject}"`); return; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, text }),
    });
    if (!r.ok) console.warn('Email failed:', r.status, (await r.text()).slice(0, 300));
  } catch (e) {
    console.warn('Email error:', e.message);
  }
}

// Fire and forget so a slow email never delays the page.
const notify = (...args) => { send(...args).catch(() => {}); };

module.exports = { notify, emailEnabled: !!KEY };
