# acd-l5x-js-poc

A proof-of-concept JS/Node port of `acd-tools`' low-level ACD binary parser. This is **not**
a replacement for the Python implementation in `../acd` — it exists to evaluate whether a
browser/Node-based ACD reader (no Python runtime required) is worth building out further.

## What's here

- `unzip.js` — pure-JS port of `../acd/zip/unzip.py`: reads the top-level `.ACD` container
  (a proprietary archive format, not a real zip) and extracts its member files
  (`Comps.Dat`, `SbRegion.Dat`, `Comments.Dat`, ...), gzip-decompressing any member that
  needs it. Verified byte-for-byte identical output to the Python `Unzip` class against
  `../resources/CuteLogix.ACD` (all 25 extracted files, compared by MD5).
- `generated/` — Kaitai Struct-compiled JS parsers for the raw record layer:
  `Dat.js` (generic `.Dat` file/record framing, mirrors `../resources/templates/Dat/Dat.ksy`
  and `../acd/generated/dat.py`), `FafaComps.js`/`FdfdComps.js` (Comps.Dat record shapes),
  `FafaComents.js` (Comments.Dat), `FafaSbregions.js` (SbRegion.Dat), `RxGeneric.js`
  (the generic extended-attribute-record layout used throughout Comps.Dat). These were
  generated externally via `kaitai-struct-compiler` from the same/equivalent `.ksy` sources
  as the Python side — do not hand-edit them; regenerate from `.ksy` instead.
- `extract.js` — extracts `../resources/CuteLogix.ACD` into `./extracted/` (gitignored) so
  `test_parse.js` has real data to run against.
- `test_parse.js` — parses `./extracted/Comps.Dat` with `generated/Dat.js` and prints record
  counts by identifier as a smoke test.

## Running it

```bash
npm install
npm test        # extracts the fixture ACD, then parses Comps.Dat and prints record counts
```

## Verified status

**Confirmed correct**: parsing `Comps.Dat` from the `CuteLogix.ACD` fixture with the JS
`Dat.js` parser produces results **identical field-for-field** to Python's own
`acd.generated.dat.Dat` parser (same `.ksy`-derived structure) on the same file — header
fields (`format_type`, `file_length`, `first_record_position`, `number_records_fafa`),
total record count (7297), the record-identifier histogram (`fefe`/`fafa`/`fdfd`/`fbbf`
counts), and the first `fafa` record's sub-buffer length all match exactly.

**Not yet ported / evaluated**:
- Only the raw record-splitting layer (`Dat.js` + a handful of per-file record shapes) is
  covered. None of the higher-level pipeline exists in JS yet: per-record field parsing at
  fixed byte offsets (`../acd/record/*.py`), the SQLite-backed normalization step
  (`../acd/l5x/export_l5x.py`), the `Controller`/`Tag`/`Program`/... object graph and its
  `Builder` classes (`../acd/l5x/elements.py`, ~3600 lines), or L5X XML emission. Porting any
  of that is a substantial undertaking — see `../CLAUDE.md` for how deep and
  binary-offset-driven that logic is (comment/description resolution alone has a whole
  section documenting hard-won reverse-engineering).
- No decision has been made on whether to continue this port. Treat this directory as a
  feasibility spike, not an active parallel implementation, until someone decides to invest
  in it further.
