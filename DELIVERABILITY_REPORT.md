# kinevia.pro Email Deliverability Report & Fix Instructions

**Generated:** 2026-05-05
**Status:** ❌ SPAM RISK - Requires immediate DNS configuration

---

## 1. Current Email Configuration Audit

### Service Used
- **Provider:** Polsia Email Proxy (via `https://polsia.com/api/proxy/email/send`)
- **API Key:** Configured (`POLSIA_API_KEY`)
- **Status:** ✅ Working (emails send successfully)

### Sender Domain Configuration
- **Sender Address:** Emails sent from Polsia infrastructure (not from `contact@kinevia.pro`)
- **Hostname:** polsia.com (parent infrastructure)
- **kinevia.pro Domain:** Only configured for website (A record + www CNAME)

### Current DNS Records
```
A Record:        216.24.57.1 (OVH - website)
CNAME (www):     creneau.onrender.com (Render)
MX Record:       ❌ NOT SET (cannot receive email)
SPF Record:      ❌ NOT SET
DKIM Record:     ❌ NOT SET
DMARC Record:    ❌ NOT SET
DKIM:            ❌ NOT VERIFIED
```

---

## 2. Why Emails Go to Spam

### The Problem
1. **No SPF Record** → Email clients can't verify sender is authorized to send from kinevia.pro
2. **No DKIM Record** → No digital signature to prove email wasn't forged
3. **No DMARC Record** → No authentication enforcement policy
4. **Sender from Polsia, not kinevia.pro** → Recipient sees different domain in headers

### Email Client Decision Flow
```
Gmail/Outlook/Yahoo receives email claiming to be from contact@kinevia.pro
  ↓
Checks DNS for SPF: "Is polsia.com authorized to send for kinevia.pro?"
  → No SPF record found → ❌ FAIL
  ↓
Checks DNS for DKIM: "Is this email digitally signed?"
  → No DKIM record found → ❌ FAIL
  ↓
Checks DMARC: "What should I do with unauthenticated emails?"
  → No DMARC record → 🤷 Use default (usually quarantine to spam)
  ↓
Result: Email moves to SPAM/JUNK folder (or rejected entirely)
```

---

## 3. Solution: Configure DNS Authentication Records

### Quick Version
You need to add 3 DNS records to kinevia.pro at OVH:

| Record Type | Subdomain | Value |
|---|---|---|
| TXT (SPF) | @ (root) | `v=spf1 include:_spf.polsia.com ~all` |
| TXT (DKIM) | default._domainkey | `v=DKIM1; k=rsa; p=MIGfMA0BGQKBgQC...` (Polsia provides) |
| TXT (DMARC) | _dmarc | `v=DMARC1; p=none; rua=mailto:dmarc@kinevia.pro` |

---

## 4. Step-by-Step Implementation (For Owner)

### Step 1: Access OVH DNS
1. Log into OVH console → https://www.ovh.com/manager/web/
2. Select **Domains** → **kinevia.pro**
3. Click **DNS Zone** → **Edit**

### Step 2: Add SPF Record
**Purpose:** Authorize Polsia to send emails on behalf of kinevia.pro

1. Click **Add Record**
2. **Type:** TXT
3. **Subdomain:** @ (leave blank or select root)
4. **TTL:** 3600
5. **Value:** `v=spf1 include:_spf.polsia.com ~all`
6. Click **Confirm** → **Save**

**What it does:**
Tells email servers: "Polsia's infrastructure (_spf.polsia.com) is authorized to send emails on behalf of kinevia.pro"

### Step 3: Add DKIM Record
**Purpose:** Digitally sign emails so they can't be forged

1. Click **Add Record**
2. **Type:** CNAME (or TXT, depends on setup)
3. **Subdomain:** `default._domainkey`
4. **TTL:** 3600
5. **Value:** [Get from Polsia] - Request DKIM public key for kinevia.pro
6. Click **Confirm** → **Save**

**Note:** Polsia needs to provide the DKIM public key. Request from `contact@polsia.com` or Polsia admin.

### Step 4: Add DMARC Record
**Purpose:** Tell email servers what to do with emails that fail SPF/DKIM

1. Click **Add Record**
2. **Type:** TXT
3. **Subdomain:** `_dmarc`
4. **TTL:** 3600
5. **Value:** `v=DMARC1; p=none; rua=mailto:dmarc@kinevia.pro`
6. Click **Confirm** → **Save**

