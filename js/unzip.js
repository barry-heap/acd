// Pure-JS port of acd/zip/unzip.py: reads the top-level ACD container
// (a proprietary zip-like archive, NOT a real zip file) and extracts its
// member files (Comps.Dat, SbRegion.Dat, Comments.Dat, ...), gzip-decompressing
// any member that starts with the gzip magic number.
//
// Mirrors the Python implementation byte-for-byte (see acd/zip/unzip.py) so the
// two stay a straightforward line-for-line reference for each other.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const RECORD_SIZE = 528;

class FileRecord {
  constructor(buf, offset) {
    // UTF-16LE filename, null-terminated, occupying up to (520 - 8) bytes,
    // followed by fileLength/fileOffset as two little-endian u32s.
    let end = offset;
    while (end + 1 < offset + 520) {
      if (buf[end] === 0 && buf[end + 1] === 0) break;
      end += 2;
    }
    this.filename = buf.toString("utf16le", offset, end);
    this.fileLength = buf.readUInt32LE(offset + 520);
    this.fileOffset = buf.readUInt32LE(offset + 524);
  }
}

class Unzip {
  constructor(filename) {
    this._filename = filename;
    this._read();
  }

  _read() {
    const buf = fs.readFileSync(this._filename);
    this._buf = buf;

    const magic = buf.readUInt16BE(0);
    if (magic !== 0x0d0a) {
      throw new Error("File isn't a Rockwell ACD file");
    }

    const fileSize = buf.length;
    const noFiles = buf.readUInt32LE(fileSize - 8);
    // unknownTwo = buf.readUInt32LE(fileSize - 4) — unused, kept for parity with Python
    const recordOffset = fileSize - noFiles * RECORD_SIZE - 8;

    this.records = [];
    for (let i = 0; i < noFiles; i++) {
      this.records.push(new FileRecord(buf, recordOffset + i * RECORD_SIZE));
    }
  }

  writeFiles(directory) {
    fs.mkdirSync(directory, { recursive: true });
    for (const record of this.records) {
      const chunk = this._buf.subarray(record.fileOffset, record.fileOffset + record.fileLength);
      const isGzip = chunk[0] === 0x1f && chunk[1] === 0x8b;
      const outBuf = isGzip ? zlib.gunzipSync(chunk) : chunk;
      fs.writeFileSync(path.join(directory, record.filename), outBuf);
    }
  }
}

module.exports = { Unzip };
