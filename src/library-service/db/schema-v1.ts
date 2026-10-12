/**
 * Schema v1 of the Library database, exactly the SQL block of docs/LIBRARY_SCHEMA.md (a test compares the two).
 * The pragmas are applied by the connection code, not part of the schema text.
 */
export const SCHEMA_V1_SQL = `CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE root(id INTEGER PRIMARY KEY, public_id TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE, label TEXT NOT NULL, state TEXT NOT NULL,
  network INTEGER NOT NULL CHECK(network IN (0,1)), options TEXT NOT NULL) STRICT;
CREATE TABLE dir(id INTEGER PRIMARY KEY, root_id INTEGER NOT NULL REFERENCES root ON DELETE CASCADE,
  parent_id INTEGER REFERENCES dir ON DELETE CASCADE, name TEXT NOT NULL) STRICT;
CREATE UNIQUE INDEX dir_child ON dir(root_id,parent_id,name) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX dir_top ON dir(root_id) WHERE parent_id IS NULL;
CREATE TABLE content(id INTEGER PRIMARY KEY, public_id TEXT NOT NULL UNIQUE,
  quick BLOB NOT NULL, sha256 BLOB UNIQUE, size INTEGER NOT NULL,
  kind TEXT, format TEXT, variant TEXT, confidence INTEGER, needs_key TEXT,
  problem TEXT, attempts INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE INDEX content_quick ON content(quick,size);
CREATE TABLE file(id INTEGER PRIMARY KEY, public_id TEXT NOT NULL UNIQUE,
  dir_id INTEGER NOT NULL REFERENCES dir ON DELETE CASCADE, name TEXT NOT NULL,
  container_id INTEGER REFERENCES file ON DELETE CASCADE, entry_path TEXT,
  size INTEGER NOT NULL, mtime_ms INTEGER, file_key TEXT,
  content_id INTEGER REFERENCES content ON DELETE SET NULL,
  state TEXT NOT NULL, seen_scan INTEGER NOT NULL, missing_since INTEGER,
  CHECK((container_id IS NULL) = (entry_path IS NULL))) STRICT;
CREATE UNIQUE INDEX file_loose ON file(dir_id,name) WHERE container_id IS NULL;
CREATE UNIQUE INDEX file_entry ON file(container_id,entry_path) WHERE container_id IS NOT NULL;
CREATE INDEX file_content ON file(content_id);
CREATE INDEX file_scan ON file(dir_id,seen_scan);
CREATE INDEX file_container ON file(container_id);
CREATE TABLE stage(content_id INTEGER NOT NULL REFERENCES content ON DELETE CASCADE,
  stage TEXT NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL, error TEXT,
  at INTEGER NOT NULL, PRIMARY KEY(content_id,stage)) STRICT, WITHOUT ROWID;
CREATE TABLE board(content_id INTEGER PRIMARY KEY REFERENCES content ON DELETE CASCADE,
  adapter TEXT, variant TEXT, parts INTEGER, pins INTEGER, nets INTEGER, sides TEXT,
  fingerprint BLOB, fp_version INTEGER, minhash BLOB, refs BLOB,
  title TEXT, revision TEXT, drawing TEXT, company TEXT, date TEXT,
  width_mm REAL, height_mm REAL, components BLOB, passives BLOB, truncated TEXT) STRICT;
CREATE INDEX board_fingerprint ON board(fp_version,fingerprint);
CREATE TABLE document(content_id INTEGER PRIMARY KEY REFERENCES content ON DELETE CASCADE,
  format TEXT, doc_type TEXT, pages INTEGER, text_layer TEXT, ocr TEXT,
  title TEXT, producer TEXT, refs BLOB, refs_minhash BLOB, page_hashes BLOB,
  truncated TEXT) STRICT;
CREATE TABLE image(content_id INTEGER PRIMARY KEY REFERENCES content ON DELETE CASCADE,
  width INTEGER NOT NULL, height INTEGER NOT NULL) STRICT;
CREATE TABLE term(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, norm TEXT NOT NULL,
  base TEXT, family TEXT, category TEXT, UNIQUE(kind,norm)) STRICT;
CREATE INDEX term_base ON term(base);
CREATE INDEX term_family ON term(family);
CREATE TABLE posting(term_id INTEGER NOT NULL REFERENCES term ON DELETE CASCADE,
  content_id INTEGER NOT NULL REFERENCES content ON DELETE CASCADE,
  source TEXT NOT NULL, tier INTEGER NOT NULL, refs TEXT, additional_refs INTEGER NOT NULL DEFAULT 0,
  pages BLOB, PRIMARY KEY(term_id,content_id,source)) STRICT, WITHOUT ROWID;
CREATE INDEX posting_content ON posting(content_id);
CREATE TABLE identifier(id INTEGER PRIMARY KEY,
  content_id INTEGER REFERENCES content ON DELETE CASCADE,
  file_id INTEGER REFERENCES file ON DELETE CASCADE, kind TEXT NOT NULL,
  norm TEXT NOT NULL, raw TEXT, source TEXT NOT NULL, confidence INTEGER NOT NULL,
  page INTEGER, pattern TEXT, CHECK((content_id IS NULL) != (file_id IS NULL))) STRICT;
CREATE INDEX identifier_norm ON identifier(kind,norm);
CREATE INDEX identifier_content ON identifier(content_id);
CREATE INDEX identifier_file ON identifier(file_id);
CREATE TABLE grp(id TEXT PRIMARY KEY, label TEXT, vendor TEXT, model TEXT,
  board_number TEXT, device_type TEXT, updated INTEGER, tags TEXT) STRICT;
CREATE TABLE member(group_id TEXT NOT NULL REFERENCES grp ON DELETE CASCADE,
  content_id INTEGER NOT NULL REFERENCES content ON DELETE CASCADE,
  role TEXT NOT NULL, revision TEXT, tier TEXT NOT NULL, evidence TEXT NOT NULL,
  PRIMARY KEY(group_id,content_id)) STRICT, WITHOUT ROWID;
CREATE INDEX member_content ON member(content_id);
CREATE TABLE suggestion(a INTEGER NOT NULL REFERENCES content ON DELETE CASCADE,
  b INTEGER NOT NULL REFERENCES content ON DELETE CASCADE, kind TEXT NOT NULL,
  score REAL NOT NULL, evidence TEXT NOT NULL, CHECK(a < b),
  PRIMARY KEY(a,b,kind)) STRICT, WITHOUT ROWID;
CREATE INDEX suggestion_b ON suggestion(b);
CREATE TABLE revision(group_id TEXT NOT NULL REFERENCES grp ON DELETE CASCADE,
  content_id INTEGER NOT NULL REFERENCES content ON DELETE CASCADE,
  label TEXT NOT NULL, scheme TEXT NOT NULL, ordinal INTEGER, basis TEXT NOT NULL,
  added_parts INTEGER, removed_parts INTEGER, changed_values INTEGER,
  PRIMARY KEY(group_id,content_id)) STRICT, WITHOUT ROWID;
CREATE TABLE duplicate_set(id TEXT PRIMARY KEY, kind TEXT NOT NULL, evidence TEXT NOT NULL) STRICT;
CREATE TABLE duplicate_file(set_id TEXT NOT NULL REFERENCES duplicate_set ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES file ON DELETE CASCADE,
  PRIMARY KEY(set_id,file_id)) STRICT, WITHOUT ROWID;
CREATE TABLE duplicate_content(set_id TEXT NOT NULL REFERENCES duplicate_set ON DELETE CASCADE,
  content_id INTEGER NOT NULL REFERENCES content ON DELETE CASCADE,
  PRIMARY KEY(set_id,content_id)) STRICT, WITHOUT ROWID;
CREATE VIRTUAL TABLE name_fts USING fts5(name,path,content='',contentless_delete=1,tokenize='trigram');
CREATE VIRTUAL TABLE text_fts USING fts5(body,content='',contentless_delete=1);`;
