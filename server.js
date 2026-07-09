const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, UPLOAD_DIR, DATA_DIR } = require('./db');
const { buildAgreementPdf, buildAllAgreementsPdf, resolvePayment } = require('./lib/agreement-pdf');
const docuseal = require('./lib/docuseal');
const mailer = require('./lib/mailer');
const emails = require('./lib/emails');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '!GreatCollectors123?';
// FormSubmit endpoint used by the existing acb-form intake page; override via env.
const FORMSUBMIT_ID = process.env.FORMSUBMIT_ID || 'dfeca48013a9d6519627f295dd99503c';
const NOTIFY_ENABLED = process.env.NOTIFY_ENABLED !== 'false';

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '3mb' }));

const now = () => new Date().toISOString();
const newToken = () => crypto.randomBytes(9).toString('base64url');

const ALLOWED_UPLOAD_EXT = new Set(['.pdf', '.doc', '.docx', '.png', '.jpg', '.jpeg', '.heic', '.webp']);
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_UPLOAD_EXT.has(ext)) cb(null, true);
    else cb(new Error('Unsupported file type. Please upload a PDF, Word document, or image.'));
  },
});

/* ---------- settings ---------- */

const SETTINGS_DEFAULTS = {
  notify_emails: '',               // who at ACB hears about signatures/completions (comma-separated)
  notify_on_completion: true,      // email when every agreement on an onboarding is signed
  notify_on_signature: false,      // email on each partial signature too
  attach_signed_agreements: true,  // attach the combined signed-agreements PDF to ACB notifications
  attach_uploaded_docs: false,     // also attach the client's lease / management agreement
  send_client_copy: true,          // email the client their signed copies on completion
  send_welcome_email: true,        // email new clients their portal link when they start
  reminders_enabled: true,
  reminder_after_days: 3,          // idle days before the first nudge
  reminder_every_days: 4,          // days between nudges
  reminder_max: 3,                 // stop after this many
};

function getSettings() {
  const stored = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    try { stored[row.key] = JSON.parse(row.value); } catch (e) { /* skip corrupt value */ }
  }
  return { ...SETTINGS_DEFAULTS, ...stored };
}

function saveSettings(patch) {
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in SETTINGS_DEFAULTS)) continue;
    const kind = typeof SETTINGS_DEFAULTS[key];
    const cast = kind === 'boolean' ? !!value : kind === 'number' ? Math.max(0, Number(value) || 0) : String(value ?? '').trim();
    up.run(key, JSON.stringify(cast));
  }
  return getSettings();
}

/* ---------- helpers ---------- */

function getSession(token) {
  return db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
}

function serializeSession(session) {
  const entities = db.prepare('SELECT * FROM entities WHERE session_id = ? ORDER BY id').all(session.id);
  const files = db
    .prepare('SELECT id, kind, original_name, size, mime, uploaded_at FROM files WHERE session_id = ? ORDER BY id')
    .all(session.id);
  const signedCount = entities.filter((e) => e.signed_at).length;
  const needsMgmtAgreement = session.mgmt_type === 'third_party';
  const hasLease = files.some((f) => f.kind === 'lease');
  const hasMgmt = files.some((f) => f.kind === 'management_agreement');
  return {
    token: session.token,
    signing_mode: docuseal.enabled() ? 'docuseal' : 'builtin',
    company_name: session.company_name,
    contact_name: session.contact_name,
    contact_email: session.contact_email,
    contact_phone: session.contact_phone,
    contact_fax: session.contact_fax,
    contact_title: session.contact_title,
    mgmt_type: session.mgmt_type,
    checks_mode: session.checks_mode,
    corporate_payable_to: session.corporate_payable_to,
    corporate_check_address: session.corporate_check_address,
    completed_at: session.completed_at,
    created_at: session.created_at,
    updated_at: session.updated_at,
    reminder_count: session.reminder_count || 0,
    last_reminder_at: session.last_reminder_at,
    reminders_muted: !!session.reminders_muted,
    entities: entities.map((e) => ({
      id: e.id,
      legal_name: e.legal_name,
      property_name: e.property_name,
      address: e.address,
      payable_to: e.payable_to,
      check_address: e.check_address,
      contact_name: e.contact_name,
      contact_email: e.contact_email,
      contact_phone: e.contact_phone,
      contact_title: e.contact_title,
      signer_name: e.signer_name,
      signer_title: e.signer_title,
      signed_at: e.signed_at,
      sign_url: e.signed_at ? null : docuseal.signUrl(e.docuseal_slug),
      docuseal_pending: !!(e.docuseal_submission_id && !e.signed_at),
      signed_doc_url: e.signed_doc_url,
      resolved_payment: resolvePayment(session, e),
    })),
    files,
    progress: {
      signed: signedCount,
      total: entities.length,
      has_lease: hasLease,
      has_management_agreement: hasMgmt,
      needs_management_agreement: needsMgmtAgreement,
    },
  };
}

