# ACB Client Onboarding Portal

Onboarding for Advanced Collection Bureau's residential property-management clients,
replacing the single DocuSeal form. Clients get **one shareable link** — no accounts,
no passwords — where anyone on their team can:

1. **Add every legal entity** on their leases (Building 1 LLC, Building 2 LLC, …) —
   one Agreement for Collection Services is generated per entity, individually or by
   pasting a whole list at once.
2. **Say where checks go** — either per entity, or one corporate payable-to + mailing
   address that applies to every agreement.
3. **Attach documents** — a copy of the lease they use across properties, plus their
   management agreement if they're third-party.
4. **Review a final checklist** — company info, entities, check details, and documents
   are confirmed complete before anything can be signed.
5. **Sign everything in one pass** — through DocuSeal: the client signs agreement 1,
   is automatically taken to agreement 2, and so on, then lands back on the portal.

Everything autosaves, so the link can be freely delegated within their business
(accounting fills in check details, the office manager uploads the lease, an officer signs).

## Signing: DocuSeal vs built-in

- **DocuSeal mode** (recommended — set `DOCUSEAL_API_KEY`): for each entity the server
  uploads the pre-filled agreement PDF to DocuSeal via `POST /templates/pdf` (signature
  and date fields placed on the signature lines), creates a submission for the signer,
  and chains the signing sessions together with `completed_redirect_url`. You get
  DocuSeal's legal audit trail, and signed copies are served from DocuSeal.
  Statuses sync by polling when the portal is opened, plus optionally by webhook
  (`/api/docuseal/webhook?key=...`). Set `ACB_SIGNER_EMAIL` to add an ACB countersign
  step on every document.
- **Built-in mode** (no API key set): draw/type signature captured in the browser and
  embedded into the PDFs by the server. Fine for getting started; less formal audit trail.

Note on DocuSeal pricing: API access on DocuSeal **cloud** requires their Pro plan
(~$20/mo). Alternatively **self-host DocuSeal for free** (open source) on the same VPS —
see the commented service in `docker-compose.yml` and point `DOCUSEAL_API_URL` /
`DOCUSEAL_SIGN_URL` at your instance.

## Deploying on a cheap VPS (recommended)

Any $4–6/mo VPS is plenty (Hetzner CPX11 in Ashburn VA ~$5, Vultr/DigitalOcean ~$5–6,
1 GB RAM is enough). Then:

```bash
# on a fresh Ubuntu VPS
curl -fsSL https://get.docker.com | sh
git clone https://github.com/NoahAlbers/acb-onboarding && cd acb-onboarding
cp .env.example .env && nano .env        # fill in DOMAIN, BASE_URL, ADMIN_KEY, DOCUSEAL_API_KEY
docker compose up -d
```

Point `onboard.advancedcb.com`'s A record at the server IP first — Caddy provisions
HTTPS automatically. Data (SQLite + uploads) lives in the `app-data` Docker volume.

**Security checklist:**
- `ufw default deny incoming && ufw allow 22,80,443/tcp && ufw enable`
- SSH keys only (`PasswordAuthentication no` in `/etc/ssh/sshd_config`)
- Strong `ADMIN_KEY` (`openssl rand -hex 24`) — the default is a placeholder
- Keep `.env` out of git (already ignored); rotate any API key that has ever been shared
- Enable unattended upgrades: `apt install unattended-upgrades`
- Back up the data volume nightly, e.g.
  `docker run --rm -v acb-onboarding_app-data:/data -v ~/backups:/out alpine tar czf /out/acb-$(date +%F).tgz /data`
  and sync `~/backups` offsite (rclone → Backblaze B2 is ~free).

**Zero-ops alternative:** Railway or Render (~$5–7/mo with a persistent disk mounted at
`DATA_DIR`) — no server to maintain, slightly higher cost.

## Running locally

