// api/webhook.js
// Listens for checkout.session.completed from Stripe, then emails the full
// order details to SieCraftcnc@gmail.com via Resend.
// Requires STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY in Vercel.

const Stripe = require('stripe');

// Stripe needs the exact raw request body to verify the signature.
async function rawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const buf = await rawBody(req);
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_unused');
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const m = session.metadata || {};
    const paidEmail = (session.customer_details && session.customer_details.email) || '';
    const amount = ((session.amount_total || 0) / 100).toFixed(2);
    const cd = session.customer_details || {};
    const ship = session.shipping_details || (session.collected_information && session.collected_information.shipping_details) || null;
    const shipCents = (session.total_details && session.total_details.amount_shipping) || 0;
    const taxCents = (session.total_details && session.total_details.amount_tax) || 0;
    const fields = (session.custom_fields || []).map(f => `${(f.label && f.label.custom) || f.key}: ${(f.text && f.text.value) || '(blank)'}`);
    const a = ship && ship.address;
    let qtyLine = '';
    if (m.kind === 'premade' && process.env.STRIPE_SECRET_KEY) {
      try {
        const li = await Stripe(process.env.STRIPE_SECRET_KEY).checkout.sessions.listLineItems(session.id, { limit: 10 });
        qtyLine = li.data.map(x => `${x.quantity} x ${x.description}`).join('; ');
      } catch (e) { console.error('line items lookup failed:', e && e.message); }
    }
    const shipLines = m.kind === 'premade' ? [
      '',
      shipCents > 0 ? `Delivery: SHIP ($${(shipCents / 100).toFixed(2)} paid)` : 'Delivery: LOCAL PICKUP',
      ...(shipCents > 0 && a ? [`Ship to: ${ship.name || ''}`, `${a.line1 || ''}${a.line2 ? ', ' + a.line2 : ''}`, `${a.city || ''}, ${a.state || ''} ${a.postal_code || ''}`] : [])
    ] : [];

    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: process.env.MAIL_FROM || 'SieCraft Orders <orders@siecraft.com>',
          to: [process.env.ORDER_EMAIL || 'SieCraftcnc@gmail.com'],
          reply_to: paidEmail || undefined,
          subject: `${m.kind === 'premade' ? 'Order paid' : 'Deposit paid'}: ${m.product || 'Custom order'} ($${amount})`,
          text: [
            'New SieCraft payment received.',
            '',
            `Product: ${m.product || ''}`,
            ...(qtyLine ? [`Quantity: ${qtyLine}`] : []),
            `Customer: ${m.customerName || cd.name || ''}`,
            `Email: ${paidEmail}`,
            `Phone: ${m.customerPhone || cd.phone || ''}`,
            ...(m.kind === 'premade'
              ? ['', 'Personalization:', ...(fields.length ? fields : ['(none)'])]
              : ['', `Material: ${m.material || ''}`, `Size: ${m.size || ''}`, '', `Personalization: ${m.personalization || ''}`, `Notes: ${m.notes || ''}`]),
            ...shipLines,
            '',
            `Amount paid${m.kind === 'premade' ? '' : ' (50% deposit on starting price)'}: $${amount}${taxCents ? ` (includes $${(taxCents / 100).toFixed(2)} sales tax)` : ''}`,
            `Stripe session: ${session.id}`
          ].join('\n')
        })
      });
      if (!r.ok) console.error('Resend email failed:', r.status, await r.text());
    } catch (err) {
      console.error('Resend email failed:', err);
      // Don't fail the webhook over an email issue — Stripe will retry
      // otherwise, and the payment itself already succeeded.
    }
  }

  res.status(200).json({ received: true });
}

module.exports = handler;
// Must be attached AFTER module.exports is assigned, or it is lost.
module.exports.config = { api: { bodyParser: false } };
