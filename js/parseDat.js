// Parses a .Dat file's raw records into an array of Dat.Record instances
// (identifier, lenRecord, record.recordBuffer), mirroring
// DbExtract(path).read().records.record in Python.

const { KaitaiStream } = require("kaitai-struct");
const { Dat } = require("./generated/Dat");

// bytes: Uint8Array of a whole .Dat file's contents (already extracted/
// decompressed). This is the browser-compatible entry point.
function parseDatBytes(bytes) {
  const dat = new Dat(new KaitaiStream(bytes));
  return dat.records.record;
}

// Node-only convenience for dev/testing against files already on disk.
// require("fs") is deliberately lazy/inline here, not a top-level import --
// this file is also embedded in the browser build (build.js), where "fs"
// doesn't exist; a top-level require("fs") would throw as soon as the page
// loads, before this function is ever called (it never is, from the UI).
function parseDatFile(path) {
  const fs = require("fs");
  return parseDatBytes(fs.readFileSync(path));
}

module.exports = { parseDatBytes, parseDatFile };
