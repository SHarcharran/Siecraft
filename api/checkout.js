// api/checkout.js
// Creates a Stripe Checkout Session for a SieCraft custom-order deposit.
// Requires STRIPE_SECRET_KEY in Vercel → Settings → Environment Variables.

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const {
      product, customerName, customerEmail, customerPhone,
      material, size, finish, quantity, rush,
      personalization, notes, depositAmount
    } = req.body || {};

    const amountCents = Math.round(Number(depositAmount) * 100);
    if (!amountCents || amountCents < 50) {
      res.status(400).json({ error: 'Invalid deposit amount' });
      return;
    }
    if (!customerEmail) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }

    const site = process.env.SITE_URL || 'https://siecraft.com';

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: customerEmail,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `SieCraft Deposit — ${product || 'Custom Order'}`,
            description: `50% deposit. Material: ${material || 'n/a'} · Size: ${size || 'n/a'} · Qty: ${quantity || 1}`.slice(0, 500)
          },
          unit_amount: amountCents
        },
        quantity: 1
      }],
      // Metadata is what api/webhook.js reads to email you the full order.
      metadata: {
        product: product || '',
        customerName: customerName || '',
        customerPhone: customerPhone || '',
        material: material || '',
        size: size || '',
        finish: finish || '',
        quantity: String(quantity || ''),
        rush: String(rush || ''),
        personalization: (personalization || '').slice(0, 490),
        notes: (notes || '').slice(0, 490)
      },
      success_url: `${site}/?order=success`,
      cancel_url: `${site}/?order=cancelled`
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('checkout.js error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
};