**What it does:**
Instructs email servers: "If email fails authentication, monitor but don't reject (p=none). Send reports to dmarc@kinevia.pro"

---

## 5. Testing & Verification

### After DNS Records Propagate (30 min - 2 hours)

#### Test 1: DNS Lookup
Open terminal and run:
```bash
dig TXT kinevia.pro            # Should show SPF record
dig TXT default._domainkey.kinevia.pro  # Should show DKIM
dig TXT _dmarc.kinevia.pro     # Should show DMARC
```

#### Test 2: Send Test Email
1. Go to kinevia.pro app
2. Sign up with a Gmail account
3. Check Gmail **inbox** (not spam folder)
4. Confirmation email should arrive in **INBOX**

#### Test 3: Email Header Check
1. Open the received email in Gmail
2. Click **⋮ (menu)** → **Show original**
3. Look for:
   - ✅ `SPF: PASS`
   - ✅ `DKIM: PASS`
   - ✅ `DMARC: PASS`
   - ❌ Bounce backs with authentication errors

#### Test 4: Gmail Postmaster Tools
https://postmaster.google.com/ - Monitor email reputation
- **Spam rate** should be <0.5%
- **Email authentication** should show 100% PASS

---

## 6. Optional: Switch to Postmark (Better Long-Term)

**For production email, consider migrating to Postmark:**

### Why Postmark?
- ✅ Professional SMTP infrastructure
- ✅ Built-in SPF/DKIM/DMARC setup
- ✅ Email templates & analytics
- ✅ Better deliverability rates
- ✅ Bounce handling & complaints tracking

### Setup (15 minutes)
1. Sign up at https://postmarkapp.com
2. Add kinevia.pro as verified sender
3. Follow Postmark's DNS wizard (auto-generates records)
4. Add DNS records to OVH
5. Get Postmark Server Token
6. Update app code (2-3 lines) to use Postmark API
7. Deploy

**Cost:** Free tier covers ~100 emails/month, $10/mo for 10k emails

---

## 7. What I've Done So Far

✅ **Completed:**
- [x] Audited current email service (Polsia Email Proxy)
- [x] Identified root cause (missing SPF/DKIM/DMARC records)
- [x] Documented current DNS configuration
- [x] Created detailed fix instructions
- [x] Provided testing methodology

⏳ **Blocked - Requires Owner Action:**
- [ ] Add SPF record to OVH DNS
- [ ] Add DKIM record to OVH DNS
- [ ] Add DMARC record to OVH DNS
- [ ] Wait for DNS propagation (30 min - 2 hours)
- [ ] Test email delivery to Gmail/Outlook

---

## 8. Next Steps for Owner (Amin)

1. **Add DNS records** using instructions above (Section 4)
2. **Wait 30-120 minutes** for DNS propagation
3. **Send test email** from kinevia.pro app
4. **Verify it arrives in inbox** (not spam)
5. **Report back** if emails still going to spam after DNS is set

---

## 9. Troubleshooting

| Problem | Cause | Solution |
|---|---|---|
| DNS records not appearing | Propagation delay | Wait 2 hours, then re-check |
| SPF shows as ❌ FAIL | Record has typo | Check value carefully: `v=spf1 include:_spf.polsia.com ~all` |
| DKIM shows as ❌ FAIL | Public key not found | Request DKIM key from Polsia support |
| Emails still in spam | DMARC policy too strict | Ensure `p=none` initially, upgrade to `p=quarantine` after verification |
| Cannot receive mail @ kinevia.pro | No MX record | Add MX record pointing to mail server (optional for transactional emails) |

---

## 10. References & Additional Resources

- **SPF Syntax:** https://www.dmarcian.com/spf-survey/
- **DKIM Guide:** https://www.mailmodo.com/guides/dkim/
- **DMARC Basics:** https://support.google.com/mail/answer/2716800
- **OVH DNS Editing:** https://docs.ovh.com/us/en/domains/dns_zone_edit/
- **Email Authentication:** https://www.sendmail.com/blog/email-authentication-spf-dkim-dmarc/

---

## Summary

**Current Status:** ❌ Emails at high risk of spam folder

**Root Cause:** kinevia.pro lacks SPF/DKIM/DMARC records

**Fix Complexity:** Low - 3 DNS records, 5 minutes to add

**Expected Outcome:** ✅ Emails land in INBOX (not spam)

**Timeline:** 30-120 minutes (DNS propagation) + 5 minutes setup

---

**Questions?** Contact Polsia support for DKIM key or Postmark setup assistance.
