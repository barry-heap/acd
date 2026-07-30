// Pure-JS port of acd/zip/unzip.py: reads the top-level ACD container
// (a proprietary zip-like archive, NOT a real zip file) and extracts its
// member files (Comps.Dat, SbRegion.Dat, Comments.Dat, ...), gzip-decompressing
// any member that starts with the gzip magic number.
//
// Mirrors the Python implementation byte-for-byte (see acd/zip/unzip.py) so the
// two stay a straightforward line-for-line reference for each other.
//
// Isomorphic: works from a plain Uint8Array/ArrayBuffer in both Node and the
// browser (uses pako for gzip, not Node's zlib). writeFiles() is a Node-only
// convenience for dev/testing (extract.js) and isn't used by the browser app.

const pako = require("pako");

const RECORD_SIZE = 528;
const utf16Decoder = new TextDecoder("utf-16le");

class FileRecord {
  constructor(dv, offset) {
    // UTF-16LE filename, null-terminated, occupying up to (520 - 8) bytes,
    // followed by fileLength/fileOffset as two little-endian u32s.
    let end = offset;
    while (end + 1 < offset + 520) {
      if (dv.getUint16(end, true) === 0) break;
      end += 2;
    }
    this.filename = utf16Decoder.decode(new Uint8Array(dv.buffer, dv.byteOffset + offset, end - offset));
    this.fileLength = dv.getUint32(offset + 520, true);
    this.fileOffset = dv.getUint32(offset + 524, true);
  }
}

class Unzip {
  constructor(data) {
    // data: Uint8Array (or Node Buffer, which is a Uint8Array subclass) of
    // the whole .ACD file's bytes.
    this._buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    this._read();
  }

  _read() {
    const dv = new DataView(this._buf.buffer, this._buf.byteOffset, this._buf.byteLength);

    const magic = dv.getUint16(0, false);
    if (magic !== 0x0d0a) {
      throw new Error("File isn't a Rockwell ACD file");
    }

    const fileSize = this._buf.length;
    const noFiles = dv.getUint32(fileSize - 8, true);
    // unknownTwo = dv.getUint32(fileSize - 4, true) — unused, kept for parity with Python
    const recordOffset = fileSize - noFiles * RECORD_SIZE - 8;

    this.records = [];
    for (let i = 0; i < noFiles; i++) {
      this.records.push(new FileRecord(dv, recordOffset + i * RECORD_SIZE));
    }
  }

  // Returns Map<filename, Uint8Array> of every member file, gzip-decompressed
  // where needed. Works in both Node and the browser.
  extractAll() {
    const out = new Map();
    for (const record of this.records) {
      const chunk = this._buf.subarray(record.fileOffset, record.fileOffset + record.fileLength);
      const isGzip = chunk[0] === 0x1f && chunk[1] === 0x8b;
      out.set(record.filename, isGzip ? pako.ungzip(chunk) : chunk);
    }
    return out;
  }

  // Node-only convenience: writes every extracted member file to `directory`
  // on disk. Used by extract.js for local fixture setup/dev testing.
  writeFiles(directory) {
    const fs = require("fs");
    const path = require("path");
    fs.mkdirSync(directory, { recursive: true });
    for (const [filename, bytes] of this.extractAll()) {
      fs.writeFileSync(path.join(directory, filename), bytes);
    }
  }
}

module.exports = { Unzip };
