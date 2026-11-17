# SieCraft LLC — Website

**Custom CNC Wood Signs & Laser Engraving · Orlando, FL**

> Handmade in Orlando. Made to order. Every piece personalized.

🌐 **Live Site:** [SieCraft.com](https://siecraft.com)  
📱 **Phone/Text:** (929) 371-0501  
📧 **Email:** SieCraftcnc@gmail.com  
📍 **Location:** Orlando, FL  
📸 **Instagram:** [@SieCraftOrlando](https://instagram.com/SieCraftOrlando)

---

## 📁 Repository Contents

```
index.html            homepage (tabs: #products #shop #order #pricing #gallery #blog #about #faq #contact)
blog.html             blog index at /blog
blog-*.html           20 articles at /blog/<slug>
*-orlando.html        product landing pages
*-fl.html             service-area pages
products.json         prices and products
api/                  checkout, quote, webhook
img/gallery/          gallery photos
og-image.png          image shown when the site is shared
```

---

## 🏗️ About This Website

SieCraft.com is a fully self-contained single-page website built in pure HTML, CSS, and JavaScript. No frameworks, no build tools, no dependencies — everything is embedded directly in `index.html`.

### Sections

| Section | Description |
|---|---|
| 🏠 Hero | Main headline, CTAs, trust stats, product preview cards |
| 🔄 Marquee | Scrolling product ticker |
| 🛍️ Products | 8 product category cards |
| 💪 Why SieCraft | Value pillars (accordion) |
| ⚙️ How It Works | 4-step process |
| ⭐ Customer Favorites | Featured product showcase |
| 💬 Testimonials | 6 customer reviews |
| 📖 About | Our story + equipment |
| 📝 Blog | 5 articles targeting local SEO keywords |
| 💰 Pricing | 14 products with prices + bulk discount tiers |
| 📸 Gallery | Product photo gallery |
| 📋 Order Form | 4-step guided order flow |
| ❓ FAQ | 8 Q&As (accordion) |
| 🔗 Footer | Links, contact info, social |

### SEO Features Built In

- ✅ Schema.org structured data (LocalBusiness, FAQPage, WebSite)
- ✅ Open Graph tags for social sharing
- ✅ Meta title, description, and keywords
- ✅ Blog section targeting Orlando local search terms
- ✅ Mobile-responsive design
- ✅ Fast load time (single file, no external dependencies except Google Fonts)

---

## 🚀 Deployment

Vercel deploys every push. Pushes to `main` go to siecraft.com; any other branch gets a preview URL.

### Environment variables (Vercel → Settings → Environment Variables)

| Name | Needed for | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | Online deposits and checkout | `sk_test_…` in Preview, `sk_live_…` in Production. From the **SieCraft** Stripe account. |
| `STRIPE_WEBHOOK_SECRET` | Order-paid emails | From the webhook `https://siecraft.com/api/webhook`, event `checkout.session.completed`. |
| `RESEND_API_KEY` | Quote form + order emails | siecraft.com must be verified in Resend. |
| `MAIL_FROM` | Optional | Defaults to `SieCraft <orders@siecraft.com>`. |
| `ORDER_EMAIL` | Optional | Where orders go. Defaults to `SieCraftcnc@gmail.com`. |
| `SITE_URL` | Optional | Defaults to `https://siecraft.com`. Set to the preview URL when testing checkout on a preview. |

Without these, the site still works: the quote form and checkout show an honest "not sent / not set up" message with the phone number, instead of failing silently.

### Where things live

| What | File |
|---|---|
| Prices (server reads these; the browser can't change them) | `products.json` |
| Ready-to-ship products | `products.json` → `premade` (images in `img/shop/`) |
| Gallery photos | `img/gallery/` + `img/gallery/gallery.json` |
| Quote form handler | `api/quote.js` |
| Checkout | `api/checkout.js` |
| Payment notification email | `api/webhook.js` |
| Blog index | `blog.html` (`/blog`); posts are `blog-*.html`, served at `/blog/<slug>` |

---

## 📞 Contact

**SieCraft LLC**  
Orlando, FL  
(929) 371-0501  
SieCraftcnc@gmail.com  
[SieCraft.com](https://siecraft.com)

---

*Built with ❤️ and a lot of sawdust in Orlando, FL.*

## Name sign builder (/name-sign) — added Nov 17, 2026
- `name-sign.html`: live configurator (name, 13 fonts, 12/18/22in, 1/4–3/4in birch, natural + 6 paints). The preview is the exact cut shape.
- Engine `js/namesign-engine.js` (JSTS + opentype.js in `js/lib/`, runs in `js/namesign-worker.js`): one connected piece, auto-bridges i-dots/near-touching letters, end-mill radius applied, thin parts thickened or refused, fail closed. Per-thickness rules in `STOCK` (adjust after test cuts).
- Fonts: `fonts/namesign/` (Latin subsets, OFL/Apache licenses alongside).
- Prices/options: `products.json` → `nameSign` (server-priced in `api/checkout.js`, kind `namesign`). Shop closed → "Order this design" emails a quote (with mockup) via `api/quote.js`. Every order includes a `?maker=1` link that opens the design with DXF download.
