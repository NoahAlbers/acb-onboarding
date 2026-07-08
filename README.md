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
| `FORMSUBMIT_ID` | (acb-form's ID) | FormSubmit endpoint for completion emails |
| `NOTIFY_ENABLED` | `true` | Set `false` to disable completion emails |

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
