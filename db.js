const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'onboarding.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  company_name TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  contact_fax TEXT NOT NULL DEFAULT '',
  mgmt_type TEXT NOT NULL DEFAULT '',
  checks_mode TEXT NOT NULL DEFAULT 'per_entity',
  corporate_payable_to TEXT NOT NULL DEFAULT '',
  corporate_check_address TEXT NOT NULL DEFAULT '',
  completed_at TEXT,
  notified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  legal_name TEXT NOT NULL DEFAULT '',
  property_name TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  payable_to TEXT NOT NULL DEFAULT '',
  check_address TEXT NOT NULL DEFAULT '',
  signer_name TEXT,
  signer_title TEXT,
  signature TEXT,
  signed_at TEXT,
  signed_ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entities_session ON entities(session_id);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT,
  uploaded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_session ON files(session_id);
`);

// Additive migrations for databases created before DocuSeal integration.
for (const col of [
  'docuseal_submission_id INTEGER',
  'docuseal_slug TEXT',
  'signed_doc_url TEXT',
  'signer_email TEXT',
  "contact_name TEXT NOT NULL DEFAULT ''",
  "contact_email TEXT NOT NULL DEFAULT ''",
  "contact_phone TEXT NOT NULL DEFAULT ''",
]) {
  try { db.exec(`ALTER TABLE entities ADD COLUMN ${col}`); } catch (e) { /* already exists */ }
}

module.exports = { db, DATA_DIR, UPLOAD_DIR };
