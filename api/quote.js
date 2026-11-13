// api/quote.js
// Receives the "Get a Free Quote" form, emails the request (with any photos)
// to the shop, and sends the customer a confirmation.
// Replaces the old mailto: link, which silently lost requests on devices
// with no mail app set up.
//
// Env vars: RESEND_API_KEY (required)
//           ORDER_EMAIL (optional, default SieCraftcnc@gmail.com)
//           MAIL_FROM   (optional, default "SieCraft <orders@siecraft.com>";
//                        the domain must be verified in Resend)

const MAX_PHOTOS = 3;
const MAX_TOTAL_B64 = 3.5 * 1024 * 1024; // stays under Vercel's 4.5 MB body limit
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

async function sendEmail(payload) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!process.env.RESEND_API_KEY) {
    res.status(503).json({ error: 'not_configured' });
    return;
  }

  const b = req.body || {};

  // Honeypot: real people never fill the hidden "website" field.
  if (b.website) { res.status(200).json({ ok: true }); return; }

  const q = {
    name: clip(`${clip(b.fname, 80)} ${clip(b.lname, 80)}`, 160),
    email: clip(b.email, 200),
    phone: clip(b.phone, 40),
    type: clip(b.type, 100),
    material: clip(b.material, 100),
    size: clip(b.size, 100),
    qty: clip(b.qty, 40),
    finish: clip(b.finish, 100),
    deadline: clip(b.deadline, 60) || 'No date given',
    text: clip(b.text, 3000),
    notes: clip(b.notes, 3000)
  };

  if (!q.name.trim() || !q.phone || !q.text || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q.email)) {
    res.status(400).json({ error: 'Please fill in your name, email, phone, and what you want engraved.' });
    return;
  }

  const photos = Array.isArray(b.photos) ? b.photos.slice(0, MAX_PHOTOS) : [];
  let total = 0;
  const attachments = [];
  for (const [i, p] of photos.entries()) {
    if (!p || typeof p.data !== 'string' || !ALLOWED_TYPES.includes(p.type)) continue;
    total += p.data.length;
    if (total > MAX_TOTAL_B64) {
      res.status(413).json({ error: 'Photos are too large. Try fewer or smaller photos, or text them to us.' });
      return;
    }
    const ext = p.type.split('/')[1].replace('jpeg', 'jpg');
    attachments.push({ filename: `photo-${i + 1}.${ext}`, content: p.data });
  }

  const from = process.env.MAIL_FROM || 'SieCraft <orders@siecraft.com>';
  const to = process.env.ORDER_EMAIL || 'SieCraftcnc@gmail.com';

  const ownerText = [
    'NEW QUOTE REQUEST — siecraft.com',
    '',
    `Name: ${q.name}`,
    `Email: ${q.email}`,
    `Phone: ${q.phone}`,
    '',
    `Product: ${q.type || 'Not chosen'}`,
    `Material: ${q.material}`,
    `Size: ${q.size}`,
    `Quantity: ${q.qty}`,
    `Finish: ${q.finish}`,
    `Needed by: ${q.deadline}`,
    '',
    'PERSONALIZATION:',
    q.text,
    '',
    'NOTES:',
    q.notes || '(none)',
    '',
    `Photos attached: ${attachments.length}`,
    '',
    'Reply to this email to answer the customer directly.'
  ].join('\n');

  try {
    await sendEmail({
      from,
      to: [to],
      reply_to: q.email,
      subject: `Quote request: ${q.type || 'Custom order'} from ${q.name}${q.deadline !== 'No date given' ? ` (needed by ${q.deadline})` : ''}`,
      text: ownerText,
      attachments: attachments.length ? attachments : undefined
    });
  } catch (err) {
    console.error('quote owner email failed:', err.message);
    res.status(502).json({ error: 'send_failed' });
    return;
  }

  // Confirmation to the customer. If this one fails, the shop already has
  // the request, so we still report success.
  try {
    await sendEmail({
      from,
      to: [q.email],
      reply_to: to,
      subject: 'We got your SieCraft quote request',
      text: [
        `Hi ${clip(b.fname, 40).replace(/[^\p{L}\p{M}' .-]/gu, '') || 'there'},`,
        '',
        `Thanks for reaching out about a ${q.type || 'custom piece'}. Your request reached us, and we'll reply with your free design proof and an exact price.`,
        '',
        'Need it sooner, or want to add something? Just reply to this email or text (929) 371-0501.',
        '',
        'SieCraft',
        'Handmade in Orlando, FL · siecraft.com'
      ].join('\n')
    });
  } catch (err) {
    console.error('quote confirmation email failed:', err.message);
  }

  res.status(200).json({ ok: true });
};
