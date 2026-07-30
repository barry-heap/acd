# js/ — ACD → L5X browser converter port — Claude Code entry point

This file is for AI agents working on **this JS port specifically**. For the overall goal and
scope, see the task spec that kicked this off (browser-based ACD→L5X, no write-back, fully
client-side) and `../CLAUDE.md` (the Python reference implementation's own internals doc — this
port mirrors its architecture and inherits all of its hard-won byte-offset knowledge). For
running/using what exists so far, see `README.md` in this directory.

## Ground rule: the checked-in Python `acd/generated/*.py` is the ground truth, not the `.ksy` files

**Real, confirmed finding**: `resources/templates/Comps/FAFA_Comps.ksy` (the checked-in "source"
template) does not match the checked-in, actually-used `acd/generated/comps/fafa_comps.py` — the
`.ksy` says `record_buffer: size: record_length - 144 - 4`, but the real Python parser (which the
whole test suite and every real-project verification in `../CLAUDE.md` is built on) reads
`record_length - 144`, with no extra `-4`. The `acd-l5x-js-poc.zip` this port started from was
compiled straight from that stale `.ksy` via `kaitai-struct-compiler`, so `generated/FafaComps.js`
inherited the same bug — confirmed empirically: for a real record, outer buffer length 226 →
embedded `record_length` field 222 → the true `record_buffer` must be `222 - 144 = 78` bytes
(verified this is what Python actually produces), not `222 - 144 - 4 = 74`.

**Fixed** in `generated/FafaComps.js` (one line, see the comment there). **Lesson for future
work**: don't trust `resources/templates/*.ksy` as a spec for anything — it may have drifted from
what's actually shipping. Always cross-check a generated parser's exact byte math against the
real `acd/generated/**/*.py` file, field by field, using the verification recipe below, before
trusting it. Four of the six `generated/*.js` files were checked this way and found to already
match Python exactly (`Dat.js`, `FdfdComps.js`, `RxGeneric.js`, `FafaSbregions.js`); only
`FafaComps.js` had this one bug. `FafaComents.js` (Comments.Dat) was not relied on at all —
`record/comments.js` bypasses it entirely (see below).

## Verification recipe (used throughout, and to be reused for every future layer)

For any ported layer, don't just check it runs — diff its actual output against Python's, field
by field, on the real `resources/CuteLogix.ACD` fixture (extracted once via `node extract.js`,
shared by both sides so the input bytes are identical):

1. Write a small Node script that parses with the JS port and dumps tuples/objects to a JSON
   file (base64-encode any raw byte buffers so they compare exactly).
2. Write the equivalent Python one-liner (using a `venv` with `pip install -e ".[dev]"` from the
   repo root) dumping the same shape to a second JSON file.
3. `python3 -c "import json; a=json.load(open(...)); b=json.load(open(...)); ..."` and diff.

This caught the `FafaComps.js` bug above (a smoke test that only checks record *counts* would
never have caught it — the counts were already right, only the sub-record content was wrong).
Always compare on the full real dataset, not just a handful of records, before declaring a layer
done — a bug can hide in a code path a small sample never exercises (this is a running theme in
`../CLAUDE.md` too: e.g. the tag-value-blob-offset bug that only showed up on 2 of ~350 array
tags in one earlier sample).

## Status by layer

- **Container extraction (`unzip.js`)**: done, verified byte-identical to Python's `Unzip`
  (MD5 of all 25 extracted files from the fixture).
- **Raw record framing (`generated/Dat.js`)**: done, verified (header fields + record-identifier
  histogram exact match).
- **Per-file record shapes (`generated/{FafaComps,FdfdComps,RxGeneric,FafaSbregions}.js`)**:
  done, verified field-for-field including raw `record_buffer` bytes, on the *full* real dataset
  (all 7074 FAFA + 205 FDFD Comps.Dat records checked, zero mismatches after the fix above).
- **`record/comps.js`, `record/sbregion.js`, `record/comments.js`, `record/nameless.js`**: done
  — direct hand-ports of `acd/record/*.py`, verified against the full fixture: 7074 comps rows
  (post-dedup-by-object_id, same "keep largest record" rule as Python), 133 rungs, 335 comments,
  186 nameless rows — **zero mismatches** against Python's own tuples.
  - `record/comments.js` deliberately does **not** use `generated/FafaComents.js`'s Kaitai
    dispatch — that compiled parser only covers a subset of real `record_type` values (1, 2, 3,
    4, 13, 14, 23, 25), and Python's own `acd/record/comments.py` hand-parses many more types
    directly from raw bytes (5, 6, 7, 8, 11, 15, 16, 17, 19, 21, 24, 29, 30, 37, 39, plus the
    UDI/type-12 RevisionNote case) rather than going through Kaitai for those. Porting
    `comments.py`'s exact per-type byte offsets directly (documented inline in
    `record/comments.js`, cross-referenced against `../CLAUDE.md`'s "Comment / description
    resolution" section) was simpler and more robust than trying to extend the Kaitai dispatch.
  - Not yet ported: `_normalize_comment`'s bracket-repair regex and the `seen[key]` dedup-by-
    `(parent, tag_reference, scope_id, rung_content)` step from `export_l5x.py` — these belong to
    the next layer (SQL ingestion), not the record parser itself, and aren't done yet either.
