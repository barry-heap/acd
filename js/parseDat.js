// Parses a .Dat file's raw records into an array of Dat.Record instances
// (identifier, lenRecord, record.recordBuffer), mirroring
// DbExtract(path).read().records.record in Python.

const fs = require("fs");
const { KaitaiStream } = require("kaitai-struct");
const { Dat } = require("./generated/Dat");

// bytes: Uint8Array of a whole .Dat file's contents (already extracted/
// decompressed). This is the browser-compatible entry point.
function parseDatBytes(bytes) {
  const dat = new Dat(new KaitaiStream(bytes));
  return dat.records.record;
}

// Node-only convenience for dev/testing against files already on disk.
function parseDatFile(path) {
  return parseDatBytes(fs.readFileSync(path));
}

module.exports = { parseDatBytes, parseDatFile };
