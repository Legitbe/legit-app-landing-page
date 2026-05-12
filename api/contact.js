// /api/contact — Vercel Function (Node runtime). Receives the contact form
// payload, validates it server-side, rate-limits by IP, and forwards the
// message to legit.belgique@gmail.com via the Resend HTTP API.
//
// Env vars expected on Vercel (all environments):
//   - RESEND_API_KEY  : Resend API key (server-only, never exposed to client)
//   - RESEND_FROM     : "Legit <onboarding@resend.dev>" or a verified sender
//
// This handler MUST NOT echo back the API key or any internal error detail
// in HTTP responses — only generic messages reach the client.

const TO_EMAIL = 'legit.belgique@gmail.com';
const RATE_WINDOW_MS = 30_000;

// In-memory per-instance rate map. Fluid Compute keeps instances warm, so a
// single bot from one IP gets throttled; a distributed attack obviously needs
// a real store, but this covers the 80% case at zero cost.
const lastSubmitByIp = new Map();

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  const xri = req.headers['x-real-ip'];
  if (typeof xri === 'string' && xri.length) return xri.trim();
  return req.socket?.remoteAddress || 'unknown';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function validate(body) {
  if (!body || typeof body !== 'object') return 'Payload invalide.';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const orgType = typeof body.org_type === 'string' ? body.org_type.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const htmlTag = /<\/?[a-z][\s\S]*>/i;
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (name.length < 2 || name.length > 100 || htmlTag.test(name)) return 'Nom invalide.';
  if (!emailRe.test(email) || email.length > 200) return 'Email invalide.';
  if (orgType.length > 100 || htmlTag.test(orgType)) return 'Organisation invalide.';
  if (message.length < 10 || message.length > 2000) return 'Message hors limites (10–2000 caractères).';
  const urls = message.match(/https?:\/\/\S+/gi) || [];
  if (urls.length > 2) return 'Trop de liens dans le message.';
  return { ok: true, name, email, orgType, message };
}

function buildHtml({ name, email, orgType, message }) {
  const safe = {
    name: escapeHtml(name),
    email: escapeHtml(email),
    orgType: escapeHtml(orgType || '—'),
    message: escapeHtml(message).replace(/\r?\n/g, '<br>'),
  };
  return `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0a0a0a;background:#fafaf7;padding:24px;">
<table cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border:1px solid #e8e8e3;border-radius:12px;overflow:hidden;">
  <tr><td style="padding:18px 22px;background:linear-gradient(135deg,#b80050,#3c00cf);color:#fff;font-weight:600;font-size:14px;letter-spacing:0.04em;">Nouveau message — legit-app.be</td></tr>
  <tr><td style="padding:22px;">
    <table cellpadding="6" cellspacing="0" style="width:100%;font-size:14px;border-collapse:collapse;">
      <tr><td style="color:#6b6b6b;width:120px;vertical-align:top;">Nom</td><td style="color:#0a0a0a;font-weight:500;">${safe.name}</td></tr>
      <tr><td style="color:#6b6b6b;vertical-align:top;">Email</td><td><a href="mailto:${safe.email}" style="color:#3c00cf;">${safe.email}</a></td></tr>
      <tr><td style="color:#6b6b6b;vertical-align:top;">Organisation</td><td>${safe.orgType}</td></tr>
      <tr><td colspan="2" style="padding-top:14px;border-top:1px solid #e8e8e3;color:#6b6b6b;">Message</td></tr>
      <tr><td colspan="2" style="color:#0a0a0a;line-height:1.5;">${safe.message}</td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:14px 22px;background:#fafaf7;color:#6b6b6b;font-size:12px;border-top:1px solid #e8e8e3;">Reçu via le formulaire de contact de legit-app.be</td></tr>
</table></body></html>`;
}

async function readJson(req) {
  // Vercel Node runtime usually parses JSON automatically into req.body. If
  // not (raw stream), fall back to reading the body manually.
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const ip = clientIp(req);
  const last = lastSubmitByIp.get(ip) || 0;
  const now = Date.now();
  if (now - last < RATE_WINDOW_MS) {
    return res.status(429).json({ ok: false, error: 'Trop de requêtes, réessaie dans quelques secondes.' });
  }

  const body = await readJson(req);
  const v = validate(body);
  if (typeof v === 'string') return res.status(400).json({ ok: false, error: v });

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) {
    console.error('[contact] missing RESEND env vars');
    return res.status(500).json({ ok: false, error: 'Configuration serveur manquante.' });
  }

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [TO_EMAIL],
        reply_to: v.email,
        subject: `Nouveau message via legit-app.be — ${v.name}`,
        html: buildHtml(v),
      }),
    });

    if (!resp.ok) {
      // Log the upstream body server-side, but return a generic message to the client.
      const detail = await resp.text().catch(() => '');
      console.error('[contact] Resend non-2xx:', resp.status, detail.slice(0, 500));
      return res.status(500).json({ ok: false, error: 'Envoi impossible pour le moment.' });
    }

    // Only flip the rate-limit clock once the send is confirmed.
    lastSubmitByIp.set(ip, now);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[contact] fetch threw:', err?.message || err);
    return res.status(500).json({ ok: false, error: 'Envoi impossible pour le moment.' });
  }
}
