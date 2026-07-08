const { buildAgreementPdf } = require('./agreement-pdf');

// DocuSeal e-sign integration. Enabled when DOCUSEAL_API_KEY is set; otherwise the
// portal falls back to its built-in draw/type signature.
//
// For each entity we upload the pre-filled agreement PDF as a one-off DocuSeal
// template (signature + date fields placed on the signature lines via the anchors
// the PDF generator reports), then create a submission for the signer. This keeps
// every agreement fully pre-filled from portal data — no template field mapping.

const API = (process.env.DOCUSEAL_API_URL || 'https://api.docuseal.com').replace(/\/+$/, '');
const SIGN_BASE = (process.env.DOCUSEAL_SIGN_URL || 'https://docuseal.com/s').replace(/\/+$/, '');
const KEY = process.env.DOCUSEAL_API_KEY || '';
// Optional: set to an ACB email to add a Collector countersign step on each document.
const ACB_SIGNER_EMAIL = process.env.ACB_SIGNER_EMAIL || '';

const enabled = () => !!KEY;
const signUrl = (slug) => (slug ? `${SIGN_BASE}/${slug}` : null);

async function ds(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'X-Auth-Token': KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.error || data.message || JSON.stringify(data).slice(0, 200);
    throw new Error(`DocuSeal ${method} ${path} failed (${res.status}): ${detail}`);
  }
  return data;
}

async function createEntitySubmission(session, entity, signer, completedRedirectUrl) {
  // Unsigned PDF with the signer's printed name on the (Creditor) line.
  const { bytes, anchors } = await buildAgreementPdf(session, {
    ...entity,
    signature: null,
    signed_at: null,
    signer_name: signer.name,
    signer_title: signer.title,
  });

  const fields = [
    { name: 'Signature', type: 'signature', role: 'Client', required: true, areas: [anchors.clientSignature] },
    { name: 'Date', type: 'date', role: 'Client', required: true, areas: [anchors.clientDate] },
  ];
  if (ACB_SIGNER_EMAIL) {
    fields.push(
      { name: 'ACB Signature', type: 'signature', role: 'ACB', required: true, areas: [anchors.collectorSignature] },
      { name: 'ACB Date', type: 'date', role: 'ACB', required: true, areas: [anchors.collectorDate] }
    );
  }

  const template = await ds('/templates/pdf', {
    method: 'POST',
    body: {
      name: `Collection Agreement — ${entity.legal_name} (${session.company_name || 'client'})`,
      folder_name: 'Client Onboarding',
      external_id: `acb-onboarding-entity-${entity.id}`,
      documents: [{ name: 'Agreement for Collection Services', file: Buffer.from(bytes).toString('base64'), fields }],
    },
  });

  const submitters = [{
    role: 'Client',
    name: signer.name,
    email: signer.email,
    external_id: `entity-${entity.id}`,
    completed_redirect_url: completedRedirectUrl,
  }];
  if (ACB_SIGNER_EMAIL) submitters.push({ role: 'ACB', email: ACB_SIGNER_EMAIL });

  const created = await ds('/submissions', {
    method: 'POST',
    body: { template_id: template.id, send_email: false, order: 'preserved', submitters },
  });

  // POST /submissions returns the created submitters.
  const list = Array.isArray(created) ? created : created.submitters || [];
  const client = list.find((s) => s.role === 'Client') || list[0] || {};
  return { submission_id: client.submission_id || created.id, slug: client.slug };
}

// Returns {completed, completed_at, signer_name, document_url} for the client signer.
async function getSubmissionStatus(submissionId) {
  const sub = await ds(`/submissions/${submissionId}`);
  const client = (sub.submitters || []).find((s) => s.role === 'Client') || (sub.submitters || [])[0] || {};
  const docs = sub.documents || client.documents || [];
  return {
    completed: !!client.completed_at,
    completed_at: client.completed_at || null,
    signer_name: client.name || null,
    document_url: docs.length ? docs[0].url : null,
    audit_log_url: sub.audit_log_url || null,
  };
}

// Cheap connectivity/auth probe for the admin diagnostic endpoint.
async function checkConnection() {
  const r = await ds('/templates?limit=1');
  const count = Array.isArray(r) ? r.length : (r.data || []).length;
  return `DocuSeal API reachable at ${API} (auth OK, ${count ? 'templates visible' : 'no templates yet'})`;
}

async function archiveSubmission(submissionId) {
  try { await ds(`/submissions/${submissionId}`, { method: 'DELETE' }); }
  catch (e) { console.error('DocuSeal archive failed:', e.message); }
}

module.exports = { enabled, signUrl, createEntitySubmission, getSubmissionStatus, archiveSubmission, checkConnection };
