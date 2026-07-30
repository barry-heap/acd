// Port of acd/record/nameless.py's NamelessRecord.parse().
//
// Turns one Dat.Record (identifier 0xFAFA) into the tuple stored in the
// `nameless` SQL table: [object_id, parent_id, record_buffer].

function parseNamelessRecord(datRecord) {
  if (datRecord.identifier !== 0xfafa) return null;
  const buf = datRecord.record.recordBuffer;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const parentId = dv.getUint32(8, true);
  const objectId = dv.getUint32(0x0c, true);
  return [objectId, parentId, buf];
}

module.exports = { parseNamelessRecord };
