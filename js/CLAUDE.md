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
- **Object graph / builders / XML emission (`elements.py`, ~5000 lines)**: IN PROGRESS. This is
  the bulk of the remaining work — see `../CLAUDE.md` for how deep and hard-won this logic is
  (comment resolution, BIT-overlay members, dead-member-byte corrections, tag-value-blob-offset
  resolution, NaN/Infinity rendering, STRING latin-1 decoding, ...). Being ported incrementally,
  prioritizing a working end-to-end pipeline for the common cases (scalar/array/UDT tags, RLL
  rungs, basic Module/AOI references) before the long tail of edge cases.
  - **Done so far**: `l5x/render.js` (the module-level rendering/value-decode helpers, Python
    lines ~1-1585: `L5xElement` base class + generic reflection-based `toXml()`, `Member`,
    `DataType`, all the L5K/Decorated value-formatting helpers, and the tag-value decode chain
    `tagValueBlobOffset`/`readTagInitialValue`/`decodeUdtInitialValue`/`decodeSingleUdtElement`/
    `decodeScalarMember`) and `l5x/tag.js` (the `Tag` class + its `toXml()`, Python lines
    ~1587-1891). **api.py's write-back-only helpers (`export_routine`, `export_datatype`,
    `patch_rungs`, the diff/CSV functions) are explicitly OUT OF SCOPE** for this read-only
    converter — confirmed by reading `ConvertAcdToL5x` in `api.py`: it only needs
    `ControllerBuilder.build()` + `ProjectBuilder.build()` + `RSLogix5000Content.to_xml()`, none
    of those write-back helpers. This narrows the real remaining surface considerably.
  - **Verified** against Python with targeted synthetic + real-data tests (not yet a full
    whole-project diff, which needs the builders too): every numeric/string rendering helper
    (`l5kRealLiteral`, `decoratedRealLiteral`, `shortestFloat32Repr`, `l5kStringPadded`,
    `decoratedBinaryLiteral`, `escapeXmlAttr`, `multilineXmlText`), the UDT rendering functions
    (`udtScalarToXml`, `l5kUdtLiteral`, `structMembersXml`, `generateDecorated`, `udtArrayToXml`)
    against a synthetic UDT (DINT/REAL/BOOL[4]/nested-TIMER members), `tagValueBlobOffset` against
    75 real tag records from `CuteLogix.ACD` (parsing their real `RxGeneric` comps records), and
    `Tag.toXml()` end-to-end against 9 synthetic cases (scalar/array primitives, scalar/array UDT,
    Alias, no-value, scalar STRING, with comments) — all exact matches after fixing two real bugs
    found by these tests (see below).
  - **Two real bugs found and fixed by this testing, both worth remembering for any future
    render-layer work**:
    1. `l5kStringPadded`'s `'` → `$'` escape used JS's *string* form of `.replace()`, where `$'`
       is a special replacement pattern meaning "everything after the match" — not a literal
       `$'`. Silently corrupted any text containing an apostrophe (`"it's"` → `"itss"`). Fixed by
       using replacer *functions* (`.replace(re, () => "$'")`) instead of replacement strings,
       which are never special-cased. General lesson: never pass a literal string containing `$`
       as a JS `.replace()` replacement — always use a function.
    2. Every place that needs to distinguish "format this as a REAL/LREAL" from "format this as
       an integer" was checking `Number.isInteger(val)` — which is wrong, because JS numbers
       have no int/float distinction at runtime (`1.0 === 1`), unlike Python where
       `struct.unpack("<f"/"<d", ...)` always yields a `float`-typed value even for an
       exact-whole-number result. This silently misrendered any REAL member/tag whose value
       happened to be a whole number (e.g. `1.0` → bare `"1"` instead of `"1.0"`) — caught by the
       synthetic UDT test's `B: 1.0` (REAL) field. Fixed by adding `isFloatType(dtUpper)` (checks
       the *declared* data type name, exported from `render.js`) and using it everywhere instead
       of `Number.isInteger()` (`udtScalarToXml`'s two sites, `Tag.toXml()`'s two sites). Any
       future rendering code must key float-vs-integer formatting off the known data type name,
       never off a runtime check of the JS number's value.
  - `l5x/elements.js` now also has `LocalTag`, `Parameter`, `Module`, `Routine`, `AOI`, `Program`,
    `ScheduledProgram`, `EventInfo`, `Task`, `Controller`, `RSLogix5000Content` (Python lines
    ~1894-2430). `l5x/port_structures.js`/`port_structures.json` and `l5x/catalog_numbers.js` port
    the two hardware lookup tables `Module` needs — the port-structures data was mechanically
    generated from the Python source into JSON (39 module types, too much to safely
    hand-transcribe) rather than typed by hand; both tables verified as an **exact match** against
    their Python originals (`CATALOG_NUMBERS`/`PORT_STRUCTURES`), and `Module.toXml()` verified
    byte-identical to Python's `Module.to_xml()` for a real CPU module case (1756-L83E, exercising
    the port/bus lookup path).
  - `l5x/sqlutil.js` (`queryAll`/`queryOne`) replaces Python's `cur.execute()`/`fetchall()`/
    `fetchone()` cursor pattern for sql.js. `l5x/builders.js` now has `radixEnum`,
    `externalAccessEnum`, `resolveBitTarget`, `buildMember` (port of `MemberBuilder`),
    `buildDataType` (port of `DataTypeBuilder`), and `applyDeadMemberByteCorrections` (a no-op,
    matching Python's own now-disproven-theory no-op). Builders are plain functions
    `(db, objectId, ...)` rather than dataclass instances (no cursor-attached-to-self convention
    to mirror in JS).
  - **Verified against all 164 real `DataType`s in `CuteLogix.ACD`** (via `RxDataTypeCollection`'s
    children) — full recursive member detail (name, data_type, dimension, radix, hidden,
    BIT-overlay target, bit_number, byte_offset, description) matches Python's
    `DataTypeBuilder.build()` **exactly, zero mismatches**, including every UDT's BIT-overlay
    `Target` resolution (`resolveBitTarget`'s fallback-target-first chain) and hidden/dead-member
    handling.
  - `buildModule` (port of `ModuleBuilder`, including its `_ip_from_data_collection`/
    `_comms_from_data_collection`/`_chassis_size_from_data_collection` helpers, which scrape XML
    fragments out of raw `RxDataCollection` records) is also in `builders.js` now. Uses a
    `latin1Decode()` helper (lossless 1:1 byte↔codepoint mapping) so byte-level substring/regex
    matching on raw records ports directly to JS string operations — equivalent to Python's raw
    `bytes` `in`/`re.search(rb"...")` checks as long as the needle is pure ASCII (always true here).
  - **Verified against all 3 real Modules available across the repo's fixtures** (1 in
    `CuteLogix.ACD`, 2 in `Test_IO.ACD` — the only fixtures with any `RxMapDeviceCollection`
    entries; no fixture here exercises every connection-type code or a remote/bridged chassis) —
    every field (catalog number, vendor/product ids, parent/port, EKey state, slot, IP, backplane
    slot, chassis size, description, CommMethod, connections, extended properties) **and** the
    full `toXml()` output match Python's `ModuleBuilder.build()` exactly. Caveat carried over from
    the Python `CLAUDE.md`: this doesn't exercise bridged/remote racks or every
    `_CONNECTION_TYPE_BY_CODE` value, since no available fixture has one.
  - `buildHexOidMap`/`resolveTagNameFromOid`/`buildTag` (ports of `_build_hex_oid_map`/
    `_resolve_tag_name_from_oid`/`TagBuilder`, the single largest individual builder at ~260
    lines) are now in `builders.js` too — covers scalar/array/UDT tag decoding, Alias tag target
    resolution (including the `@HEXOID@` path-walking logic), hex-OID comment resolution, and the
    full comment-path normalization rules.
  - **A real bug found and fixed by testing** (not present in any isolated unit test, only showed
    up against real tag data): the two early-return `new Tag(...)` calls for unparseable/
    non-tag records had `tagType` accidentally set to the tag's own name instead of the literal
    `"Base"` (an argument-position slip, not a logic error) — caught immediately by comparing
    against Python's `TagBuilder.build()` on real data, not by isolated construction.
  - **Verified against all 148 real tags in `CuteLogix.ACD`** (every `cip_type` 0x68/0x6B comps
    record) — every field (name, tag_type, data_type, radix, external_access, constant,
    dimensions, target, data_table_instance, normalized comments, decoded initial_value) matches
    Python's `TagBuilder.build()` **exactly, zero mismatches**.
  - `buildParameter`/`buildLocalTag` (AOI parameter/local-tag builders) and `buildRoutine` (+
    `routineTypeEnum`, `parseFffeff`, `stRoutineLines`, `lookupObjectDescription`) are also in
    `builders.js` now. `buildRoutine` covers RLL rung text (including `&hexid:` module-reference
    resolution), rung-comment attribution via the `regnlink_idx`/`regnlink` tables (the
    hard-won mechanism documented at length in `../CLAUDE.md`'s "Rung comments" section), routine
    descriptions, and ST routine bodies (`stRoutineLines`, walking the `nameless` parent tree).
  - **Verified against all 29 real routines across every `RxRoutineCollection` in
    `CuteLogix.ACD`** (both AOI logic routines and regular program routines) — name, type, rung
    text, rung ids, rung comments, description, ST lines, and full `toXml()` output all match
    Python's `RoutineBuilder.build()` **exactly, zero mismatches**. (No ST routines exist in this
    fixture, so `stRoutineLines` ran but wasn't exercised with real ST content — flagging this the
    same way the Python `CLAUDE.md` flags fixture-coverage gaps elsewhere.)
  - `buildAoi` (+ `filetimeToIso`, `parseAoiNameless`), `buildProgram`, and `buildTask` are also in
    `builders.js` now. `buildProgram` includes the second pass that decodes a UDT-typed tag's
    initial value once `data_types_map` is available (via `decodeUdtInitialValue`, already
    verified separately in the render-layer work).
  - **Verified against real data**: the single real AOI available in any fixture
    (`ACDTestsWithAOI.ACD`, `CuteLogix.ACD` itself has none) matches Python's `AoiBuilder.build()`
    exactly, including the full `toXml()` output; all 3 real Programs and 2 real Tasks in
    `CuteLogix.ACD` match `ProgramBuilder.build()`/`TaskBuilder.build()` exactly (zero mismatches
    across every field, including scheduled-program names resolved through the comment_id→program
    map). `buildProgram`'s UDT-initial-value second pass ran but wasn't exercised with a real
    UDT-typed program tag in this pass — worth a targeted check in a future session if one turns
    up in a richer fixture.
  - **`ControllerBuilder` and `ProjectBuilder` are now ported too** (`buildController` in
    `builders.js`, `buildProject`/`buildProjectContent` in the new `l5x/project.js`). This
    completes the entire object-graph/XML-emission layer — `elements.py` is now fully ported.
    `buildProject` parses `QuickInfo.XML` (UTF-16LE-encoded) with a small regex-based attribute
    extractor rather than a full XML parser, since the only elements needed
    (root/`SchemaVersion`/`SWVersion`/`DeviceIdentity`) are simple self-closing tags — keeps this
    port dependency-light.

  ### Milestone: full whole-project `<Controller>` XML now byte-for-byte identical to Python

  Verified against **all 4 local fixtures with real controller content**
  (`CuteLogix.ACD`, `Test_IO.ACD`, `ACDTestsWithAOI.ACD`, `ACDTestsNonRedundant.ACD`): the
  complete `Controller.toXml()` output — every data type, tag (with decoded initial values),
  program, routine, task, module, and AOI — is **byte-for-byte identical** to Python's
  `ControllerBuilder.build().to_xml()` for every one of them (`CuteLogix.ACD` alone is 147,023
  characters, zero differences). This is the strongest verification in this port so far: it
  doesn't just check individual builders in isolation, it checks the fully-assembled real output.

  **Two more real bugs found and fixed reaching this milestone** (both the same underlying root
  cause as the `isFloatType` bug documented above — JS's lack of an int/float runtime
  distinction — but manifesting in two new, non-obvious places a synthetic unit test would never
  have caught; only a full real-project XML diff surfaced them):

  1. **`decodeSingleUdtElement`'s BIT-overlay extraction pass wrongly bit-shifted a REAL-typed
     target.** The code assumed (following the TIMER/COUNTER pattern) that a BIT-overlay member's
     backing field is always an integer (`typeof targetVal === "number"`, matching Python's
     `isinstance(target_val, int)` — except in JS every float is also `typeof "number"`). A real,
     built-in Rockwell `PID` structure has BIT flags (`EN`/`CT`/`CL`/`PVT`/`DOE`/`SWM`/`CA`/`MO`/
     `PE`/`NDF`/`NOBC`/`NOZC`/`INI`/`SPOR`/`OLL`/`OLH`/`EWD`/`DVNA`/`DVPA`/`PVLA`/`PVHA`) whose
     target is `"SP"` — a REAL member. Python's `isinstance` check correctly excludes this (a
     Python float is never `int`), so these 21 keys never appear in Python's decoded dict at all;
     my JS version was bit-extracting IEEE-754 float bits and adding 21 phantom keys. Found via a
     real tag (`PID_Master`, `PID`-typed) in `CuteLogix.ACD` whose decoded `initial_value` dict had
     21 extra keys compared to Python's. Fixed by looking up the **target member's own declared
     type** (`PRIM` + `!isFloatType`) instead of checking the runtime value's `typeof` — only a
     scalar integer-primitive target is eligible for bit extraction, matching exactly which
     Python values are `int` vs `float`/`list`/`dict`.
  2. **A rarer, more subtle variant of the same class**: Python's `_decode_scalar_member`/
     `_read_tag_initial_value` both return a **plain Python `int` 0** — never a `float`, no matter
     the member's declared type — when a computed byte offset falls outside the tag's actual data
     blob (an out-of-bounds/truncated read, e.g. from a deeply-nested Motion/Axis structure like
     `AXIS_VIRTUAL` whose declared size exceeds the real data available). Downstream, Python's
     `isinstance(val, float)` check then renders this as bare `"0"`, not `"0.0"`, **even for a
     REAL/LREAL member** — the opposite direction from bug #1 above (there JS over-eagerly treated
     an int-like value as float-worthy; here it's the reverse: JS's `isFloatType(declaredType)`
     check would treat this fallback zero as a genuine float and wrongly render `"0.0"`). Since JS
     has no way to tag "this specific number came from an int fallback path" on the value itself,
     fixed by using **`-0` (negative zero) as an internal sentinel** for this one fallback case
     specifically (`decodeScalarMember`'s and `readTagInitialValue`'s out-of-bounds branches now
     `return -0` instead of `0`) — `-0 === 0` and `Boolean(-0) === false` everywhere else
     (arithmetic, truthiness, JSON, L5K rendering — Python's own L5K path doesn't check
     `isinstance` at all, always formatting REAL/LREAL by declared type, so no L5K-side fix was
     needed), so this is invisible everywhere except the four Decorated-XML rendering call sites
     that now check `isGenuineFloat(declaredType, val)` (`isFloatType(...) && !Object.is(val, -0)`)
     instead of bare `isFloatType(...)`. Found via the same `CuteLogix.ACD` full-XML diff, isolated
     to tag `VAxis` (`AXIS_VIRTUAL`-typed)'s `ActualPosition` member.

  **Lesson worth restating a third time in this file** (the Python `CLAUDE.md` makes the identical
  point repeatedly about its own byte-offset bugs): a fix that resolves the specific symptom found
  isn't proof the underlying pattern is fully handled everywhere it appears. Both bugs above are
  instances of the *same* root cause (JS's `typeof x === "number"` conflates Python's `int`/`float`
  distinction) that had already been fixed once (the `isFloatType` fix in the render-layer
  milestone) — but that first fix only covered the *known-value* rendering path, not the
  *decode-time fallback* paths, which needed their own, differently-shaped fix. Any *new* rendering
  or decoding code that formats a numeric value by REAL/LREAL-ness must go through
  `isGenuineFloat`/the declared-type check, never a bare runtime `typeof`/`Number.isInteger` test —
  and should be re-checked against a real whole-project diff, not just a synthetic sample, since
  both of these were invisible to every earlier targeted test and only surfaced this way.

  **What "fully ported" here does and doesn't mean**: this milestone confirms every builder is
  wired together correctly, but the port's exercised real fixture *coverage* has known gaps carried
  over from earlier notes in this file — no ST routine content, no connection-type code beyond
  5/6/7/23/48, no bridged/remote rack, only one real AOI available. Treat "verified" as "verified
  for what these four fixtures exercise," the same caveat the Python `CLAUDE.md` applies to its own
  verification claims.

