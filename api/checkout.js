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
  // Deposits need the email up front; Buy Now and name signs let Stripe collect it.
  if (body.kind !== 'premade' && body.kind !== 'namesign' && !emailOk) {
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
  } else if (body.kind === 'namesign') {
    // Name cutout sign from /name-sign. Every option is checked against products.json and priced here.
    const ns = catalog.nameSign || {};
    if (!ns.visible) { res.status(400).json({ error: 'Name signs are not available right now.' }); return; }
    const d = body.design || {};
    const text = String(d.text || '').normalize('NFC').replace(/\s+/g, ' ').trim();
    const maxChars = ns.maxChars || 16;
    if (!text || Array.from(text).length > maxChars || !/^[\p{L}\p{M}0-9 &'’.\-]+$/u.test(text)) {
      res.status(400).json({ error: 'Please check the name on your sign.' }); return;
    }
    const si = (ns.sizes || []).findIndex(z => z.width === Number(d.width));
    const stock = (ns.stock || []).find(z => z.id === d.stock);
    const fin = (ns.finishes || []).find(z => z.id === d.finish);
    const font = (ns.fonts || []).find(z => z.id === d.font);
    if (si < 0 || !stock || !fin || !font) { res.status(400).json({ error: 'Please pick a size, thickness, finish and font.' }); return; }
    const size = ns.sizes[si];
    const bar = font.bar ? true : !!d.bar;
    const price = size.price + (fin.paint ? size.paint : 0) + ((stock.add || [])[si] || 0);
    kind = 'namesign';
    productName = `${ns.name || 'Name Cutout Sign'}: "${text}"`;
    const spec = `${size.width}in wide · ${stock.label} · ${fin.label} · ${font.label} font${bar ? ' · underline bar' : ''}`;
    lineItem = {
      price_data: {
        currency: 'usd',
        product_data: { name: clip(productName, 250), description: clip(spec, 500) },
        unit_amount: Math.round(price * 100)
      },
      quantity: 1
    };
    extra.shipping_address_collection = { allowed_countries: ['US'] };
    extra.shipping_options = [
      { shipping_rate_data: { type: 'fixed_amount', display_name: clip((catalog.shipping || {}).pickupLabel || 'Free local pickup (Orlando)', 100),
          fixed_amount: { amount: 0, currency: 'usd' } } },
      { shipping_rate_data: { type: 'fixed_amount', display_name: clip(`USPS shipping (${size.width}in sign)`, 100),
          fixed_amount: { amount: Math.round((size.ship || 12) * 100), currency: 'usd' } } }
    ];
    const site0 = process.env.SITE_URL || 'https://siecraft.com';
    const q = new URLSearchParams({ n: text, f: font.id, w: String(size.width), t: stock.id, c: fin.id, b: bar ? '1' : '0' });
    extra._namesign = { size: `${size.width}in wide`, material: stock.label, personalization: `"${text}" · ${font.label} (${font.family}) · ${fin.label}${bar ? ' · underline bar' : ''}`,
      notes: `Cut file: ${site0}/name-sign?${q.toString()}&maker=1` };
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
    const ns_ = extra._namesign || {};
    delete extra._namesign;
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
        material: clip(ns_.material || body.material, 100),
        size: clip(ns_.size || body.size, 100),
        personalization: clip(ns_.personalization || body.personalization, 490),
        notes: clip(ns_.notes || body.notes, 490)
      },
      success_url: kind === 'namesign' ? `${site}/name-sign?order=success` : `${site}/?order=success`,
      cancel_url: kind === 'namesign' ? `${site}/name-sign?order=cancelled` : `${site}/?order=cancelled#shop`
    });
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('checkout error:', err && err.message);
    res.status(500).json({ error: 'Could not start checkout. Please try again or text us.' });
  }
};
