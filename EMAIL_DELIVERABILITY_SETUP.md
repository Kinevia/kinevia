# Email Deliverability Fix for kinevia.pro

## Current Status

**Issue:** Transactional emails (signup confirmation, password reset) are going to spam for kinevia.pro recipients.

**Root Cause:**
- App sends emails via Polsia's email proxy infrastructure
- kinevia.pro domain has NO SPF/DKIM/DMARC records configured
- Email clients treat unverified senders as suspicious → spam folder

**Current Email Configuration:**
- Service: Polsia email-proxy
- Sender: Polsia infrastructure (not kinevia.pro domain)
- DNS: Not configured for email authentication

---

## Solution Path

### Option A: Quick Fix (Recommend for MVP)
**Use Postmark with kinevia.pro as sender domain** (Professional, reliable, recommended)

**Steps:**
1. Sign up for Postmark account (free tier available, but company may have existing Postmark)
2. Add kinevia.pro as verified sender domain in Postmark
3. Follow Postmark's instructions to add DNS records
4. Get Postmark Server Token
5. Update app to send from `contact@kinevia.pro` via Postmark API
6. Test email deliverability

**Estimated DNS Records Needed:**
```
SPF Record:
  Name: kinevia.pro (or @)
  Type: TXT
  Value: v=spf1 include:postmarkapp.com ~all

DKIM Record:
  Name: default._domainkey.kinevia.pro
  Type: CNAME
  Value: default.postmarkapp.com (or similar, Postmark provides exact value)

DMARC Record:
  Name: _dmarc.kinevia.pro
  Type: TXT
  Value: v=DMARC1; p=none; rua=mailto:dmarc@kinevia.pro
```

**Implementation:**
```javascript
// In server.js sendEmail() function:
const res = await fetch('https://api.postmarkapp.com/email', {
  method: 'POST',
  headers: {
    'X-Postmark-Server-Token': process.env.POSTMARK_API_KEY,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    From: 'contact@kinevia.pro',
    To: to,
    Subject: subject,
    TextBody: body,
    HtmlBody: html,
  }),
});
```

**Pro:** Professional sender reputation, full control, excellent deliverability
**Con:** Requires Postmark setup and API key management

---

### Option B: Minimal Fix (If Postmark not available)
**Configure Polsia's email-proxy domain with SPF** (Temporary, less reliable)

This would require Polsia to configure SPF/DKIM/DMARC for the proxy domain.

**Pro:** No additional setup needed
**Con:** Still sending from Polsia infrastructure, not ideal long-term

---

## Action Items

### For Polsia/Engineering:
1. ✅ Verified current email setup (Polsia email-proxy)
2. Provide Postmark Server Token or configure alternative solution
3. (Optional) Set up POSTMARK_API_KEY in production environment

### For Owner (Amin):
1. **Access kinevia.pro DNS** (OVH)
2. **Add DNS records** as provided below
3. **Test email delivery** from contact@kinevia.pro
4. **Verify inbox vs spam** folder

---

## DNS Records to Add to kinevia.pro (OVH)

Login to OVH console → Select kinevia.pro → DNS Zone

### 1. SPF Record
```
Subdomain: @
Type: TXT
TTL: 3600
Value: v=spf1 include:postmarkapp.com ~all
```

### 2. DKIM Record
```
Subdomain: default._domainkey
Type: CNAME
TTL: 3600
Value: default.postmarkapp.com (check Postmark account for exact CNAME)
```

### 3. DMARC Record
```
Subdomain: _dmarc
Type: TXT
TTL: 3600
Value: v=DMARC1; p=none; rua=mailto:noreply@kinevia.pro
```

**Note:** DKIM CNAME value varies by Postmark server. Check Postmark account settings for your specific value.

---

## Testing

After DNS records propagate (can take 30min-2 hours):

1. **Send test email** to a Gmail, Outlook, or other major provider
2. **Check inbox** - should arrive in main inbox, NOT spam
3. **Inspect email headers** - verify SPF/DKIM/DMARC pass
4. **Monitor bounce rates** - should be <0.5%

### Test Email Tool:
Gmail: Tools → Check MX and SPF records for kinevia.pro

---

## Current DNS Status (kinevia.pro)

```
A Record: 216.24.57.1 (OVH)
CNAME (www): creneau.onrender.com
MX Records: NOT CONFIGURED (emails cannot be received)
SPF: NOT CONFIGURED
DKIM: NOT CONFIGURED
DMARC: NOT CONFIGURED
```

⚠️ **kinevia.pro cannot receive emails** - No MX record. Only transactional emails are sent (no inbox).

---

## Production Deployment

Once DNS records are added and verified:

1. Update `server.js` to use Postmark
2. Set `POSTMARK_API_KEY` environment variable in Render
3. Deploy and monitor email logs
4. Verify all transactional emails arrive in inbox

---

## References

- Postmark Setup: https://postmarkapp.com/guides/everything-about-domains
- SPF/DKIM/DMARC: https://support.google.com/mail/answer/2716800
- OVH DNS Management: https://docs.ovh.com/us/en/domains/dns_zone_edit/