function touch(sessionId) {
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now(), sessionId);
}

const SESSION_FIELDS = [
  'company_name', 'contact_name', 'contact_email', 'contact_phone', 'contact_fax', 'contact_title',
  'mgmt_type', 'checks_mode', 'corporate_payable_to', 'corporate_check_address',
];
const ENTITY_FIELDS = ['legal_name', 'property_name', 'address', 'payable_to', 'check_address', 'contact_name', 'contact_email', 'contact_phone', 'contact_title'];

function requireSession(req, res, next) {
  const session = getSession(req.params.token);
  if (!session) return res.status(404).json({ error: 'This onboarding link was not found. Double-check the URL or ask ACB for a new one.' });
  req.session = session;
  next();
}

const portalUrlFor = (session) => `${process.env.BASE_URL || ''}/o/${session.token}`;

// Attachments for ACB notification emails, per the admin's settings.
// Total is capped so the email doesn't bounce at the mail server.
async function buildNotifyAttachments(sessionRow, settings) {
  const attachments = [];
  const entities = db.prepare("SELECT * FROM entities WHERE session_id = ? AND legal_name != '' ORDER BY id").all(sessionRow.id);
  if (settings.attach_signed_agreements && entities.length) {
    const bytes = await buildAllAgreementsPdf(sessionRow, entities);
    const safe = (sessionRow.company_name || 'client').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    attachments.push({ filename: `collection-agreements-${safe}.pdf`, content: Buffer.from(bytes) });
  }
  if (settings.attach_uploaded_docs) {
    let budget = 15 * 1024 * 1024;
    for (const f of db.prepare('SELECT * FROM files WHERE session_id = ? ORDER BY id').all(sessionRow.id)) {
      if (f.size > budget) continue;
      budget -= f.size;
      attachments.push({ filename: f.original_name, path: path.join(UPLOAD_DIR, f.stored_name) });
    }
  }
  return attachments;
}

