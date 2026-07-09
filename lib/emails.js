// Branded HTML emails. Everything is inline-styled and table-based so it renders
// correctly in Outlook/Gmail/Apple Mail. Colors match the portal (public/index.html).

const C = {
  blue: '#3D5AF1', blueLight: '#EEF1FE', bg: '#F4F5F9', text: '#1A1A2E',
  mid: '#4A4A68', light: '#8889A0', border: '#E2E4EC', green: '#16a34a',
  greenBg: '#EBFAF1', warn: '#B47A18', warnBg: '#FEF9EE',
};

const HELP_PHONE = '(321) 379-6063';
const HELP_EMAIL = 'nalbers@advancedcb.com';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';

function layout({ preheader, body }) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;">${esc(preheader || '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:28px 12px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
  <tr><td style="background:${C.blue};border-radius:14px 14px 0 0;padding:20px 30px;font-family:Arial,Helvetica,sans-serif;">
    <span style="display:inline-block;background:#ffffff;color:${C.blue};font-weight:bold;font-size:14px;border-radius:8px;padding:6px 9px;vertical-align:middle;">ACB</span>
    <span style="color:#ffffff;font-size:16px;font-weight:bold;vertical-align:middle;padding-left:10px;">Advanced Collection Bureau</span>
  </td></tr>
  <tr><td style="background:#ffffff;border:1px solid ${C.border};border-top:none;border-radius:0 0 14px 14px;padding:30px;font-family:Arial,Helvetica,sans-serif;color:${C.text};font-size:15px;line-height:1.6;">
    ${body}
  </td></tr>
  <tr><td style="padding:18px 10px;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C.light};line-height:1.7;">
    Questions? Call or text ${esc(HELP_PHONE)} or email <a href="mailto:${HELP_EMAIL}" style="color:${C.blue};">${HELP_EMAIL}</a><br/>
    Advanced Collection Bureau, Inc. · Advancedcb.com · PO Box 560063 Rockledge, FL 32956
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

