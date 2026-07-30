// Extracts the raw .Dat/.Idx/.XML member files out of the sample ACD fixture
// (../resources/CuteLogix.ACD) into ./extracted, so test_parse.js has real data
// to run against. Verified byte-for-byte identical to acd/zip/unzip.py's own
// output for the same fixture (see js/README.md).

const fs = require("fs");
const path = require("path");
const { Unzip } = require("./unzip");

const ACD_PATH = path.join(__dirname, "..", "resources", "CuteLogix.ACD");
const OUT_DIR = path.join(__dirname, "extracted");

const u = new Unzip(fs.readFileSync(ACD_PATH));
u.writeFiles(OUT_DIR);
console.log(`Extracted ${u.records.length} files from ${ACD_PATH} to ${OUT_DIR}`);
