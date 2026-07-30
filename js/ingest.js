// Port of acd/l5x/export_l5x.py's ExportL5x.__post_init__ (the SQL ingestion
// pipeline): extracts an ACD container, parses each .Dat file's records, and
// loads them into a sql.js (SQLite-to-WASM) database with the same schema,
// so the downstream object-graph builders (not yet ported) can run the same
// queries the Python ControllerBuilder/etc. classes do.

const initSqlJs = require("sql.js");
const { Unzip } = require("./unzip");
const { parseDatBytes } = require("./parseDat");
const { parseCompsRecord } = require("./record/comps");
const { parseSbRegionRecord } = require("./record/sbregion");
const { parseCommentsRecord } = require("./record/comments");
const { parseNamelessRecord } = require("./record/nameless");

const SCHEMA = [
  "CREATE TABLE comps(object_id int, parent_id int, comp_name text, seq_number int, record_type int, record BLOB NOT NULL)",
  "CREATE TABLE pointers(object_id int, parent_id int, comp_name text, seq_number int, record_type int, record BLOB NOT NULL)",
  "CREATE TABLE rungs(object_id int, rung text, seq_number int)",
  "CREATE TABLE region_map(object_id int, parent_id int, unknown int, seq_no int, record BLOB NOT NULL)",
  "CREATE TABLE comments(seq_number int, sub_record_length int, object_id int, record_string text, record_type int, parent int, tag_reference text, rung_content int, member_ref int, scope_id int)",
  "CREATE TABLE nameless(object_id int, parent_id int, record BLOB NOT NULL)",
  "CREATE TABLE regnlink(routine_id int, fragment int, rung_object_id int)",
  "CREATE TABLE regnlink_idx(routine_id int, fragment int, rung_object_id int)",
];

// Parses every record in `bytes` with `parseOne(record) -> tuple|null`,
// skipping (and counting) any record whose parser throws -- mirrors
// export_l5x.py's _parse_records(). `bytes` may be undefined (missing file).
function parseRecords(bytes, parseOne, label) {
  if (!bytes) {
    console.warn(`${label}: file not found - skipping`);
    return [];
  }
  let records;
  try {
    records = parseDatBytes(bytes);
  } catch (e) {
    console.warn(`${label}: unreadable database file (${e}) - skipping`);
    return [];
  }
  const out = [];
  let failed = 0;
  for (const record of records) {
    let t;
    try {
      t = parseOne(record);
    } catch (e) {
      failed++;
      continue;
    }
    if (t !== null && t !== undefined) out.push(t);
  }
  if (failed) console.warn(`${label}: skipped ${failed} unparseable record(s) of ${records.length}`);
  return out;
}

// Fixes garbled "N]" -> "[N]" in a comment's tag_reference (missing opening
// bracket), same lookbehind as export_l5x.py's _normalize_comment.
const BARE_INDEX_RE = /(?<![[\d,])(\d+\])/g;
function normalizeComment(t) {
  const [seq, subLen, objId, text, recType, parent, tagRef, rung, member, scopeId] = t;
  if (!tagRef) return t;
  const newRef = tagRef.replace(BARE_INDEX_RE, "[$1");
  return newRef !== tagRef ? [seq, subLen, objId, text, recType, parent, newRef, rung, member, scopeId] : t;
}

function populateRegionMap(db) {
  const rows = db.exec(
    "SELECT comp_name, object_id, parent_id, record FROM comps WHERE parent_id=0 AND comp_name='Region Map'",
  );
  if (!rows.length || !rows[0].values.length) return;
  const record = rows[0].values[0][3]; // Uint8Array (BLOB)
  const dv = new DataView(record.buffer, record.byteOffset, record.byteLength);

  let identifierOffset = 70;
  if (record.length < identifierOffset + 8) return;
  const regionLength = dv.getUint32(identifierOffset + 4, true);

  identifierOffset = 78;
  const recordLengthAbsolute = identifierOffset + regionLength;
  const stmt = db.prepare("INSERT INTO region_map VALUES (?, ?, ?, ?, ?)");
  while (identifierOffset <= recordLengthAbsolute - 16) {
    const parentIdIdentifier = dv.getUint32(identifierOffset, true);
    const unknownIdentifier = dv.getUint32(identifierOffset + 4, true);
    const seqIdentifier = dv.getUint32(identifierOffset + 8, true);
    const objectIdIdentifier = dv.getUint32(identifierOffset + 12, true);
    stmt.run([
      objectIdIdentifier,
      parentIdIdentifier,
      unknownIdentifier,
      seqIdentifier,
      record.subarray(identifierOffset, identifierOffset + 16),
    ]);
    identifierOffset += 16;
  }
  stmt.free();
}

