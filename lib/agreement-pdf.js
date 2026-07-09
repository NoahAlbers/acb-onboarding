const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const path = require('path');
const fs = require('fs');

// The agreement is the official ACB "Agreement for Collection Services" PDF
// (assets/collection-agreement.pdf — logo, layout, and legal text untouched).
// We only draw the client's values onto its blank lines; DocuSeal signature
// fields are placed on its real signature lines via the exported anchors.
//
// All coordinates below were measured from that PDF (612 x 792 pt, one page).
// pdf-lib's origin is bottom-left, so vertical positions are (792 - top-offset).

const TEMPLATE_PATH = path.join(__dirname, '..', 'assets', 'collection-agreement.pdf');
let templateBytes = null;
const loadTemplate = () => (templateBytes ||= fs.readFileSync(TEMPLATE_PATH));

const INK = rgb(0.05, 0.09, 0.35); // handwriting-blue ink for filled values

// Resolve where checks for this entity's agreement should go.
function resolvePayment(session, entity) {
  if (session.checks_mode === 'corporate') {
    return {
      payableTo: session.corporate_payable_to || session.company_name,
      address: session.corporate_check_address,
    };
  }
  return {
    payableTo: entity.payable_to || entity.legal_name,
    address: entity.check_address || entity.address,
  };
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[\s,.]+/g, ' ').trim();
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

function wrapText(text, font, size, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? line + ' ' + word : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// DocuSeal field areas on the template's signature block, as 0-1 page fractions
// (y measured from the top, page numbers 1-based).
const ANCHORS = {
  clientSignature: { x: 40 / 612, y: 650 / 792, w: 212 / 612, h: 36 / 792, page: 1 },
  clientDate: { x: 322 / 612, y: 656 / 792, w: 115 / 612, h: 30 / 792, page: 1 },
  collectorSignature: { x: 40 / 612, y: 703 / 792, w: 212 / 612, h: 36 / 792, page: 1 },
  collectorDate: { x: 322 / 612, y: 709 / 792, w: 115 / 612, h: 30 / 792, page: 1 },
};

async function buildAgreementPdf(session, entity) {
  const doc = await PDFDocument.load(loadTemplate());
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.getPage(0);

  // Draw a value, shrinking the font until it fits the blank's width.
  const put = (text, x, y, maxWidth, size = 10) => {
    const str = String(text || '').trim();
    if (!str) return;
    let s = size;
    while (s > 5.5 && helv.widthOfTextAtSize(str, s) > maxWidth) s -= 0.5;
    page.drawText(str, { x, y, size: s, font: helv, color: INK });
  };

  // X mark inside one of the template's checkboxes (xc/yc = box center).
  const check = (xc, yc) => {
    for (const dir of [1, -1]) {
      page.drawLine({
        start: { x: xc - 3.2, y: yc - 3.2 * dir },
        end: { x: xc + 3.2, y: yc + 3.2 * dir },
        thickness: 1.4,
        color: INK,
      });
    }
  };

  // ---- top fields (Client # stays blank for ACB to assign) ----
  put(entity.legal_name, 112, 647, 356, 10.5);
  put(entity.address, 74, 623, 492);
  put(entity.contact_name || session.contact_name, 104, 597, 252);
  put(entity.contact_email || session.contact_email, 400, 597, 182);
  put(entity.contact_title || session.contact_title, 126, 570.5, 232);
  put(entity.contact_phone || session.contact_phone, 407, 570.5, 175);

  // ---- checkboxes ----
  if (session.mgmt_type === 'third_party') check(246, 516);
  if (session.mgmt_type === 'owner_operator') check(358.5, 516);

  const payment = resolvePayment(session, entity);
  const remitToAbove =
    normalize(payment.payableTo) === normalize(entity.legal_name) &&
    (!payment.address || normalize(payment.address) === normalize(entity.address));
  // Blank preview (no entity yet): leave the remit checkboxes empty.
  if (entity.legal_name || entity.address || payment.payableTo || payment.address) {
    check(remitToAbove ? 522.5 : 570.5, 516);
  }

  // "(If No please note where monies are going)" zone
  if (!remitToAbove) {
    const lines = wrapText(`Payable to: ${payment.payableTo}  —  Mail to: ${payment.address}`, helv, 7.5, 205);
    let y = 489;
    for (const line of lines.slice(0, 4)) {
      page.drawText(line, { x: 377, y, size: 7.5, font: helv, color: INK });
      y -= 9.5;
    }
  }

  // ---- signature block (built-in signing mode; DocuSeal draws its own) ----
  if (entity.signature) {
    try {
      const base64 = entity.signature.split(',').pop();
      const png = await doc.embedPng(Buffer.from(base64, 'base64'));
      const scale = Math.min(112 / png.width, 36 / png.height);
      page.drawImage(png, { x: 46, y: 110, width: png.width * scale, height: png.height * scale });
    } catch (e) {
      // Bad signature image data — leave the line blank rather than failing the whole PDF.
    }
  }
  if (entity.signer_name && (entity.signature || entity.signed_at)) {
    const printed = `${entity.signer_name}${entity.signer_title ? ', ' + entity.signer_title : ''}`;
    put(printed, 162, 111, 90, 7);
  }
  if (entity.signed_at) put(fmtDate(entity.signed_at), 330, 111, 105, 10);

  return { bytes: await doc.save(), anchors: ANCHORS };
}

async function buildAllAgreementsPdf(session, entities) {
  const merged = await PDFDocument.create();
  for (const entity of entities) {
    let bytes = null;
    // Prefer the DocuSeal-signed copy (it carries the real signature) when one exists.
    if (entity.signed_doc_url) {
      try {
        const res = await fetch(entity.signed_doc_url);
        if (res.ok) bytes = new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        console.error(`Could not fetch signed document for entity ${entity.id}:`, e.message);
      }
    }
    if (!bytes) ({ bytes } = await buildAgreementPdf(session, entity));
    const src = await PDFDocument.load(bytes);
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach((p) => merged.addPage(p));
  }
  return merged.save();
}

module.exports = { buildAgreementPdf, buildAllAgreementsPdf, resolvePayment };
