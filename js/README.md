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

- `l5x/render.js` / `l5x/tag.js` / `l5x/elements.js` / `l5x/builders.js` / `l5x/project.js` —
  the full object-graph builders and XML emission layer (port of `acd/l5x/elements.py`): every
  `*Builder` class, all L5X element classes, and the L5K/Decorated value-rendering engine.
  **`buildController(db)` produces a complete `Controller` object whose `.toXml()` output is
  byte-for-byte identical to Python's `ControllerBuilder.build().to_xml()`** for every local
  fixture with real controller content — see `CLAUDE.md` for the verification detail and two
  real bugs found reaching this milestone.

Not yet present: the pipeline entry point (wiring `ingestAcd` + `buildController` +
`buildProjectContent` together, mirroring `acd/api.py`'s `ConvertAcdToL5x`) and the browser UI.
See `CLAUDE.md` for current status.

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