## Pipeline entry point (`convert.js`) — full ACD → L5X now works end to end

`convertAcdToL5x(acdBytes)` (port of `api.py`'s `ConvertAcdToL5x`) wires `ingestAcd` →
`buildController` → `buildProjectContent` → `.toXml()` together and returns the complete L5X XML
text with its declaration prepended — the same shape Python's `ConvertAcdToL5x(...).extract()`
writes to a file, just returned as a string instead (no filesystem dependency, so this works
unchanged in a browser). Pretty-printing (Python's optional `xml.dom.minidom`-based indentation)
is intentionally **not** ported — it's cosmetic only (Studio 5000 imports either form identically,
already relied on elsewhere in this repo's own verification), and skipping it avoids pulling in an
XML-parsing dependency for a purely cosmetic feature.

**Verified end-to-end against all 4 local fixtures with real controller content**: the full
`convertAcdToL5x()` output matches Python's `ConvertAcdToL5x(...).extract()` output **exactly**,
modulo the `ExportDate` attribute (both sides stamp "now" at build time — inherently
non-reproducible between two separate runs, not a bug; `formatNowWeekdayString()` matches Python's
`datetime.now().strftime("%a %b %d %H:%M:%S %Y")` format convention, using local time like
Python's naive `datetime.now()`, not UTC, unlike the FILETIME-derived dates elsewhere which
correctly use UTC). `CuteLogix.ACD`'s full L5X is 147,362 characters on both sides.

This closes out the whole read pipeline (container → records → SQL → object graph → XML).

## Browser UI (`build.js`/`ui.js`/`test_browser.js`) — the whole thing runs as an offline web page

`build.js` (dev-only, run via `node build.js` / `npm run build`) assembles every module above
into one self-contained `dist/acd-to-l5x.html` — **this file is the actual shipped deliverable**,
tracked in git despite the repo's general `dist/` ignore rule. No bundler dependency (webpack/
esbuild/etc.) was introduced; instead it's a small hand-rolled CommonJS-in-the-browser shim
(`__require`/`__modules` in the emitted `<script>`) that runs every existing, already-verified
Node module **completely unmodified** — their own `require()`/`module.exports` lines are embedded
as-is. The shim resolves relative specifiers (`"./render"`, `"../generated/RxGeneric"`) against
each module's own id and maps the three external package names (`"kaitai-struct"`, `"pako"`,
`"sql.js"`) to the UMD/global runtimes loaded via preceding `<script>` tags
(`kaitai-struct/KaitaiStream.js`, `pako`'s UMD browser build, and **`sql.js`'s `sql-asm.js`
variant specifically** — the plain-asm.js build with no separate `.wasm` file to fetch, keeping
the whole thing offline/single-file with zero network requests).

