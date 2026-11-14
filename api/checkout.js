// api/checkout.js
// Creates a Stripe Checkout Session.
// The browser sends only WHAT it wants (kind + product id + quantity).
// Every price is looked up here, server-side, from products.json, so a
// customer can't change what they pay by editing the page.
//
// Env vars: STRIPE_SECRET_KEY (required), SITE_URL (optional),
// STRIPE_TAX_RATE_ID (optional: a Stripe Tax Rate, e.g. Florida 6.5%, applied
// by customer address to Buy Now items and deposits).

const Stripe = require('stripe');
const catalog = require('../products.json');

const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    res.status(503).json({ error: 'Online payment is not set up yet.' });
    return;
  }

  const body = req.body || {};
  const email = clip(body.customerEmail, 200).trim();
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  // Deposits need the email up front; Buy Now lets Stripe collect it.
  if (body.kind !== 'premade' && !emailOk) {
    res.status(400).json({ error: 'A valid email is required.' });
    return;
  }

  let lineItem, kind, productName, extra = {};

  if (body.kind === 'premade') {
    const item = (catalog.premade || []).find(p => p.id === body.id && p.visible !== false);
    if (!item) { res.status(400).json({ error: 'That item is no longer available.' }); return; }
    const made = item.madeToOrder === true;
    if (!made && !(item.stock > 0)) { res.status(400).json({ error: 'That item is sold out.' }); return; }
    const maxQty = made ? 20 : Math.min(item.stock, 20);
    kind = 'premade';
    productName = item.name;
    lineItem = {
      price_data: {
        currency: 'usd',
        product_data: { name: item.name, description: clip(item.description, 500) || undefined },
        unit_amount: Math.round(item.price * 100)
      },
      quantity: 1,
      adjustable_quantity: { enabled: true, minimum: 1, maximum: maxQty }
    };
    const ship = catalog.shipping || {};
    extra.shipping_address_collection = { allowed_countries: ['US'] };
    extra.shipping_options = [
      { shipping_rate_data: { type: 'fixed_amount', display_name: clip(ship.pickupLabel || 'Free local pickup (Orlando)', 100),
          fixed_amount: { amount: 0, currency: 'usd' } } },
      { shipping_rate_data: { type: 'fixed_amount', display_name: clip(ship.label || 'USPS shipping (US)', 100),
          fixed_amount: { amount: Math.round((ship.flat || 6) * 100), currency: 'usd' } } }
    ];
    const fields = (item.personalize || []).slice(0, 3).map(f => ({
      key: String(f.key).replace(/[^a-zA-Z0-9]/g, '').slice(0, 200) || 'text',
      label: { type: 'custom', custom: clip(f.label, 50) },
      type: 'text',
      optional: !!f.optional,
      text: { maximum_length: Math.min(Math.max(parseInt(f.max, 10) || 60, 1), 255) }
    }));
    if (fields.length) extra.custom_fields = fields;
  } else {
    const item = (catalog.custom || []).find(p => p.id === body.id);
    if (!item) { res.status(400).json({ error: 'Unknown product.' }); return; }
    const depositCents = Math.round(item.from * (catalog.depositRate || 0.5) * 100);
    if (depositCents < 50) { res.status(400).json({ error: 'Deposit too small to process online.' }); return; }
    kind = 'deposit';
    productName = item.name;
    lineItem = {
      price_data: {
        currency: 'usd',
        product_data: {
          name: `SieCraft deposit: ${item.name}`,
          description: `50% deposit on the $${item.from} starting price. Applied to your final total. Fully refundable until you approve your design proof.`
        },
        unit_amount: depositCents
      },
      quantity: 1
    };
  }

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const site = process.env.SITE_URL || 'https://siecraft.com';
    const who = clip(body.customerName, 80).trim() || email;
    const description = clip(`${kind === 'deposit' ? 'Deposit' : 'Order'}: ${productName} - ${who}`, 300);
    const taxRate = process.env.STRIPE_TAX_RATE_ID;
    if (taxRate) lineItem.dynamic_tax_rates = [taxRate];
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      ...(emailOk ? { customer_email: email } : {}),
      ...extra,
      // Save a Customer so name/email show on every payment in the dashboard.
      customer_creation: 'always',
      payment_intent_data: {
        description,
        metadata: { kind, product: clip(productName, 200), customerName: clip(body.customerName, 200) }
      },
      line_items: [lineItem],
      phone_number_collection: { enabled: true },
      metadata: {
        kind,
        product: clip(productName, 200),
        customerName: clip(body.customerName, 200),
        customerPhone: clip(body.customerPhone, 40),
        material: clip(body.material, 100),
        size: clip(body.size, 100),
        personalization: clip(body.personalization, 490),
        notes: clip(body.notes, 490)
      },
      success_url: `${site}/?order=success`,
      cancel_url: `${site}/?order=cancelled#shop`
    });
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('checkout error:', err && err.message);
    res.status(500).json({ error: 'Could not start checkout. Please try again or text us.' });
  }
};