function populateRegnlink(db, files, knownObjectIds) {
  const data = files.get("RegnLink.Dat");
  if (!data) return;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const rows = [];
  const limit = data.length - 22;
  for (let i = 0; i <= limit; i++) {
    const ownerId = dv.getUint32(i, true);
    if (knownObjectIds.has(ownerId)) {
      const nextId = dv.getUint32(i + 8, true);
      const typ = dv.getUint32(i + 12, true);
      if (typ !== 0xffff0000) {
        const fragment = dv.getUint16(i + 18, true);
        rows.push([ownerId, fragment, nextId]);
      }
    }
  }
  if (rows.length) {
    const stmt = db.prepare("INSERT INTO regnlink VALUES (?,?,?)");
    for (const r of rows) stmt.run(r);
    stmt.free();
    db.run("CREATE INDEX idx_regnlink_routine_fragment ON regnlink(routine_id, fragment)");
  }

  const idxData = files.get("RegnLink.Idx");
  if (!idxData) return;
  const idxDv = new DataView(idxData.buffer, idxData.byteOffset, idxData.byteLength);
  const datLen = data.length;
  const idxRows = [];
  const idxLimit = idxData.length - 16;
  for (let i = 0; i <= idxLimit; i++) {
    const routineId = idxDv.getUint32(i + 4, true);
    if (knownObjectIds.has(routineId) && idxData[i + 3] === 0) {
      const fragment = idxDv.getUint16(i, true);
      const rungObjectId = idxDv.getUint32(i + 8, true);
      const ptr = idxDv.getUint32(i + 12, true);
      if (fragment !== 0xffff && ptr <= datLen) {
        idxRows.push([routineId, fragment, rungObjectId]);
      }
    }
  }
  if (idxRows.length) {
    const stmt = db.prepare("INSERT INTO regnlink_idx VALUES (?,?,?)");
    for (const r of idxRows) stmt.run(r);
    stmt.free();
    db.run("CREATE INDEX idx_regnlink_idx_routine_fragment ON regnlink_idx(routine_id, fragment)");
  }
}

// acdBytes: Uint8Array of the whole .ACD file. Returns { db, rawFiles,
// fileOrder, idToName } -- rawFiles/fileOrder mirror ExportL5x's own
// _raw_files/_file_order (kept for a future write-back/round-trip feature,
// out of scope for this converter but cheap to carry through).
async function ingestAcd(acdBytes) {
  // In Node, point sql.js at its own package files on disk. In the browser
  // build (see build.js/ui.js), initSqlJs is the plain-JS asm.js variant
  // embedded directly in the page -- it has no separate .wasm to fetch, so
  // locateFile is never actually invoked there; passing a Node-only
  // require.resolve unconditionally would throw in that environment before
  // it even got called, since `require` itself isn't a browser global.
  const isNode = typeof process !== "undefined" && !!process.versions && !!process.versions.node;
  const SQL = await initSqlJs(isNode ? { locateFile: (file) => require.resolve(`sql.js/dist/${file}`) } : {});
  const db = new SQL.Database();
  for (const stmt of SCHEMA) db.run(stmt);

  const unzip = new Unzip(acdBytes);
  const files = unzip.extractAll();
  const fileOrder = unzip.records.map((r) => r.filename);

  const compsTuples = parseRecords(files.get("Comps.Dat"), parseCompsRecord, "Comps");
  const compsById = new Map();
  for (const t of compsTuples) {
    const oid = t[0];
    const existing = compsById.get(oid);
    if (!existing || t[5].length > existing[5].length) compsById.set(oid, t);
  }
  {
    const stmt = db.prepare("INSERT INTO comps VALUES (?,?,?,?,?,?)");
    for (const t of compsById.values()) stmt.run(t);
    stmt.free();
  }

  const idToName = new Map([...compsById.entries()].map(([oid, t]) => [oid, t[2]]));

  populateRegionMap(db);
  populateRegnlink(db, files, new Set(compsById.keys()));

  const rungTuples = parseRecords(
    files.get("SbRegion.Dat"),
    (rec) => parseSbRegionRecord(rec, idToName),
    "SbRegion",
  );
  {
    const stmt = db.prepare("INSERT INTO rungs VALUES (?,?,?)");
    for (const t of rungTuples) stmt.run(t);
    stmt.free();
  }

  let commentTuples = parseRecords(files.get("Comments.Dat"), parseCommentsRecord, "Comments");
  commentTuples = commentTuples.map(normalizeComment);
  const seen = new Map();
  for (const t of commentTuples) {
    const key = JSON.stringify([t[5], t[6], t[9], t[7]]);
    const existing = seen.get(key);
    if (!existing || t[3].length > existing[3].length) seen.set(key, t);
  }
  {
    const stmt = db.prepare("INSERT INTO comments VALUES (?,?,?,?,?,?,?,?,?,?)");
    for (const t of seen.values()) stmt.run(t);
    stmt.free();
  }

  const namelessTuples = parseRecords(files.get("Nameless.Dat"), parseNamelessRecord, "Nameless");
  {
    const stmt = db.prepare("INSERT INTO nameless VALUES (?,?,?)");
    for (const t of namelessTuples) stmt.run(t);
    stmt.free();
  }

  db.run("CREATE INDEX idx_comps_object_id ON comps(object_id)");
  db.run("CREATE INDEX idx_comps_parent_id ON comps(parent_id)");
  db.run("CREATE INDEX idx_comps_parent_name ON comps(parent_id, comp_name)");
  db.run("CREATE INDEX idx_rungs_object_id ON rungs(object_id)");
  db.run("CREATE INDEX idx_region_map_parent_id ON region_map(parent_id)");
  db.run("CREATE INDEX idx_comments_parent ON comments(parent, scope_id)");
  db.run("CREATE INDEX idx_nameless_parent_id ON nameless(parent_id)");

  return { db, rawFiles: files, fileOrder, idToName };
}

module.exports = { ingestAcd, parseRecords, normalizeComment };
