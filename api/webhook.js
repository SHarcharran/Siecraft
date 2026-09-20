// api/webhook.js
// Listens for checkout.session.completed from Stripe, then emails the full
// order details to SieCraftcnc@gmail.com via Resend.
// Requires STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY in Vercel.

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Stripe needs the raw request body to verify the signature, so the
// default JSON body parser must be disabled for this route.
module.exports.config = {
  api: { bodyParser: false }
};

function buffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const buf = await buffer(req);
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

    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'SieCraft Orders <orders@siecraft.com>',
          to: ['SieCraftcnc@gmail.com'],
          subject: `💰 Deposit Paid — ${m.product || 'Custom Order'} ($${amount})`,
          text: [
            'New SieCraft deposit payment received!',
            '',
            `Product: ${m.product || ''}`,
            `Customer: ${m.customerName || ''}`,
            `Email: ${paidEmail}`,
            `Phone: ${m.customerPhone || ''}`,
            '',
            `Material: ${m.material || ''}`,
            `Size: ${m.size || ''}`,
            `Finish: ${m.finish || ''}`,
            `Quantity: ${m.quantity || ''}`,
            `Turnaround: ${m.rush === 'rush' ? 'RUSH 48HR' : 'Standard 3–5 days'}`,
            '',
            `Personalization: ${m.personalization || ''}`,
            `Notes: ${m.notes || ''}`,
            '',
            `Amount Paid (50% deposit): $${amount}`,
            `Stripe session: ${session.id}`
          ].join('\n')
        })
      });
    } catch (err) {
      console.error('Resend email failed:', err);
      // Don't fail the webhook over an email issue — Stripe will retry
      // otherwise, and the payment itself already succeeded.
    }
  }

  res.status(200).json({ received: true });
};