const button = (href, label) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0;"><tr><td style="background:${C.blue};border-radius:50px;">
     <a href="${esc(href)}" style="display:inline-block;padding:13px 30px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;text-decoration:none;">${esc(label)}</a>
   </td></tr></table>`;

const checkRow = (ok, label) =>
  `<tr><td style="padding:5px 0;font-size:14px;color:${ok ? C.mid : C.text};">
     <span style="display:inline-block;width:20px;height:20px;line-height:20px;border-radius:50%;text-align:center;font-size:12px;font-weight:bold;vertical-align:middle;margin-right:9px;${ok ? `background:${C.green};color:#ffffff;` : `background:${C.warnBg};color:${C.warn};border:1px solid ${C.warn};line-height:18px;`}">${ok ? '&#10003;' : '&#9679;'}</span>
     ${esc(label)}${ok ? '' : ` <span style="color:${C.warn};font-weight:bold;">&larr; still needed</span>`}
   </td></tr>`;

// What's still missing on an onboarding — mirrors the portal's final-check list.
// Takes a *serialized* session (the object serializeSession returns).
function missingItems(s) {
  const p = s.progress;
  const entities = s.entities.filter((e) => e.legal_name);
  const items = [
    { ok: !!(s.company_name && s.contact_name && s.contact_email), label: 'Company & contact info' },
    { ok: !!s.mgmt_type, label: 'Third-party or owner operator selected' },
    { ok: entities.length > 0, label: entities.length ? `Legal entities added (${entities.length})` : 'Add your legal entities (one per lease entity)' },
  ];
  if (entities.length) items.push({ ok: entities.every((e) => e.address), label: 'Every entity has a property address' });
  items.push({ ok: s.checks_mode !== 'corporate' || !!(s.corporate_payable_to && s.corporate_check_address), label: 'Check payment details' });
  items.push({ ok: p.has_lease, label: 'Copy of your lease attached' });
  if (p.needs_management_agreement) items.push({ ok: p.has_management_agreement, label: 'Management agreement attached' });
  items.push({ ok: entities.length > 0 && p.signed === p.total, label: entities.length ? `Agreements signed (${p.signed} of ${p.total})` : 'Agreements signed' });
  return items;
}

function firstName(s) {
  return (s.contact_name || '').trim().split(/\s+/)[0] || 'there';
}

/* ---------- to the client: reminder ---------- */

function reminderEmail(s, portalUrl) {
  const items = missingItems(s);
  const left = items.filter((i) => !i.ok);
  const pct = Math.round((items.length - left.length) / items.length * 100);
  const subject = left.length === 1
    ? `Almost there — 1 step left on your ACB onboarding`
    : `Your ACB onboarding — ${left.length} steps left`;
  const body = `
    <p style="margin:0 0 14px;">Hi ${esc(firstName(s))},</p>
    <p style="margin:0 0 14px;">Just a friendly nudge — the collection services setup for
    <b>${esc(s.company_name || 'your company')}</b> is <b>${pct}% complete</b>. Here's where it stands:</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px 0;background:#FAFBFD;border:1px solid ${C.border};border-radius:10px;padding:8px 16px;width:100%;">
      ${items.map((i) => checkRow(i.ok, i.label)).join('')}
    </table>
    <p style="margin:0 0 4px;">Pick up right where you (or anyone on your team) left off — the link below is your company's private page, and it's fine to forward this email to whoever handles the next step:</p>
    ${button(portalUrl, 'Continue your onboarding →')}
    <p style="margin:0;color:${C.mid};font-size:13.5px;">Once everything is signed, we countersign, assign your client number${s.entities.length === 1 ? '' : 's'}, and you can start placing accounts.</p>`;
  return { subject, html: layout({ preheader: `${left.length} item(s) left to finish your collection services setup`, body }) };
}

/* ---------- to the client: signed copies ---------- */

function clientCopyEmail(s, portalUrl) {
  const n = s.entities.filter((e) => e.signed_at).length;
  const subject = `Your signed collection agreement${n === 1 ? '' : 's'} — Advanced Collection Bureau`;
  const body = `
    <p style="margin:0 0 14px;">Hi ${esc(firstName(s))},</p>
    <p style="margin:0 0 14px;">Thank you! All <b>${n} agreement${n === 1 ? '' : 's'}</b> for <b>${esc(s.company_name)}</b> ${n === 1 ? 'is' : 'are'} signed —
    your cop${n === 1 ? 'y is' : 'ies are'} attached to this email.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px 0;background:${C.greenBg};border:1px solid #BFE8CF;border-radius:10px;padding:14px 18px;width:100%;">
      <tr><td style="font-size:14px;color:${C.mid};line-height:1.7;">
        <b style="color:${C.text};">What happens next</b><br/>
        1. We countersign and send back fully executed copies.<br/>
        2. We assign your client number${n === 1 ? '' : 's'}.<br/>
        3. We reach out with everything you need to start placing accounts.
      </td></tr>
    </table>
    <p style="margin:0 0 4px;color:${C.mid};font-size:13.5px;">You can revisit your onboarding page anytime:</p>
    ${button(portalUrl, 'View your onboarding')}`;
  return { subject, html: layout({ preheader: 'Your signed agreements are attached', body }) };
}

/* ---------- to ACB: entity table used by both notifications ---------- */

function entityTable(s) {
  const rows = s.entities.map((e) => {
    const pay = e.resolved_payment || {};
    return `<tr>
      <td style="padding:7px 10px;border-bottom:1px solid ${C.border};font-size:13px;color:${C.text};"><b>${esc(e.legal_name)}</b>${e.property_name ? `<br/><span style="color:${C.light};">${esc(e.property_name)}</span>` : ''}</td>
      <td style="padding:7px 10px;border-bottom:1px solid ${C.border};font-size:13px;color:${C.mid};">${esc(pay.payableTo || e.legal_name)}<br/><span style="color:${C.light};">${esc(pay.address || e.address || '')}</span></td>
      <td style="padding:7px 10px;border-bottom:1px solid ${C.border};font-size:13px;white-space:nowrap;">${e.signed_at ? `<span style="color:${C.green};font-weight:bold;">Signed ${esc(fmtDate(e.signed_at))}</span><br/><span style="color:${C.light};">${esc(e.signer_name || '')}</span>` : `<span style="color:${C.warn};font-weight:bold;">Unsigned</span>`}</td>
    </tr>`;
  }).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:12px 0;border:1px solid ${C.border};border-radius:10px;">
    <tr>
      <th align="left" style="padding:8px 10px;font-size:11px;color:${C.light};text-transform:uppercase;letter-spacing:.4px;">Entity</th>
      <th align="left" style="padding:8px 10px;font-size:11px;color:${C.light};text-transform:uppercase;letter-spacing:.4px;">Checks payable / mail to</th>
      <th align="left" style="padding:8px 10px;font-size:11px;color:${C.light};text-transform:uppercase;letter-spacing:.4px;">Status</th>
    </tr>${rows}</table>`;
}

function acbSummaryFooter(s, portalUrl) {
  const files = s.files.map((f) => `${f.kind === 'management_agreement' ? 'Management agreement' : f.kind === 'lease' ? 'Lease' : 'File'}: ${esc(f.original_name)}`).join('<br/>') || 'None uploaded';
  return `
    <p style="margin:14px 0 4px;font-size:13px;color:${C.mid};"><b style="color:${C.text};">Contact:</b> ${esc(s.contact_name)} · <a href="mailto:${esc(s.contact_email)}" style="color:${C.blue};">${esc(s.contact_email)}</a> · ${esc(s.contact_phone)}</p>
    <p style="margin:4px 0;font-size:13px;color:${C.mid};"><b style="color:${C.text};">Type:</b> ${s.mgmt_type === 'third_party' ? 'Third-Party Management' : s.mgmt_type === 'owner_operator' ? 'Owner Operator' : 'Not set'}</p>
    <p style="margin:4px 0 0;font-size:13px;color:${C.mid};"><b style="color:${C.text};">Documents:</b><br/>${files}</p>
    ${button(portalUrl, 'Open in portal')}`;
}