// Legacy path: with no SMTP configured, completions still reach ACB via FormSubmit
// (the same endpoint acb-form uses).
async function formsubmitFallback(fresh, entities, files) {
  const summary = entities
    .map((e) => {
      const pay = resolvePayment(fresh, e);
      return `- ${e.legal_name} (${e.property_name || 'no property name'}) — signed by ${e.signer_name} on ${e.signed_at}\n  Checks payable to: ${pay.payableTo} | Mail to: ${pay.address || e.address}`;
    })
    .join('\n');
  const body = {
    _subject: `Onboarding complete: ${fresh.company_name} (${entities.length} agreement${entities.length === 1 ? '' : 's'})`,
    company: fresh.company_name,
    contact: `${fresh.contact_name} <${fresh.contact_email}> ${fresh.contact_phone}`,
    type: fresh.mgmt_type === 'third_party' ? 'Third-Party Management' : 'Owner Operator',
    agreements: summary,
    documents: files.map((f) => `${f.kind}: ${f.original_name}`).join(', ') || 'none uploaded',
    portal_link: portalUrlFor(fresh),
    _template: 'box',
  };
  await fetch(`https://formsubmit.co/ajax/${FORMSUBMIT_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
}

async function maybeNotifyCompleted(session) {
  const fresh = getSession(session.token);
  const entities = db.prepare('SELECT * FROM entities WHERE session_id = ?').all(fresh.id);
  const allSigned = entities.length > 0 && entities.every((e) => e.signed_at);
  if (!allSigned) return;
  if (!fresh.completed_at) {
    db.prepare('UPDATE sessions SET completed_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), fresh.id);
  }
  if (fresh.notified_at || !NOTIFY_ENABLED) return;
  db.prepare('UPDATE sessions SET notified_at = ? WHERE id = ?').run(now(), fresh.id);

  const settings = getSettings();
  const data = serializeSession(getSession(session.token));
  const portalUrl = portalUrlFor(fresh);
  const files = db.prepare('SELECT * FROM files WHERE session_id = ?').all(fresh.id);

  // Tell ACB.
  if (settings.notify_on_completion) {
    if (mailer.enabled() && settings.notify_emails.trim()) {
      try {
        const msg = emails.completionEmailAcb(data, portalUrl);
        await mailer.send({ to: settings.notify_emails, ...msg, attachments: await buildNotifyAttachments(fresh, settings) });
      } catch (e) {
        console.error('Completion email failed:', e.message);
      }
    } else {
      try { await formsubmitFallback(fresh, entities, files); }
      catch (e) { console.error('Completion notification failed:', e.message); }
    }
  }

  // Send the client their signed copies.
  if (settings.send_client_copy && mailer.enabled() && fresh.contact_email) {
    try {
      const signed = entities.filter((e) => e.legal_name);
      const bytes = await buildAllAgreementsPdf(fresh, signed);
      const msg = emails.clientCopyEmail(data, portalUrl);
      await mailer.send({
        to: fresh.contact_email,
        ...msg,
        attachments: [{ filename: 'signed-collection-agreements.pdf', content: Buffer.from(bytes) }],
      });
    } catch (e) {
      console.error('Client copy email failed:', e.message);
    }
  }
}

// A signature came in but the onboarding isn't finished — optional heads-up to ACB.
async function notifySignatures(session, signedIds) {
  if (!signedIds.length || !NOTIFY_ENABLED) return;
  const settings = getSettings();
  if (!settings.notify_on_signature || !mailer.enabled() || !settings.notify_emails.trim()) return;
  const data = serializeSession(getSession(session.token));
  if (data.progress.total > 0 && data.progress.signed === data.progress.total) return; // completion email covers this
  const signedNow = data.entities.filter((e) => signedIds.includes(e.id) && e.signed_at);
  if (!signedNow.length) return;
  try {
    const msg = emails.signatureEmailAcb(data, signedNow, portalUrlFor(session));
    await mailer.send({ to: settings.notify_emails, ...msg });
  } catch (e) {
    console.error('Signature notification failed:', e.message);
  }
}

/* ---------- reminder emails ---------- */

async function sendReminder(sessionRow) {
  const data = serializeSession(sessionRow);
  const msg = emails.reminderEmail(data, portalUrlFor(sessionRow));
  await mailer.send({ to: sessionRow.contact_email, ...msg });
  db.prepare('UPDATE sessions SET reminder_count = reminder_count + 1, last_reminder_at = ? WHERE id = ?').run(now(), sessionRow.id);
}

// Hourly: nudge incomplete onboardings that have gone quiet. First nudge after
// reminder_after_days idle, then every reminder_every_days, stopping at reminder_max.
async function runReminderSweep() {
  const settings = getSettings();
  if (!settings.reminders_enabled || !mailer.enabled()) return;
  const idleBefore = Date.now() - settings.reminder_after_days * 86400000;
  const repeatBefore = Date.now() - settings.reminder_every_days * 86400000;
  const candidates = db.prepare(
    "SELECT * FROM sessions WHERE completed_at IS NULL AND reminders_muted = 0 AND contact_email != '' AND reminder_count < ?"
  ).all(settings.reminder_max);
  for (const s of candidates) {
    if (new Date(s.updated_at).getTime() > idleBefore) continue;
    if (s.last_reminder_at && new Date(s.last_reminder_at).getTime() > repeatBefore) continue;
    try { await sendReminder(s); }
    catch (e) { console.error(`Reminder failed for ${s.token}:`, e.message); }
  }
}

setInterval(() => runReminderSweep().catch((e) => console.error('Reminder sweep failed:', e.message)), 60 * 60 * 1000);
setTimeout(() => runReminderSweep().catch((e) => console.error('Reminder sweep failed:', e.message)), 30 * 1000);

/* ---------- session API ---------- */

app.post('/api/sessions', (req, res) => {
  const token = newToken();
  const b = req.body || {};
  db.prepare(
    `INSERT INTO sessions (token, company_name, contact_name, contact_email, contact_phone, mgmt_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(token, String(b.company_name || '').trim(), String(b.contact_name || '').trim(),
        String(b.contact_email || '').trim(), String(b.contact_phone || '').trim(),
        String(b.mgmt_type || ''), now(), now());
  const session = getSession(token);
  // Fire-and-forget: the client shouldn't wait on SMTP to reach their portal.
  const email = String(b.contact_email || '').trim();
  if (email && NOTIFY_ENABLED && mailer.enabled() && getSettings().send_welcome_email) {
    const url = `${process.env.BASE_URL || `${req.protocol}://${req.get('host')}`}/o/${token}`;
    mailer.send({ to: email, ...emails.welcomeEmail(serializeSession(session), url) })
      .catch((e) => console.error('Welcome email failed:', e.message));
  }
  res.json(serializeSession(session));
});

app.get('/api/sessions/:token', requireSession, (req, res) => {
  res.json(serializeSession(req.session));
});

app.patch('/api/sessions/:token', requireSession, (req, res) => {
  const updates = [];
  const values = [];
  for (const field of SESSION_FIELDS) {
    if (field in req.body) {
      updates.push(`${field} = ?`);
      values.push(String(req.body[field] ?? '').trim());
    }
  }
  if (updates.length) {
    values.push(now(), req.session.id);
    db.prepare(`UPDATE sessions SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`).run(...values);
  }
  res.json(serializeSession(getSession(req.params.token)));
});

/* ---------- entities ---------- */

app.post('/api/sessions/:token/entities', requireSession, (req, res) => {
  const list = Array.isArray(req.body.entities) ? req.body.entities : [req.body];
  const insert = db.prepare(
    `INSERT INTO entities (session_id, legal_name, property_name, address, payable_to, check_address, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const added = [];
  for (const e of list.slice(0, 200)) {
    const legal = String(e.legal_name || '').trim();
    if (!legal) continue;
    const info = insert.run(req.session.id, legal, String(e.property_name || '').trim(),
      String(e.address || '').trim(), String(e.payable_to || '').trim(), String(e.check_address || '').trim(), now());
    added.push(info.lastInsertRowid);
  }
  touch(req.session.id);
  res.json(serializeSession(getSession(req.params.token)));
});

app.patch('/api/sessions/:token/entities/:id', requireSession, (req, res) => {
  const entity = db.prepare('SELECT * FROM entities WHERE id = ? AND session_id = ?').get(req.params.id, req.session.id);
  if (!entity) return res.status(404).json({ error: 'Entity not found' });
  const updates = [];
  const values = [];
  for (const field of ENTITY_FIELDS) {
    if (field in req.body) {
      updates.push(`${field} = ?`);
      values.push(String(req.body[field] ?? '').trim());
    }
  }
  if (updates.length) {
    // Changing what the agreement says voids an existing signature — it must be re-signed.
    const material = ['legal_name', 'address', 'contact_name', 'contact_email', 'contact_phone', 'contact_title'].some(
      (f) => f in req.body && String(req.body[f] ?? '').trim() !== entity[f]
    );
    if (material && (entity.signed_at || entity.docuseal_submission_id)) {
      updates.push("signer_name = NULL", "signer_title = NULL", "signature = NULL", "signed_at = NULL", "signed_ip = NULL",
                   "docuseal_submission_id = NULL", "docuseal_slug = NULL", "signed_doc_url = NULL");
      db.prepare('UPDATE sessions SET completed_at = NULL, notified_at = NULL WHERE id = ?').run(req.session.id);
      if (entity.docuseal_submission_id) docuseal.archiveSubmission(entity.docuseal_submission_id);
    }
    values.push(req.params.id, req.session.id);
    db.prepare(`UPDATE entities SET ${updates.join(', ')} WHERE id = ? AND session_id = ?`).run(...values);
    touch(req.session.id);
  }
  res.json(serializeSession(getSession(req.params.token)));
});

app.delete('/api/sessions/:token/entities/:id', requireSession, (req, res) => {
  db.prepare('DELETE FROM entities WHERE id = ? AND session_id = ?').run(req.params.id, req.session.id);
  touch(req.session.id);
  res.json(serializeSession(getSession(req.params.token)));
});

/* ---------- signing ---------- */

app.post('/api/sessions/:token/sign', requireSession, async (req, res) => {
  const { entity_ids, signer_name, signer_title, signature } = req.body || {};
  const name = String(signer_name || '').trim();
  if (!name) return res.status(400).json({ error: 'Please enter the full name of the person signing.' });
  if (typeof signature !== 'string' || !signature.startsWith('data:image/png;base64,') || signature.length > 500000) {
    return res.status(400).json({ error: 'Signature image is missing or invalid.' });
  }
  const ids = (Array.isArray(entity_ids) ? entity_ids : []).map(Number).filter(Number.isInteger);
  if (!ids.length) return res.status(400).json({ error: 'Select at least one agreement to sign.' });
  const update = db.prepare(
    `UPDATE entities SET signer_name = ?, signer_title = ?, signature = ?, signed_at = ?, signed_ip = ?
     WHERE id = ? AND session_id = ? AND legal_name != ''`
  );
  const stamp = now();
  const ip = req.ip || '';
  let signed = 0;
  for (const id of ids) {
    signed += update.run(name, String(signer_title || '').trim(), signature, stamp, ip, id, req.session.id).changes;
  }
  touch(req.session.id);
  await notifySignatures(req.session, ids);
  await maybeNotifyCompleted(req.session);
  res.json({ signed, ...serializeSession(getSession(req.params.token)) });
});

/* ---------- DocuSeal signing ---------- */

const baseUrl = (req) => process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

function markEntitySigned(sessionId, entityId, status) {
  db.prepare(
    `UPDATE entities SET signed_at = ?, signer_name = COALESCE(?, signer_name), signed_doc_url = ?
     WHERE id = ? AND session_id = ? AND signed_at IS NULL`
  ).run(status.completed_at || now(), status.signer_name, status.document_url, entityId, sessionId);
}

// Pull latest status from DocuSeal for every entity with an in-flight submission.
async function refreshDocusealStatuses(session) {
  if (!docuseal.enabled()) return;
  const pending = db
    .prepare('SELECT * FROM entities WHERE session_id = ? AND docuseal_submission_id IS NOT NULL AND signed_at IS NULL')
    .all(session.id);
  const newlySigned = [];
  for (const entity of pending) {
    try {
      const status = await docuseal.getSubmissionStatus(entity.docuseal_submission_id);
      if (status.completed) { markEntitySigned(session.id, entity.id, status); newlySigned.push(entity.id); }
    } catch (e) {
      console.error(`DocuSeal status refresh failed for entity ${entity.id}:`, e.message);
    }
  }
  if (pending.length) {
    touch(session.id);
    if (newlySigned.length) await notifySignatures(session, newlySigned);
    await maybeNotifyCompleted(session);
  }
}

// Create submissions for all (or selected) unsigned entities and hand back the first signing link.
app.post('/api/sessions/:token/docuseal/start', requireSession, async (req, res) => {
  if (!docuseal.enabled()) return res.status(400).json({ error: 'DocuSeal signing is not configured on this server.' });
  const { signer_name, signer_title, signer_email, entity_ids } = req.body || {};
  const signer = {
    name: String(signer_name || '').trim(),
    title: String(signer_title || '').trim(),
    email: String(signer_email || '').trim(),
  };
  if (!signer.name) return res.status(400).json({ error: 'Please enter the full name of the person signing.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(signer.email)) return res.status(400).json({ error: 'Please enter a valid email for the signer.' });

  const wanted = Array.isArray(entity_ids) && entity_ids.length ? entity_ids.map(Number) : null;
  const entities = db
    .prepare("SELECT * FROM entities WHERE session_id = ? AND legal_name != '' AND signed_at IS NULL ORDER BY id")
    .all(req.session.id)
    .filter((e) => !wanted || wanted.includes(e.id));
  if (!entities.length) return res.status(400).json({ error: 'There are no unsigned agreements to send for signature.' });

  const redirect = `${baseUrl(req)}/api/sessions/${req.session.token}/docuseal/next`;
  try {
    for (const entity of entities) {
      if (entity.docuseal_submission_id) continue; // already prepared — reuse the existing signing link
      const sub = await docuseal.createEntitySubmission(req.session, entity, signer, redirect);
      db.prepare(
        'UPDATE entities SET docuseal_submission_id = ?, docuseal_slug = ?, signer_name = ?, signer_title = ?, signer_email = ? WHERE id = ?'
      ).run(sub.submission_id, sub.slug, signer.name, signer.title, signer.email, entity.id);
    }
  } catch (e) {
    console.error('DocuSeal submission creation failed:', e.message);
    return res.status(502).json({ error: `E-sign service error: ${e.message}` });
  }
  touch(req.session.id);
  const first = db
    .prepare('SELECT docuseal_slug FROM entities WHERE session_id = ? AND signed_at IS NULL AND docuseal_slug IS NOT NULL ORDER BY id LIMIT 1')
    .get(req.session.id);
  res.json({ next_url: docuseal.signUrl(first && first.docuseal_slug), ...serializeSession(getSession(req.params.token)) });
});

// After each DocuSeal signature, chain straight into the next unsigned agreement.
app.get('/api/sessions/:token/docuseal/next', requireSession, async (req, res) => {
  await refreshDocusealStatuses(req.session);
  const next = db
    .prepare('SELECT docuseal_slug FROM entities WHERE session_id = ? AND signed_at IS NULL AND docuseal_slug IS NOT NULL ORDER BY id LIMIT 1')
    .get(req.session.id);
  if (next) return res.redirect(docuseal.signUrl(next.docuseal_slug));
  res.redirect(`/o/${req.session.token}?celebrate=1`);
});

app.post('/api/sessions/:token/docuseal/refresh', requireSession, async (req, res) => {
  await refreshDocusealStatuses(req.session);
  res.json(serializeSession(getSession(req.params.token)));
});

// Optional push notifications from DocuSeal (Settings → Webhooks). Polling covers us without it.
app.post('/api/docuseal/webhook', async (req, res) => {
  const secret = process.env.DOCUSEAL_WEBHOOK_KEY;
  if (secret && req.query.key !== secret) return res.status(401).end();
  try {
    const data = (req.body && req.body.data) || {};
    const submissionId = data.submission_id || data.id;
    const entity = submissionId
      ? db.prepare('SELECT * FROM entities WHERE docuseal_submission_id = ?').get(submissionId)
      : null;
    if (entity) {
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(entity.session_id);
      await refreshDocusealStatuses(session);
    }
  } catch (e) {
    console.error('DocuSeal webhook handling failed:', e.message);
  }
  res.json({ ok: true });
});

/* ---------- files ---------- */

app.post('/api/sessions/:token/files', requireSession, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received.' });
    const kind = ['lease', 'management_agreement', 'other'].includes(req.body.kind) ? req.body.kind : 'other';
    db.prepare(
      'INSERT INTO files (session_id, kind, original_name, stored_name, size, mime, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(req.session.id, kind, req.file.originalname, req.file.filename, req.file.size, req.file.mimetype, now());
    touch(req.session.id);
    res.json(serializeSession(getSession(req.params.token)));
  });
});

app.get('/api/sessions/:token/files/:id/download', requireSession, (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ? AND session_id = ?').get(req.params.id, req.session.id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  const full = path.join(UPLOAD_DIR, file.stored_name);
  if (req.query.inline) {
    res.setHeader('Content-Type', file.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${file.original_name.replace(/["\\]/g, '')}"`);
    return res.sendFile(full);
  }
  res.download(full, file.original_name);
});

