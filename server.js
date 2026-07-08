const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, UPLOAD_DIR } = require('./db');
const { buildAgreementPdf, buildAllAgreementsPdf, resolvePayment } = require('./lib/agreement-pdf');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'acb-admin-2026';
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
    company_name: session.company_name,
    contact_name: session.contact_name,
    contact_email: session.contact_email,
    contact_phone: session.contact_phone,
    contact_fax: session.contact_fax,
    mgmt_type: session.mgmt_type,
    checks_mode: session.checks_mode,
    corporate_payable_to: session.corporate_payable_to,
    corporate_check_address: session.corporate_check_address,
    completed_at: session.completed_at,
    created_at: session.created_at,
    updated_at: session.updated_at,
    entities: entities.map((e) => ({
      id: e.id,
      legal_name: e.legal_name,
      property_name: e.property_name,
      address: e.address,
      payable_to: e.payable_to,
      check_address: e.check_address,
      signer_name: e.signer_name,
      signer_title: e.signer_title,
      signed_at: e.signed_at,
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
  'company_name', 'contact_name', 'contact_email', 'contact_phone', 'contact_fax',
  'mgmt_type', 'checks_mode', 'corporate_payable_to', 'corporate_check_address',
];
const ENTITY_FIELDS = ['legal_name', 'property_name', 'address', 'payable_to', 'check_address'];

function requireSession(req, res, next) {
  const session = getSession(req.params.token);
  if (!session) return res.status(404).json({ error: 'This onboarding link was not found. Double-check the URL or ask ACB for a new one.' });
  req.session = session;
  next();
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
  const files = db.prepare('SELECT * FROM files WHERE session_id = ?').all(fresh.id);
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
    portal_link: `${process.env.BASE_URL || ''}/o/${fresh.token}`,
    _template: 'box',
  };
  try {
    await fetch(`https://formsubmit.co/ajax/${FORMSUBMIT_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error('Completion notification failed:', e.message);
  }
}

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
  res.json(serializeSession(getSession(token)));
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
    const material = ['legal_name', 'address'].some(
      (f) => f in req.body && String(req.body[f] ?? '').trim() !== entity[f]
    );
    if (entity.signed_at && material) {
      updates.push("signer_name = NULL", "signer_title = NULL", "signature = NULL", "signed_at = NULL", "signed_ip = NULL");
      db.prepare('UPDATE sessions SET completed_at = NULL, notified_at = NULL WHERE id = ?').run(req.session.id);
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
  await maybeNotifyCompleted(req.session);
  res.json({ signed, ...serializeSession(getSession(req.params.token)) });
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
  res.download(path.join(UPLOAD_DIR, file.stored_name), file.original_name);
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
  const bytes = await buildAgreementPdf(req.session, entity);
  const safe = (entity.legal_name || 'agreement').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="collection-agreement-${safe}.pdf"`);
  res.send(Buffer.from(bytes));
});

app.get('/api/sessions/:token/agreements.pdf', requireSession, async (req, res) => {
  const entities = db.prepare("SELECT * FROM entities WHERE session_id = ? AND legal_name != '' ORDER BY id").all(req.session.id);
  if (!entities.length) return res.status(404).json({ error: 'No entities added yet' });
  const bytes = await buildAllAgreementsPdf(req.session, entities);
  const safe = (req.session.company_name || 'acb').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="collection-agreements-${safe}.pdf"`);
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

/* ---------- pages ---------- */

const INDEX = path.join(__dirname, 'public', 'index.html');
app.get(['/', '/o/:token', '/admin'], (req, res) => res.sendFile(INDEX));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`ACB onboarding portal running on http://localhost:${PORT}`);
});
