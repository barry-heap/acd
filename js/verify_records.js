// Dev-only verification harness: dumps parsed record tuples for every .Dat
// file to JSON, for diffing against the equivalent Python output. Not part
// of the shipped app.
const fs = require("fs");
const path = require("path");
const { parseDatFile } = require("./parseDat");
const { parseCompsRecord } = require("./record/comps");
const { parseSbRegionRecord } = require("./record/sbregion");
const { parseCommentsRecord } = require("./record/comments");
const { parseNamelessRecord } = require("./record/nameless");

function b64(u8) {
  return Buffer.from(u8).toString("base64");
}

const dir = process.argv[2] || path.join(__dirname, "extracted");

// Comps
const compsById = new Map();
for (const rec of parseDatFile(path.join(dir, "Comps.Dat"))) {
  const t = parseCompsRecord(rec);
  if (!t) continue;
  const oid = t[0];
  const existing = compsById.get(oid);
  if (!existing || t[5].length > existing[5].length) compsById.set(oid, t);
}
const compsOut = [...compsById.values()]
  .sort((a, b) => a[0] - b[0])
  .map((t) => [t[0], t[1], t[2], t[3], t[4], b64(t[5])]);
fs.writeFileSync("/tmp/js_comps.json", JSON.stringify(compsOut));

const nameLookup = new Map([...compsById.entries()].map(([oid, t]) => [oid, t[2]]));

// SbRegion
const rungsOut = [];
for (const rec of parseDatFile(path.join(dir, "SbRegion.Dat"))) {
  const t = parseSbRegionRecord(rec, nameLookup);
  if (t) rungsOut.push(t);
}
fs.writeFileSync("/tmp/js_rungs.json", JSON.stringify(rungsOut));

// Comments
const commentsOut = [];
for (const rec of parseDatFile(path.join(dir, "Comments.Dat"))) {
  const t = parseCommentsRecord(rec);
  if (t) commentsOut.push(t);
}
fs.writeFileSync("/tmp/js_comments.json", JSON.stringify(commentsOut));

// Nameless
const namelessOut = [];
for (const rec of parseDatFile(path.join(dir, "Nameless.Dat"))) {
  const t = parseNamelessRecord(rec);
  if (t) namelessOut.push([t[0], t[1], b64(t[2])]);
}
fs.writeFileSync("/tmp/js_nameless.json", JSON.stringify(namelessOut));

console.log("comps", compsOut.length, "rungs", rungsOut.length, "comments", commentsOut.length, "nameless", namelessOut.length);