app.delete('/api/sessions/:token/files/:id', requireSession, (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ? AND session_id = ?').get(req.params.id, req.session.id);
  if (file) {
    db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
    fs.promises.unlink(path.join(UPLOAD_DIR, file.stored_name)).catch(() => {});
    touch(req.session.id);
  }
  res.json(serializeSession(getSession(req.params.token)));
});

/* ---------- PDFs ---------- */

app.get('/api/sessions/:token/entities/:id/agreement.pdf', requireSession, async (req, res) => {
  const entity = db.prepare('SELECT * FROM entities WHERE id = ? AND session_id = ?').get(req.params.id, req.session.id);
  if (!entity) return res.status(404).json({ error: 'Entity not found' });
  // DocuSeal-signed agreements live on DocuSeal (with their audit trail) — link straight to them.
  if (entity.signed_doc_url) return res.redirect(entity.signed_doc_url);
  const { bytes } = await buildAgreementPdf(req.session, entity);
  const safe = (entity.legal_name || 'agreement').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="collection-agreement-${safe}.pdf"`);
  res.send(Buffer.from(bytes));
});

// A read-only look at the agreement they'll be signing — company info filled in,
// creditor lines blank — so clients can review or print-and-sign on paper.
app.get('/api/sessions/:token/agreement-preview.pdf', requireSession, async (req, res) => {
  const blank = { legal_name: '', property_name: '', address: '', payable_to: '', check_address: '' };
  const { bytes } = await buildAgreementPdf(req.session, blank);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="acb-collection-agreement.pdf"`);
  res.send(Buffer.from(bytes));
});