- **SQL ingestion layer (`ingest.js`, `sql.js`-backed port of `export_l5x.py`'s
  `ExportL5x.__post_init__`)**: done, verified. All 8 tables (`comps`, `pointers`, `rungs`,
  `region_map`, `comments`, `nameless`, `regnlink`, `regnlink_idx`) match Python's own
  `ExportL5x` table contents on the full fixture, **zero mismatches**, including the `comments`
  table's dedup step (335 raw comment records → 31 after the `(parent, tag_reference, scope_id,
  rung_content)` dedup-keep-longest rule — same 31 on both sides) and `populate_region_map`/
  `populate_regnlink`'s hand-rolled byte parsing (133 region_map rows, 192 regnlink rows, 146
  regnlink_idx rows, all matching). `pointers` is intentionally always empty — confirmed via
  `grep` that Python's own pipeline creates but never populates or queries it either (dead
  table in the reference implementation, not a JS omission).
  - `ingestAcd(acdBytes)` is the entry point: takes the whole `.ACD` file as a `Uint8Array`/
    `Buffer`, returns `{ db, rawFiles, fileOrder, idToName }` (a `sql.js` `Database`, plus the
    extracted-files map / original file order / object_id→name lookup, carried through for a
    potential future write-back feature the way Python's `ExportL5x` does — not otherwise used
    by this converter, which is read-only).
  - `verify_ingest.js` is the reusable dev harness for this layer (dumps every table to
    `/tmp/js_ingest_full.json`); the matching Python-side snippet (not checked in, since it
    needs the `venv` from the repo root) constructs `ExportL5x(acd_path, _temp_dir=tmp)` and
    dumps the same 7 tables/columns, sorted the same way, to compare.
  - `unzip.js` was refactored to be isomorphic during this layer's work: it now takes raw bytes
    directly (not a file path) and exposes `extractAll() -> Map<filename, Uint8Array>` using
    `pako` for gzip instead of Node's `zlib` (`writeFiles(dir)` stays as a thin Node-only
    wrapper around `extractAll()` for `extract.js`'s dev/fixture use). Re-verified byte-identical
    extraction after this change.
- **Object graph / builders / XML emission (`elements.py`, ~5000 lines)**: not started. This is
  the bulk of the remaining work — see `../CLAUDE.md` for how deep and hard-won this logic is
  (comment resolution, BIT-overlay members, dead-member-byte corrections, tag-value-blob-offset
  resolution, NaN/Infinity rendering, STRING latin-1 decoding, ...). Expect this to be ported
  incrementally, prioritizing a working end-to-end pipeline for the common cases (scalar/array/UDT
  tags, RLL rungs, basic Module/AOI references) before the long tail of edge cases documented
  there.
- **Pipeline entry point (`api.py`'s `ConvertAcdToL5x`)**: not started.
- **Browser UI**: not started.

## Dependencies

- `kaitai-struct` (npm) — used purely as a byte-reading runtime (`KaitaiStream`) for the
  `generated/*.js` modules. No Java/build-step dependency ships to the browser;
  `kaitai-struct-compiler` was only ever a build-time tool used once, externally, to produce the
  checked-in `generated/*.js` files (see the ground-rule section above for why those need
  spot-checking, not blind trust). Everything in `record/*.js` and `ingest.js` is hand-written
  using plain `DataView`, no generated-code dependency.
- `pako` — pure-JS gzip, used by `unzip.js` for decompressing gzip'd container members. Works
  in both Node and the browser (unlike Node's `zlib`, which `unzip.js` used before being made
  isomorphic).
- `sql.js` — SQLite compiled to WASM, used by `ingest.js` for the relational ingestion layer
  (same schema/queries as Python's `sqlite3`-backed `ExportL5x`). Works in both Node (used for
  all verification so far) and the browser; the browser build will need to fetch the `.wasm`
  asset (`sql-wasm.wasm`) — inline it as a base64 data URI or ship it alongside the single HTML
  file when building the actual UI, to keep the "single file, no build step" property. Not
  addressed yet — deferred to the wrapper-UI task.

All three are pure-JS/WASM with no native bindings, no Java, and no server dependency.
