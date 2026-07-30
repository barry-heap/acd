const fs = require("fs");
const KaitaiStream = require("kaitai-struct/KaitaiStream");
const Dat = require("./generated/Dat").Dat;

const buf = fs.readFileSync("./extracted/Comps.Dat");
const stream = new KaitaiStream(buf);
const dat = new Dat(stream);

console.log("format_type:", dat.header.formatType);
console.log("file_length:", dat.header.fileLength);
console.log("first_record_position:", dat.header.firstRecordPosition);
console.log("number_records_fafa:", dat.header.numberRecordsFafa);
console.log("total records parsed:", dat.records.record.length);

const counts = {};
for (const r of dat.records.record) {
  const id = r.identifier.toString(16);
  counts[id] = (counts[id] || 0) + 1;
}
console.log("record identifiers seen:", counts);

// Show the first FAFA record's raw sub-record buffer length as a sanity check
const firstFafa = dat.records.record.find(r => r.identifier === 0xfafa);
if (firstFafa) {
  console.log("first FAFA sub-record buffer length:", firstFafa.record.recordBuffer.length);
}