app.get('/api/sessions/:token/agreements.pdf', requireSession, async (req, res) => {
  const entities = db.prepare("SELECT * FROM entities WHERE session_id = ? AND legal_name != '' ORDER BY id").all(req.session.id);
  if (!entities.length) return res.status(404).json({ error: 'No entities added yet' });
  const bytes = await buildAllAgreementsPdf(req.session, entities);
  const safe = (req.session.company_name || 'acb').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="collection-agreements-${safe}.pdf"`);
  res.send(Buffer.from(bytes));
});

/* ---------- admin ---------- */

function requireAdmin(req, res, next) {
  const key = req.query.key || req.get('x-admin-key');
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Invalid admin key' });
  next();
}

app.get('/api/admin/sessions', requireAdmin, (req, res) => {
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 500').all();
  res.json(sessions.map(serializeSession));
});

// Storage overview: what the app is using, and how full the disk is.
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const walk = (dir) => {
    let sum = 0;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      try { sum += d.isDirectory() ? walk(p) : fs.statSync(p).size; } catch (e) { /* file vanished mid-walk */ }
    }
    return sum;
  };
  let uploadsBytes = 0;
  try { uploadsBytes = walk(UPLOAD_DIR); } catch (e) { /* no uploads yet */ }
  let dbBytes = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try { dbBytes += fs.statSync(path.join(DATA_DIR, 'onboarding.db' + suffix)).size; } catch (e) { /* absent */ }
  }
  let disk = null;
  try {
    const s = fs.statfsSync(DATA_DIR);
    disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch (e) { /* statfs unsupported */ }
  res.json({
    uploads_bytes: uploadsBytes,
    db_bytes: dbBytes,
    file_count: db.prepare('SELECT COUNT(*) AS c FROM files').get().c,
    session_count: db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c,
    disk,
  });
});

function deleteSessionRow(session) {
  const files = db.prepare('SELECT stored_name FROM files WHERE session_id = ?').all(session.id);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id); // entities/files cascade
  for (const f of files) fs.promises.unlink(path.join(UPLOAD_DIR, f.stored_name)).catch(() => {});
}

app.post('/api/admin/sessions/bulk-delete', requireAdmin, (req, res) => {
  const tokens = Array.isArray(req.body.tokens) ? req.body.tokens.slice(0, 500) : [];
  let deleted = 0;
  for (const t of tokens) {
    const session = getSession(String(t));
    if (session) { deleteSessionRow(session); deleted++; }
  }
  res.json({ deleted });
});

app.delete('/api/admin/sessions/:token', requireAdmin, (req, res) => {
  const session = getSession(req.params.token);
  if (!session) return res.status(404).json({ error: 'Onboarding not found' });
  deleteSessionRow(session);
  res.json({ ok: true });
});

/* ---- email management ---- */

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json({ settings: getSettings(), mail: mailer.status() });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  res.json({ settings: saveSettings(req.body), mail: mailer.status() });
});

// Send a test or a filled-in sample of any client/ACB template, so admins can
// see exactly what each email looks like in a real inbox.
app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  const to = String((req.body || {}).to || '').trim();
  const template = String((req.body || {}).template || 'test');
  if (!to) return res.status(400).json({ error: 'Enter an email address to send the test to.' });
  const check = await mailer.verify();
  if (!check.ok) return res.status(400).json({ error: check.error });
  try {
    const sampleUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    await mailer.send({ to, ...emails.previewEmail(template, sampleUrl) });
    res.json({ ok: true, message: check.message || `Sent to ${to}` });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/admin/sessions/:token/remind', requireAdmin, async (req, res) => {
  const session = getSession(req.params.token);
  if (!session) return res.status(404).json({ error: 'Onboarding not found' });
  if (session.completed_at) return res.status(400).json({ error: 'This onboarding is already complete — nothing to remind about.' });
  if (!session.contact_email) return res.status(400).json({ error: 'This onboarding has no contact email.' });
  try {
    await sendReminder(session);
    res.json(serializeSession(getSession(req.params.token)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/admin/sessions/:token/mute-reminders', requireAdmin, (req, res) => {
  const session = getSession(req.params.token);
  if (!session) return res.status(404).json({ error: 'Onboarding not found' });
  db.prepare('UPDATE sessions SET reminders_muted = ? WHERE id = ?').run(req.body && req.body.muted ? 1 : 0, session.id);
  res.json(serializeSession(getSession(req.params.token)));
});

// Visit /api/admin/docuseal-check?key=<ADMIN_KEY> to verify the DocuSeal API key/plan.
app.get('/api/admin/docuseal-check', requireAdmin, async (req, res) => {
  if (!docuseal.enabled()) return res.json({ ok: false, error: 'DOCUSEAL_API_KEY is not set — the portal is using built-in signing.' });
  try { res.json({ ok: true, message: await docuseal.checkConnection() }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

/* ---------- pages ---------- */

const INDEX = path.join(__dirname, 'public', 'index.html');
app.get(['/', '/o/:token', '/admin'], (req, res) => res.sendFile(INDEX));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`ACB onboarding portal running on http://localhost:${PORT}`);
});
