// Parses a .Dat file's raw records into an array of Dat.Record instances
// (identifier, lenRecord, record.recordBuffer), mirroring
// DbExtract(path).read().records.record in Python.

const fs = require("fs");
const { KaitaiStream } = require("kaitai-struct");
const { Dat } = require("./generated/Dat");

function parseDatFile(path) {
  const buf = fs.readFileSync(path);
  const dat = new Dat(new KaitaiStream(buf));
  return dat.records.record;
}

module.exports = { parseDatFile };
