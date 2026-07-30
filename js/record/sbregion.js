// Port of acd/record/sbregion.py's SbRegionRecord.parse() (the static method
// actually used by the ingestion pipeline -- the instance __post_init__ path
// in the Python source is dead code, not ported).
//
// Turns one Dat.Record (identifier 0xFAFA) into the tuple stored in the
// `rungs` SQL table: [identifier, text, ""], or null if this record isn't a
// "Rung NT"/"REGION NT" language_type (the only ones that carry rung text).

const { KaitaiStream } = require("kaitai-struct");
const { FafaSbregions } = require("../generated/FafaSbregions");

const TAG_REF_RE = /@[A-Za-z0-9]*@/g;

function parseSbRegionRecord(datRecord, nameLookup) {
  if (datRecord.identifier !== 0xfafa) return null;
  const r = new FafaSbregions(new KaitaiStream(datRecord.record.recordBuffer));
  const languageType = r.header.languageType;
  if (languageType !== "Rung NT" && languageType !== "REGION NT") return null;

  let text = KaitaiStream.bytesToStr(r.recordBuffer, "UTF-16LE").replace(/\0+$/, "");
  // Matches Python's replace_tag_references exactly: stop at the first
  // unresolvable tag rather than skipping just that one (a real behavior of
  // the reference implementation, not something to "fix" here).
  for (const tag of text.match(TAG_REF_RE) || []) {
    const tagId = parseInt(tag.slice(1, -1), 16);
    const name = nameLookup.get(tagId);
    if (name === undefined) break;
    text = text.split(tag).join(name);
  }
  return [r.header.identifier, text, ""];
}

module.exports = { parseSbRegionRecord };
