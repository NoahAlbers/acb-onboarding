// Reports onboarding milestones back to the ACB lead console so the lead's
// timeline shows where the client is. Fire-and-forget: a slow or missing
// console never blocks the portal.
//
// Configure:
//   LEAD_CONSOLE_WEBHOOK_URL=https://www.advancedcb.app/api/webhooks/onboarding
//   LEAD_CONSOLE_WEBHOOK_KEY=<same value as ONBOARDING_WEBHOOK_KEY on the console>

const URL = process.env.LEAD_CONSOLE_WEBHOOK_URL || '';
const KEY = process.env.LEAD_CONSOLE_WEBHOOK_KEY || '';

function enabled() {
  return !!URL;
}

/**
 * @param {string} event  portal_opened | mgmt_type_chosen | entity_added |
 *                        document_uploaded | agreement_signed | onboarding_complete
 * @param {object} session  a sessions row (needs token, lead_id, company_name, contact_email)
 * @param {object} [extra]  { detail?: string, portal_url?: string }
 */
function notifyLeadConsole(event, session, extra = {}) {
  if (!enabled() || !session) return;
  const body = {
    event,
    token: session.token,
    lead_id: session.lead_id || null,
    company_name: session.company_name || '',
    contact_email: session.contact_email || '',
    detail: extra.detail || null,
    portal_url: extra.portal_url || null,
    at: new Date().toISOString(),
  };
  fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-ACB-Service-Key': KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  }).catch((e) => console.error(`Lead console webhook failed (${event}):`, e.message));
}

module.exports = { notifyLeadConsole, enabled };