/* ---------- to ACB: everything signed ---------- */

function completionEmailAcb(s, portalUrl) {
  const n = s.entities.length;
  const subject = `✅ Onboarding complete: ${s.company_name || 'New client'} (${n} agreement${n === 1 ? '' : 's'})`;
  const body = `
    <p style="margin:0 0 6px;font-size:18px;font-weight:bold;color:${C.green};">All agreements signed 🎉</p>
    <p style="margin:0 0 10px;"><b>${esc(s.company_name)}</b> finished onboarding — ${n} collection agreement${n === 1 ? '' : 's'} signed. Next: countersign and assign client number${n === 1 ? '' : 's'}.</p>
    ${entityTable(s)}
    ${acbSummaryFooter(s, portalUrl)}`;
  return { subject, html: layout({ preheader: `${s.company_name} signed ${n} agreement(s)`, body }) };
}

/* ---------- to ACB: a signature came in (but not everything yet) ---------- */

function signatureEmailAcb(s, signedNow, portalUrl) {
  const p = s.progress;
  const names = signedNow.map((e) => e.legal_name).join(', ');
  const subject = `✍ ${s.company_name || 'A client'} signed ${signedNow.length} agreement${signedNow.length === 1 ? '' : 's'} (${p.signed}/${p.total})`;
  const body = `
    <p style="margin:0 0 10px;"><b>${esc(s.company_name)}</b> just signed: <b>${esc(names)}</b>.</p>
    <p style="margin:0 0 10px;color:${C.mid};">${p.signed} of ${p.total} agreements are now signed${p.signed === p.total ? '' : ' — the rest are still pending'}.</p>
    ${entityTable(s)}
    ${acbSummaryFooter(s, portalUrl)}`;
  return { subject, html: layout({ preheader: `${p.signed}/${p.total} agreements signed`, body }) };
}

/* ---------- test email ---------- */

function testEmail() {
  const body = `
    <p style="margin:0 0 10px;font-size:17px;font-weight:bold;">Email is working 🎉</p>
    <p style="margin:0;color:${C.mid};">This is a test from the ACB onboarding portal's admin panel. Notifications, client copies, and reminder emails will look like this.</p>`;
  return { subject: 'Test email — ACB onboarding portal', html: layout({ preheader: 'SMTP is configured correctly', body }) };
}

// Realistic fake onboarding used for the admin's "see what it looks like" previews.
function sampleSession({ complete = false } = {}) {
  const signed = { signed_at: '2026-07-09T12:00:00Z', signer_name: 'Jane Smith', signer_title: 'Regional Manager' };
  return {
    token: 'sample',
    company_name: 'Sunrise Property Management LLC',
    contact_name: 'Jane Smith',
    contact_email: 'jane@sunrisepm.com',
    contact_phone: '(321) 555-0100',
    mgmt_type: 'third_party',
    checks_mode: 'per_entity',
    corporate_payable_to: '',
    corporate_check_address: '',
    entities: [
      { id: 1, legal_name: 'Building 1 LLC', property_name: 'Sunrise Towers', address: '100 Main St, Melbourne, FL 32901',
        resolved_payment: { payableTo: 'Building 1 LLC', address: '100 Main St, Melbourne, FL 32901' }, ...signed },
      { id: 2, legal_name: 'Building 2 LLC', property_name: 'Palm Court', address: '200 Ocean Ave, Cocoa Beach, FL 32931',
        resolved_payment: { payableTo: 'Sunrise Corporate Holdings LLC', address: 'PO Box 999, Orlando, FL 32801' },
        ...(complete ? signed : { signed_at: null, signer_name: null }) },
    ],
    files: [{ id: 1, kind: 'lease', original_name: 'standard-lease.pdf', size: 240000 }],
    progress: { signed: complete ? 2 : 1, total: 2, has_lease: true, has_management_agreement: complete, needs_management_agreement: true },
  };
}

// The admin's preview picker: any template, filled with the sample onboarding.
function previewEmail(template, portalUrl) {
  let msg;
  if (template === 'reminder') msg = reminderEmail(sampleSession(), portalUrl);
  else if (template === 'completion') msg = completionEmailAcb(sampleSession({ complete: true }), portalUrl);
  else if (template === 'signature') {
    const s = sampleSession();
    msg = signatureEmailAcb(s, s.entities.filter((e) => e.signed_at), portalUrl);
  } else if (template === 'client_copy') msg = clientCopyEmail(sampleSession({ complete: true }), portalUrl);
  else return testEmail();
  return { ...msg, subject: `[Sample] ${msg.subject}` };
}

module.exports = { missingItems, reminderEmail, clientCopyEmail, completionEmailAcb, signatureEmailAcb, testEmail, sampleSession, previewEmail };
