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
- `test_parse.js` / `verify_records.js` — smoke tests / dev verification harness (dump parsed
  tuples to JSON for diffing against the equivalent Python output — not part of the shipped app).

Not yet present: the SQL ingestion layer (`sql.js`-backed port of `acd/l5x/export_l5x.py`), the
object-graph builders and XML emission (`acd/l5x/elements.py`), the pipeline entry point
(`acd/api.py`), or the browser UI. See `CLAUDE.md` for current status on each.

## Running it

```bash
npm install
npm test        # extract fixture -> parse Comps.Dat smoke test -> full record-parser verification
```

`npm test` runs `verify_records.js`, which parses all four `.Dat` files from the fixture ACD and
writes the resulting tuples to `/tmp/js_*.json`. To confirm parity against Python, run the
equivalent Python extraction (see `CLAUDE.md`'s "Verification recipe" for the exact snippet) and
diff the two — this has been done and passes with zero mismatches as of the last update to
`CLAUDE.md`, but isn't automated as a single command yet (no Python dependency is assumed here).
