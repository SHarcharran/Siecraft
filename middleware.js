// middleware.js
// Real server-side password protection for the admin pages.
// Runs BEFORE the page is served — unlike a password check written in
// the page's own JavaScript, this can't be bypassed by viewing source.
//
// Requires two Vercel env vars: ADMIN_USER and ADMIN_PASS
// (Vercel → Settings → Environment Variables)

import { next } from '@vercel/edge';

export const config = {
  matcher: [
    '/shop-manager', '/shop-manager.html',
    '/photo-gallery', '/photo-gallery.html',
    '/admin', '/admin.html',
    '/siecraft-shop-manager', '/siecraft-shop-manager.html',
    '/siecraft-photo-gallery', '/siecraft-photo-gallery.html',
    '/siecraft-admin', '/siecraft-admin.html',
    '/siecraft-command-center', '/siecraft-command-center.html'
  ]
};

export default function middleware(request) {
  const authHeader = request.headers.get('authorization');

  if (authHeader) {
    const [scheme, encoded] = authHeader.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = atob(encoded);
      const separatorIndex = decoded.indexOf(':');
      const user = decoded.slice(0, separatorIndex);
      const pass = decoded.slice(separatorIndex + 1);

      if (user === process.env.ADMIN_USER && pass === process.env.ADMIN_PASS) {
        return next(); // credentials correct — let the page load
      }
    }
  }

  // No credentials, or wrong credentials — ask the browser to prompt for them.
  return new Response('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="SieCraft Admin"' }
  });
}
