# Cursor Prompt — Production Fixes

Paste the following into Cursor. These are the 3 code changes needed to get this app production-ready for daily use.

---

## PROMPT:

Make the following 3 targeted fixes to prepare this app for production. Do not change any other logic.

---

### Fix 1: Remove hardcoded API key fallback in backend/config/retell.js

Find the line that looks like this:
```javascript
this.apiKey = process.env.RETELL_API_KEY || '<previously-hardcoded-key-redacted>';
```

Replace it with:
```javascript
this.apiKey = process.env.RETELL_API_KEY;
if (!this.apiKey) {
  console.error('❌ RETELL_API_KEY environment variable is not set');
}
```

Also check docker-compose.yml for any hardcoded fallback API key in the format:
```
RETELL_API_KEY=${RETELL_API_KEY:-key_5286...}
```
Replace it with:
```
RETELL_API_KEY=${RETELL_API_KEY}
```

---

### Fix 2: Add carein-do.flamingketchup.com to CORS allowed origins in backend/server.js

Find the corsOrigins array initialization. It currently looks something like:
```javascript
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim()).filter(Boolean)
  : ['http://localhost:3000', 'http://localhost:3001', ...];
```

After that block, add the production domain if it's not already included:
```javascript
const PRODUCTION_DOMAINS = [
  'https://carein-do.flamingketchup.com',
  'http://carein-do.flamingketchup.com',
];
PRODUCTION_DOMAINS.forEach(domain => {
  if (!corsOrigins.includes(domain)) corsOrigins.push(domain);
});
```

---

### Fix 3: Add Retell webhook signature verification to backend/routes/webhooks.js

At the top of webhooks.js, after the existing requires, add:
```javascript
const crypto = require('crypto');
```

Then add a signature verification helper function before the router.post('/retell') handler:
```javascript
/**
 * Verify Retell webhook signature
 * Retell signs each webhook with HMAC-SHA256 using your API key
 * Header: x-retell-signature
 */
function verifyRetellSignature(req) {
  // Skip verification in development
  if (process.env.NODE_ENV !== 'production') return true;

  const signature = req.headers['x-retell-signature'];
  if (!signature) {
    console.warn('⚠️ Missing x-retell-signature header');
    return false;
  }

  const apiKey = process.env.RETELL_API_KEY || '';
  const body = JSON.stringify(req.body);
  const expected = crypto
    .createHmac('sha256', apiKey)
    .update(body)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}
```

Then at the very top of the `router.post('/retell', async (req, res) => {` handler body, add:
```javascript
// Verify signature in production
if (!verifyRetellSignature(req)) {
  console.warn('⚠️ Invalid Retell signature — rejecting webhook');
  return res.status(401).json({ error: 'Invalid signature' });
}
```

---

### Fix 4: Also update backend/.env — add the production CORS origin

Open backend/.env and add or update the CORS_ORIGIN line to include the production domain:
```
CORS_ORIGIN=http://localhost:3000,http://localhost:3001,http://localhost:3004,http://localhost:3005,https://carein-do.flamingketchup.com
```

---

After making all 4 fixes, confirm:
- No linter errors
- backend/config/retell.js has no hardcoded key
- backend/routes/webhooks.js has the signature verification function
- backend/server.js includes carein-do.flamingketchup.com in CORS