```bash
npm install
npm start          # http://localhost:3000
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | SQLite DB + uploads location |
| `BASE_URL` | — | Public URL; required for DocuSeal signing redirects |
| `ADMIN_KEY` | `acb-admin-2026` | Key for `/admin` — **change in production** |
| `DOCUSEAL_API_KEY` | — | Enables DocuSeal signing |
| `DOCUSEAL_API_URL` | `https://api.docuseal.com` | Use `https://api.docuseal.eu` for EU cloud, or your self-hosted instance |
| `DOCUSEAL_SIGN_URL` | `https://docuseal.com/s` | Base for signing links |
| `DOCUSEAL_WEBHOOK_KEY` | — | If set, `/api/docuseal/webhook` requires `?key=` to match |
| `ACB_SIGNER_EMAIL` | — | Adds an ACB countersign role to each document |
| `SMTP_HOST` | — | SMTP server; setting it turns on real email (notifications, client copies, reminders) |
| `SMTP_PORT` | `587` | `465` switches to implicit TLS |
| `SMTP_USER` / `SMTP_PASS` | — | SMTP credentials |
| `MAIL_FROM` | `"Advanced Collection Bureau" <SMTP_USER>` | From header |
| `MAIL_DEBUG` | — | `true` (with no SMTP_HOST) logs emails instead of sending — for local testing |
| `FORMSUBMIT_ID` | (acb-form's ID) | FormSubmit fallback for completion notices when SMTP isn't configured |
| `NOTIFY_ENABLED` | `true` | Set `false` to disable all outbound notifications |
| `SERVICE_KEY` | — | Shared secret that lets the Lead Console create pre-filled onboardings |
| `LEAD_CONSOLE_WEBHOOK_URL` | — | Where onboarding milestones are POSTed |
| `LEAD_CONSOLE_WEBHOOK_KEY` | — | Secret sent with those webhooks |

## Email management

Everything is controlled from **/admin → Email settings** (stored in the DB, no restart needed):

- **Notifications to ACB** — which addresses get emailed when an onboarding is fully
  signed, and optionally on every partial signature. Attach the signed-agreements PDF
  and/or the client's uploaded documents (capped at 15 MB).
- **Client copies** — when everything is signed, the client automatically gets a branded
  email with their signed PDFs attached and what-happens-next steps.
- **Welcome email** — the moment someone starts an onboarding, they get their private
  portal link by email (button + copyable link), so it's never lost and easy to forward.
- **Automatic reminders** — incomplete onboardings that go quiet get a friendly checklist
  email (green checks for what's done, amber for what's left) with their portal link.
  Configurable: first nudge after N idle days, repeat every M days, stop after K total.
  Per-client "send reminder now" and mute controls live on each onboarding row in /admin.

Emails require SMTP (see env vars above) — any provider works: Google Workspace
(app password), Microsoft 365, or a transactional service like Resend/Postmark/SES
(their SMTP endpoints). Without SMTP, completion notices fall back to FormSubmit and
reminders stay off. Use the **Send test email** button in /admin to verify the setup.

## Lead Console integration (advancedcb.app)

**Inbound — create an onboarding from a won lead:**

```
POST /api/service/onboardings
X-Service-Key: <SERVICE_KEY>          (or Authorization: Bearer <SERVICE_KEY>)
{ "company_name": "...", "contact_name": "...", "contact_email": "...",
  "contact_phone": "...", "mgmt_type": "third_party" | "owner_operator" }

-> { "token": "...", "url": "https://onboarding.advancedcb.com/o/...", "welcome_email_sent": true }
```

Only `company_name` is required. The client gets the same welcome email as a self-serve
signup (unless that's switched off in admin), so the Lead Console can hand a lead straight
to onboarding without anyone copying details by hand.

**Outbound — milestone webhooks** POSTed to `LEAD_CONSOLE_WEBHOOK_URL` with
`X-Webhook-Key` and `Authorization: Bearer` headers set to `LEAD_CONSOLE_WEBHOOK_KEY`:

| Event | Fires when |
|---|---|
| `onboarding.created` | An onboarding starts (self-serve or via the service API) |
| `onboarding.completed` | The client has signed every agreement |
| `onboarding.countersigned` | The owner has countersigned — fully executed |

Each event fires exactly once per onboarding. The payload carries the token, portal URL,
company/contact fields, per-entity signing status, and progress counts. Webhooks are
fire-and-forget: a slow or unreachable Lead Console is logged and never blocks or fails
a client action.

## Pages

- `/` — landing page; client enters company + contact info and gets their portal link
- `/o/<token>` — the client portal (the shareable link)
- `/admin` — ACB staff view: every onboarding, status, signed PDFs, uploaded files

## How agreements work

Each entity's agreement is generated server-side (`lib/agreement-pdf.js`) from the
standard ACB Agreement for Collection Services: contingent 40%, net-monthly remit,
terms 1–8. The PDF fills in the entity's legal name and address, contact info,
third-party/owner-operator checkbox, the "Remit to Address above?" checkbox
(computed from the check details), an explicit "Make checks payable to / Mail checks to"
line so there is never ambiguity, and the signature + date. The Collector line is left
for ACB to countersign (automatic if `ACB_SIGNER_EMAIL` is set in DocuSeal mode).

Editing a signed entity's legal name or address voids its signature (and archives the
DocuSeal submission) so nothing signed can silently drift. When every agreement is
signed, ACB gets an email via FormSubmit with the full summary and a portal link.

## Notes

- Frontend is a single file (`public/index.html`), React 18 via pinned CDN + in-browser
  Babel — same approach and visual style as [acb-form](https://github.com/NoahAlbers/acb-form).
- API is plain Express + better-sqlite3 (`server.js`, `db.js`). Uploads capped at 25 MB
  (PDF, Word, images).
- Anyone with a portal link can view/edit/sign that onboarding — that's the intended
  trust model (links are unguessable 72-bit tokens). Don't post links publicly.
