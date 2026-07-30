// Dev-only verification harness: ingests the fixture ACD through ingest.js
// and dumps every SQL table's full contents to JSON, for diffing against the
// equivalent Python ExportL5x table dumps. Not part of the shipped app. See
// js/CLAUDE.md for the matching Python-side snippet.
const fs = require("fs");
const path = require("path");
const { ingestAcd } = require("./ingest");

function b64(u8) {
  return Buffer.from(u8).toString("base64");
}

function dump(db, tbl, cols, blobCols = []) {
  const res = db.exec(`SELECT ${cols.join(",")} FROM ${tbl}`);
  if (!res.length) return [];
  return res[0].values.map((row) => {
    row = row.slice();
    for (const i of blobCols) row[i] = b64(row[i]);
    return row;
  });
}

(async () => {
  const acdPath = process.argv[2] || path.join(__dirname, "..", "resources", "CuteLogix.ACD");
  const bytes = fs.readFileSync(acdPath);
  const { db } = await ingestAcd(bytes);

  const out = {
    comps: dump(db, "comps", ["object_id", "parent_id", "comp_name", "seq_number", "record_type", "record"], [5]).sort(
      (a, b) => a[0] - b[0],
    ),
    rungs: dump(db, "rungs", ["object_id", "rung", "seq_number"]).sort(
      (a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0),
    ),
    region_map: dump(db, "region_map", ["object_id", "parent_id", "unknown", "seq_no", "record"], [4]).sort(
      (a, b) => a[0] - b[0] || a[3] - b[3],
    ),
    comments: dump(db, "comments", [
      "seq_number",
      "sub_record_length",
      "object_id",
      "record_string",
      "record_type",
      "parent",
      "tag_reference",
      "rung_content",
      "member_ref",
      "scope_id",
    ]).sort((a, b) => a[5] - b[5] || (a[6] < b[6] ? -1 : a[6] > b[6] ? 1 : 0) || a[9] - b[9] || a[7] - b[7]),
    nameless: dump(db, "nameless", ["object_id", "parent_id", "record"], [2]).sort((a, b) => a[0] - b[0]),
    regnlink: dump(db, "regnlink", ["routine_id", "fragment", "rung_object_id"]).sort(
      (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2],
    ),
    regnlink_idx: dump(db, "regnlink_idx", ["routine_id", "fragment", "rung_object_id"]).sort(
      (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2],
    ),
  };

  fs.writeFileSync("/tmp/js_ingest_full.json", JSON.stringify(out));
  console.log(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
