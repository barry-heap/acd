// Port of acd/record/comps.py.
//
// Turns one Dat.Record (identifier 0xFAFA or 0xFDFD) into the tuple stored in
// the `comps` SQL table: [object_id, parent_id, comp_name, seq_number,
// record_type, record_buffer].
//
// Verified field-for-field (including record_buffer bytes) against Python's
// CompsRecord.parse() for every FAFA (7074) and FDFD (205) record in the
// CuteLogix.ACD fixture's Comps.Dat -- see js/README.md.

const { KaitaiStream } = require("kaitai-struct");
const { FafaComps } = require("../generated/FafaComps");
const { FdfdComps } = require("../generated/FdfdComps");

function parseCompsRecord(datRecord) {
  let r;
  if (datRecord.identifier === 0xfafa) {
    r = new FafaComps(new KaitaiStream(datRecord.record.recordBuffer));
  } else if (datRecord.identifier === 0xfdfd) {
    r = new FdfdComps(
      new KaitaiStream(datRecord.record.recordBuffer),
      null,
      null,
      datRecord.lenRecord,
    );
  } else {
    return null;
  }
  return [
    r.header.objectId,
    r.header.parentId,
    r.header.recordName.value,
    r.header.seqNumber,
    r.header.recordType,
    r.recordBuffer,
  ];
}

module.exports = { parseCompsRecord };