**One real portability bug found and fixed getting this to actually load in a browser** (not
caught by any Node-side test, since Node has these globals and the browser doesn't):
`parseDat.js` had `const fs = require("fs");` at module top level — harmless in Node, but since
this same file is embedded verbatim in the browser bundle, that line executed the instant the
page loaded (as soon as anything required `"./ingest"` → `"./parseDat"` transitively, which the
UI bootstrap does immediately), throwing `Error: Node-only module 'fs' is not available` before
the file input was even touched. Fixed by moving `require("fs")` inside `parseDatFile()` itself
(the one Node-only convenience function that actually uses it, never called from the browser
code path) instead of at module top level — the general lesson: any module meant to be embedded
in the browser bundle must only reference Node-only globals (`fs`, `path`, `require.resolve`)
*lazily inside functions that are never called from the browser path*, never at top level, since
the shim executes every module's top-level code eagerly on first require regardless of environment.
A second, related fix: `ingest.js`'s `initSqlJs({ locateFile: ... })` call used
`require.resolve(...)` (Node-only) unconditionally; guarded behind an `isNode` check
(`typeof process !== "undefined" && process.versions.node` — NOT a `typeof require` check, since
the browser shim's own injected `require` function makes `typeof require === "function"` true in
both environments) so the browser path calls `initSqlJs({})` with no `locateFile` at all (the
embedded asm.js build never needs to fetch anything external).

**Verified working in a real browser**: `test_browser.js` (Playwright, the pre-installed headless
Chromium at `/opt/pw-browsers/chromium`) loads the built HTML, feeds it each of the 4 local
fixtures with real controller content via the actual file-input element, and captures the
downloaded `.L5X` — **byte-for-byte identical to Python's `ConvertAcdToL5x` output** (modulo
`ExportDate`) for all 4, confirming the entire pipeline (container extraction, binary record
parsing, SQL ingestion via sql.js's asm.js build, object-graph construction, XML emission) runs
correctly end-to-end inside an actual browser page, not just under Node.

**Scope note**: `test_browser.js`/`build.js` are dev tooling, not shipped — only
`dist/acd-to-l5x.html` is the deliverable. `playwright` is a devDependency for this verification
only, not needed to use the converter itself.
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
