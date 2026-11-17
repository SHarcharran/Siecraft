// api/quote.js
// Receives the "Get a Free Quote" form, emails the request (with any photos)
// to the shop, and sends the customer a confirmation.
// Replaces the old mailto: link, which silently lost requests on devices
// with no mail app set up.
//
// Env vars: RESEND_API_KEY (required)
//           ORDER_EMAIL (optional, default orders@siecraft.com)
//           MAIL_FROM   (optional, default "SieCraft <orders@siecraft.com>";
//                        the domain must be verified in Resend)

const MAX_PHOTOS = 3;
const MAX_TOTAL_B64 = 3.5 * 1024 * 1024; // stays under Vercel's 4.5 MB body limit
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

// "2026-12-10" -> "Thu, Dec 10, 2026"; anything else is returned as typed.
// First 3 digits of a US ZIP -> state (USPS prefix ranges). Used to label the quote and spot out-of-state shipping.
const ZIP3 = [[5,5,'NY'],[6,9,'PR'],[10,27,'MA'],[28,29,'RI'],[30,38,'NH'],[39,49,'ME'],[50,59,'VT'],[60,69,'CT'],[70,89,'NJ'],[100,149,'NY'],[150,196,'PA'],[197,199,'DE'],[200,200,'DC'],[201,201,'VA'],[202,205,'DC'],[206,219,'MD'],[220,246,'VA'],[247,268,'WV'],[270,289,'NC'],[290,299,'SC'],[300,319,'GA'],[320,339,'FL'],[341,349,'FL'],[350,369,'AL'],[370,385,'TN'],[386,397,'MS'],[398,399,'GA'],[400,427,'KY'],[430,459,'OH'],[460,479,'IN'],[480,499,'MI'],[500,528,'IA'],[530,549,'WI'],[550,567,'MN'],[569,569,'DC'],[570,577,'SD'],[580,588,'ND'],[590,599,'MT'],[600,629,'IL'],[630,658,'MO'],[660,679,'KS'],[680,693,'NE'],[700,714,'LA'],[716,729,'AR'],[730,749,'OK'],[750,799,'TX'],[800,816,'CO'],[820,831,'WY'],[832,838,'ID'],[840,847,'UT'],[850,865,'AZ'],[870,884,'NM'],[885,885,'TX'],[889,898,'NV'],[900,961,'CA'],[967,968,'HI'],[969,969,'GU'],[970,979,'OR'],[980,994,'WA'],[995,999,'AK']];
function zipState(zip) {
  const n = parseInt(String(zip).slice(0, 3), 10);
  if (!/^\d{5}$/.test(String(zip))) return '';
  const hit = ZIP3.find(([a, b]) => n >= a && n <= b);
  return hit ? hit[2] : '';
}

function niceDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return v || '';
  const d = new Date(v + 'T12:00:00Z');
  return isNaN(d) ? v : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// Short, human-friendly reference: Q-MMDD-XXXX (no 0/O/1/I to avoid misreading).
function quoteRef() {
  const d = new Date();
  const mmdd = String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = '';
  for (let i = 0; i < 4; i++) r += abc[Math.floor(Math.random() * abc.length)];
  return `Q-${mmdd}-${r}`;
}

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
    deadlineNice: niceDate(clip(b.deadline, 60)),
    delivery: b.delivery === 'ship' ? 'ship' : 'pickup',
    zip: String(b.zip || '').replace(/\D/g, '').slice(0, 5),
    text: clip(b.text, 3000),
    notes: clip(b.notes, 3000)
  };

  if (!q.name.trim() || !q.phone || !q.text || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q.email)) {
    res.status(400).json({ error: 'Please fill in your name, email, phone, and what you want engraved.' });
    return;
  }

  if (q.delivery === 'ship' && q.zip.length !== 5) {
    res.status(400).json({ error: 'Please enter a 5-digit ZIP code for shipping.' });
    return;
  }
  q.state = q.delivery === 'ship' ? zipState(q.zip) : '';
  q.deliveryLine = q.delivery === 'ship'
    ? `Ship to ${q.zip}${q.state ? ` (${q.state})` : ''}${q.state && q.state !== 'FL' ? ' · OUT OF STATE' : ''}`
    : 'Pickup (free, Orlando)';

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
  const to = process.env.ORDER_EMAIL || 'orders@siecraft.com';

  const ref = quoteRef();
  const ownerText = [
    'NEW QUOTE REQUEST — siecraft.com',
    `Quote #: ${ref}`,
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
    `Needed by: ${q.deadline}${q.deadlineNice && q.deadlineNice !== q.deadline ? ` (${q.deadlineNice})` : ''}`,
    `Delivery: ${q.deliveryLine}`,
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
      subject: `Quote request ${ref}: ${q.type || 'Custom order'} from ${q.name}${q.deadline !== 'No date given' ? ` (needed by ${q.deadlineNice || q.deadline})` : ''}`,
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
      subject: `We got your SieCraft quote request (${ref})`,
      text: [
        `Hi ${clip(b.fname, 40).replace(/[^\p{L}\p{M}' .-]/gu, '') || 'there'},`,
        '',
        `Thanks for reaching out about a ${q.type || 'custom piece'}. Your request reached us, and we'll reply with an exact price${q.delivery === 'ship' ? ` including shipping to ${q.zip}` : ' (free pickup in Orlando)'}. Once you approve and place your deposit, we'll send your free design proof.`,
        '',
        `Your quote number is ${ref}. Mention it if you call or text.`,
        '',
        'Questions, or want to add something? Just reply to this email or text (929) 371-0501.',
        '',
        'SieCraft',
        'Made in Orlando, FL · siecraft.com'
      ].join('\n')
    });
  } catch (err) {
    console.error('quote confirmation email failed:', err.message);
  }

  res.status(200).json({ ok: true });
};
