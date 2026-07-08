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
4. **Sign everything at once** — draw or type a signature, and one authorized signer
   covers all agreements in a single click. Signing can also be split: uncheck
   agreements you're not authorized for and share the link with whoever is.

Everything autosaves, so the link can be freely delegated within their business
(accounting fills in check details, the office manager uploads the lease, an officer signs).

## Running it

```bash
npm install
npm start          # http://localhost:3000
```

Or with Docker: `docker build -t acb-onboarding . && docker run -p 3000:3000 -v acb-data:/data acb-onboarding`

Data (SQLite DB + uploaded files) lives in `./data` by default. Deploy anywhere that
gives you a persistent disk (Render, Railway, Fly.io, a VPS) and put the volume at `DATA_DIR`.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Where the SQLite DB and uploads are stored |
| `ADMIN_KEY` | `acb-admin-2026` | Key for the `/admin` dashboard — **change this in production** |
| `FORMSUBMIT_ID` | (acb-form's ID) | FormSubmit endpoint for completion emails |
| `NOTIFY_ENABLED` | `true` | Set `false` to disable completion emails |
| `BASE_URL` | — | Public URL, used in notification emails (e.g. `https://onboard.advancedcb.com`) |

## Pages

- `/` — landing page; client enters company + contact info and gets their portal link
- `/o/<token>` — the client portal (the shareable link)
- `/admin` — ACB staff view: every onboarding, its status, signed PDFs, and uploaded files

## How agreements work

Each entity's agreement is generated server-side (`lib/agreement-pdf.js`) from the
standard ACB Agreement for Collection Services: contingent 40%, net-monthly remit,
terms 1–8. The PDF fills in the entity's legal name and address, contact info,
third-party/owner-operator checkbox, the "Remit to Address above?" checkbox
(computed from the check details), an explicit "Make checks payable to / Mail checks to"
line so there is never ambiguity, and the client's signature + date. The Collector
signature line is left blank for ACB to countersign.

Editing a signed entity's legal name or address voids its signature and it must be
re-signed. When every agreement is signed, ACB gets an email via FormSubmit with the
full summary and a link to the portal.

## Notes

- Frontend is a single file (`public/index.html`), React 18 via pinned CDN + in-browser
  Babel — same approach and visual style as [acb-form](https://github.com/NoahAlbers/acb-form).
- API is plain Express + better-sqlite3 (`server.js`, `db.js`). Uploads capped at 25 MB
  (PDF, Word, images).
- Anyone with a portal link can view/edit/sign that onboarding — that's the intended
  trust model (links are unguessable 72-bit tokens). Don't post links publicly.
