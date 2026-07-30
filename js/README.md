# ACD → L5X Browser Converter (JS port) — WORK IN PROGRESS

A from-scratch JS/Node port of `acd-tools`' ACD binary parser and L5X exporter, built toward a
**standalone, fully offline, browser-based ACD → L5X converter** — no server, no Studio 5000, no
Python at runtime. This is the actively-developed target, not a spike — see `CLAUDE.md` in this
directory for the detailed, ongoing porting log (verification methodology, byte-offset findings,
what's done vs. not). `../CLAUDE.md` (repo root) is the reference spec: this port is being
verified field-for-field against that mature Python implementation at every layer.

**Scope**: ACD → L5X only, no write-back to `.ACD` (`acd/integrity/` is intentionally not
ported — round-tripping needs a Studio-version HMAC key this project doesn't have or need).

## Layout

- `unzip.js` — ACD container extraction (port of `acd/zip/unzip.py`).
- `generated/` — Kaitai Struct-compiled JS parsers for the raw record layer (`Dat.js`,
  `FafaComps.js`, `FdfdComps.js`, `RxGeneric.js`, `FafaSbregions.js`, `FafaComents.js`).
- `parseDat.js` — thin wrapper: parses a `.Dat` file into its raw `Dat.Record` list.
- `record/` — per-file record-shape parsers (port of `acd/record/*.py`): `comps.js`,
  `sbregion.js`, `comments.js`, `nameless.js`.
- `extract.js` — extracts `../resources/CuteLogix.ACD` into `./extracted/` (gitignored).
- `ingest.js` — SQL ingestion layer (port of `acd/l5x/export_l5x.py`'s `ExportL5x`): extracts an
  ACD, parses every `.Dat` file, and loads everything into a `sql.js` (SQLite-to-WASM) database
  with the same schema Python's `ControllerBuilder` and friends query.
- `test_parse.js` / `verify_records.js` / `verify_ingest.js` — smoke tests / dev verification
  harnesses (dump parsed tuples / SQL table contents to JSON for diffing against the equivalent
  Python output — not part of the shipped app).

Not yet present: the object-graph builders and XML emission (`acd/l5x/elements.py`, the bulk of
the remaining work), the pipeline entry point (`acd/api.py`), or the browser UI. See `CLAUDE.md`
for current status on each.

## Running it

```bash
npm install
npm test        # extract fixture -> Comps.Dat smoke test -> record-parser verification -> SQL ingestion verification
```

`npm test` writes JSON dumps to `/tmp/js_*.json`. To confirm parity against Python, run the
equivalent Python extraction (see `CLAUDE.md`'s "Verification recipe" for the exact snippets) and
diff the two — this has been done for every layer so far and passes with zero mismatches (see
`CLAUDE.md`'s "Status by layer"), but isn't wired into `npm test` as a single command since that
would require a Python environment this JS project doesn't otherwise depend on.
