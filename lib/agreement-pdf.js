const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const CONTENT_W = PAGE_W - MARGIN * 2;

const INK = rgb(0.1, 0.1, 0.18);
const GRAY = rgb(0.42, 0.44, 0.52);
const LINE = rgb(0.72, 0.74, 0.8);
const BLUE = rgb(0.24, 0.35, 0.95);

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

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

async function buildAgreementPdf(session, entity) {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const oblique = await doc.embedFont(StandardFonts.HelveticaOblique);
  const page = doc.addPage([PAGE_W, PAGE_H]);

  let y = PAGE_H - 46;
  const center = (text, font, size, color = INK) => {
    const w = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x: (PAGE_W - w) / 2, y, size, font, color });
    y -= size + 4;
  };

  // Letterhead
  center('ADVANCED COLLECTION BUREAU, INC.', bold, 15, BLUE);
  y -= 1;
  center('Phone (321) 633-4999   Toll Free (877) 928-9289   Fax (321) 802-2785', helv, 8, GRAY);
  center('Advancedcb.com   PO Box 560063 Rockledge, FL 32956', helv, 8, GRAY);
  y -= 10;
  center('AGREEMENT FOR COLLECTION SERVICES', bold, 12);
  y -= 10;

  const label = (text, x, size = 8.5) => page.drawText(text, { x, y, size, font: helv, color: GRAY });
  const fieldLine = (x, width) =>
    page.drawLine({ start: { x, y: y - 2.5 }, end: { x: x + width, y: y - 2.5 }, thickness: 0.7, color: LINE });
  const value = (text, x, width, size = 10) => {
    fieldLine(x, width);
    if (text) page.drawText(String(text), { x: x + 3, y, size, font: bold, color: INK });
  };

  // Creditor name / client #
  label("Creditor's name", MARGIN);
  value(entity.legal_name, MARGIN + 70, 300);
  label('Client #', 452);
  value('', 486, 72);
  y -= 10;
  page.drawText('(Legal Entity on Lease Agreements)', { x: MARGIN + 70, y, size: 7, font: oblique, color: GRAY });
  page.drawText('(Will be assigned)', { x: 486, y, size: 7, font: oblique, color: GRAY });
  y -= 18;

  label('Address', MARGIN);
  value(entity.address, MARGIN + 40, CONTENT_W - 40);
  y -= 20;

  // Entity-level contact overrides the company-wide one when provided.
  label('Point of Contact', MARGIN);
  value(entity.contact_name || session.contact_name, MARGIN + 70, 180);
  label('Email', 330);
  value(entity.contact_email || session.contact_email, 358, 200);
  y -= 20;

  label('Phone', MARGIN);
  value(entity.contact_phone || session.contact_phone, MARGIN + 40, 150);
  label('Fax', 330);
  value(session.contact_fax, 358, 150);
  y -= 22;

  page.drawText('Fee: Contingent 40%        Remit: Net-Monthly        Activity Report: per request        On Credit Report: Yes', {
    x: MARGIN, y, size: 9, font: bold, color: INK,
  });
  y -= 22;

  // Checkboxes
  const checkbox = (x, checked) => {
    page.drawRectangle({ x, y: y - 1.5, width: 9, height: 9, borderColor: INK, borderWidth: 0.8 });
    if (checked) {
      page.drawLine({ start: { x: x + 1.5, y: y + 3 }, end: { x: x + 4, y: y + 0.5 }, thickness: 1.2, color: BLUE });
      page.drawLine({ start: { x: x + 4, y: y + 0.5 }, end: { x: x + 7.5, y: y + 6.5 }, thickness: 1.2, color: BLUE });
    }
  };

  const isThirdParty = session.mgmt_type === 'third_party';
  const isOwnerOp = session.mgmt_type === 'owner_operator';
  const payment = resolvePayment(session, entity);
  const remitToAbove =
    normalize(payment.payableTo) === normalize(entity.legal_name) &&
    (!payment.address || normalize(payment.address) === normalize(entity.address));

  label('Third Party or Owner Operators?', MARGIN, 8.5);
  checkbox(198, isThirdParty);
  page.drawText('Third-Party', { x: 211, y, size: 8.5, font: helv, color: INK });
  checkbox(268, isOwnerOp);
  page.drawText('Owner Operators', { x: 281, y, size: 8.5, font: helv, color: INK });

  label('Remit to Address above?', 372, 8.5);
  checkbox(474, remitToAbove);
  page.drawText('Yes', { x: 487, y, size: 8.5, font: helv, color: INK });
  checkbox(510, !remitToAbove);
  page.drawText('No', { x: 523, y, size: 8.5, font: helv, color: INK });
  y -= 11;
  page.drawText('(Third-Party management means you manage on behalf of other owners; owner operators', {
    x: MARGIN, y, size: 6.5, font: oblique, color: GRAY,
  });
  page.drawText('(If No, checks are directed as noted below)', { x: 372, y, size: 6.5, font: oblique, color: GRAY });
  y -= 8;
  page.drawText('own the properties they manage. If you do both, third party is checked.)', {
    x: MARGIN, y, size: 6.5, font: oblique, color: GRAY,
  });
  y -= 14;

  // Check remittance details — always stated explicitly so there is no ambiguity.
  page.drawText(`Make checks payable to: ${payment.payableTo || entity.legal_name}`, { x: MARGIN, y, size: 9, font: bold, color: INK });
  y -= 13;
  page.drawText(`Mail checks to: ${payment.address || entity.address || ''}`, { x: MARGIN, y, size: 9, font: bold, color: INK });
  y -= 18;

  // Body paragraphs
  const para = (text, size = 8, indent = 0, gap = 6, font = helv) => {
    const lines = wrapText(text, font, size, CONTENT_W - indent);
    for (const line of lines) {
      page.drawText(line, { x: MARGIN + indent, y, size, font, color: INK });
      y -= size + 2.2;
    }
    y -= gap;
  };

  para('Whereas, Creditor desires, from time to time, to submit to Collector for collection certain claims, accounts or other evidences of indebtedness and,', 8, 0, 2);
  para('Whereas, Collector desires to provide Creditor with Collection services with respect to said claims, it is mutually agreed by and between the parties hereto as follows:', 8, 0, 6);

  const terms = [
    'Collector agrees that all activities of Collector shall be carried out in compliance with all applicable federal, state and local laws.',
    'Creditor hereby warrants that all claims forwarded to Collector will be valid and legally enforceable debts and that creditor will, both before and after forwarding said claims, comply with all applicable federal, state and local laws with respect thereto. Further Creditor agrees to provide a copy of judgment, if any, on which a claim is based and/or the name and address of the person or entity to whom the debt was originally owed, if different from Creditor. Creditor agrees to only place accounts with Collector that have not been placed with any other agency unless written consent from the Collector is given.',
    'Creditor agrees to pay the prescribed contingent fee on all accounts paid once the account is turned over for collection.',
    'Collector agrees that the monthly remittance will include creditor portion of all monies collected from the 1st of the month through the last working day of the month, and that the monthly statement will be delivered on or about the 15th of the following month.',
    'Collector maintains right of assignment.',
    "Creditor agrees to remit any monies due collector within ten (10) days after receipt of collector's monthly remittance statement.",
    'Creditor may discontinue this agreement with a thirty (30) day written notice. Collector will continue to work any claims previously submitted.',
    'Creditor agrees to cooperate with any dispute investigations needed and to notify Collector if account was disputed prior to placement.',
  ];
  terms.forEach((t, i) => {
    const size = 8;
    const indent = 24;
    const lines = wrapText(t, helv, size, CONTENT_W - indent - 14);
    page.drawText(`${i + 1}.`, { x: MARGIN + indent, y, size, font: helv, color: INK });
    for (const line of lines) {
      page.drawText(line, { x: MARGIN + indent + 14, y, size, font: helv, color: INK });
      y -= size + 2.2;
    }
    y -= 3;
  });
  y -= 14;

  // Signature block. Anchors record where the signature/date lines sit (as 0-1
  // fractions of the page, y from the top) so DocuSeal fields can be placed on them.
  const anchors = {};
  const anchor = (name, x, w, hUp) => {
    anchors[name] = { x: x / PAGE_W, y: (PAGE_H - (y + hUp)) / PAGE_H, w: w / PAGE_W, h: (hUp + 6) / PAGE_H, page: 0 };
  };
  const sigLine = (x, width) =>
    page.drawLine({ start: { x, y: y - 3 }, end: { x: x + width, y: y - 3 }, thickness: 0.8, color: INK });

  if (entity.signature) {
    try {
      const base64 = entity.signature.split(',').pop();
      const png = await doc.embedPng(Buffer.from(base64, 'base64'));
      const maxW = 170;
      const maxH = 42;
      const scale = Math.min(maxW / png.width, maxH / png.height);
      page.drawImage(png, { x: MARGIN + 24, y: y - 2, width: png.width * scale, height: png.height * scale });
    } catch (e) {
      // Bad signature image data — leave the line blank rather than failing the whole PDF.
    }
  }

  page.drawText('By', { x: MARGIN, y, size: 9, font: helv, color: GRAY });
  sigLine(MARGIN + 18, 220);
  anchor('clientSignature', MARGIN + 18, 220, 40);
  page.drawText('Date', { x: 350, y, size: 9, font: helv, color: GRAY });
  sigLine(374, 110);
  anchor('clientDate', 374, 110, 18);
  if (entity.signed_at) page.drawText(fmtDate(entity.signed_at), { x: 380, y, size: 10, font: bold, color: INK });
  y -= 12;
  const signerLine = entity.signer_name
    ? `(Creditor)  ${entity.signer_name}${entity.signer_title ? ', ' + entity.signer_title : ''}`
    : "(Creditor)  Use individual's full name, not company name.";
  page.drawText(signerLine, { x: MARGIN, y, size: 8, font: helv, color: INK });
  y -= 10;
  page.drawText('By signing above, the individual affirms they are authorized to enter into agreements on behalf of the Creditor.', {
    x: MARGIN, y, size: 7, font: oblique, color: GRAY,
  });
  y -= 24;

  page.drawText('By', { x: MARGIN, y, size: 9, font: helv, color: GRAY });
  sigLine(MARGIN + 18, 220);
  anchor('collectorSignature', MARGIN + 18, 220, 40);
  page.drawText('Date', { x: 350, y, size: 9, font: helv, color: GRAY });
  sigLine(374, 110);
  anchor('collectorDate', 374, 110, 18);
  y -= 12;
  page.drawText('(Collector)  Advanced Collection Bureau, Inc.', { x: MARGIN, y, size: 8, font: helv, color: INK });

  return { bytes: await doc.save(), anchors };
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
