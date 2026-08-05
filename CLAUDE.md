# acd-tools — Claude Code Entry Point

This file is for AI agents (Claude Code, OpenCode, etc.) working **on this repository's own
source code** — i.e. maintaining/extending the ACD parser itself. For user-facing API docs
and usage examples, see `README.md` instead; this file is about internals, gotchas, and how
to safely make changes here.

## Purpose

`acd-tools` parses Rockwell `.ACD` project files (Studio 5000 / RSLogix 5000) directly from
their proprietary binary format — no Studio 5000 installation or L5X export required — and
exposes the contents as Python objects (`Controller`, `Tag`, `Program`, `Routine`, `DataType`,
`AOI`, `Module`, ...). It can also serialize the parsed project back to L5X XML, and patch
rung text back into a working `.ACD` file.

The `.ACD` file is a zip-like archive containing several proprietary binary databases:
`Comps.Dat` (all project objects: tags, datatypes, programs, modules, AOIs, ...),
`SbRegion.Dat` (ladder rung text), `Comments.Dat` (tag/element descriptions and comments),
`Nameless.Dat`, plus `QuickInfo.XML` / `TagInfo.XML` (some metadata is in ordinary XML).

## Commands

```bash
pip install -e ".[dev]"
pytest                    # runs from repo root; test/conftest.py chdir's into test/ automatically
```

- Run a single test: `pytest test/test_elements_helpers.py -q`
- The sample fixture ACD used throughout the test suite is `resources/CuteLogix.ACD` (paths
  in test files are relative to `test/`, e.g. `"../resources/CuteLogix.ACD"` — this works from
  any invocation directory because of the `conftest.py` autouse fixture).
- Formatting: `black` (via pre-commit, see `.pre-commit-config.yaml`).

## Architecture

```
acd/
├── api.py                  # Public API (load_acd, save_acd, patch_rungs, ImportProjectFromFile, ...)
├── l5x/
│   ├── export_l5x.py       # ACD zip -> extracted .Dat files -> SQLite tables -> ControllerBuilder
│   └── elements.py         # Dataclasses (Tag, Program, DataType, ...) + *Builder classes that
│                            #   read from the SQLite cursor and construct them (~3600 lines)
├── database/                # Generic binary .Dat file reader (DbExtract, DatRecord)
├── record/                  # Per-database-file record parsers (CompsRecord, SbRegionRecord,
│                            #   CommentsRecord, NamelessRecord) — thin wrappers that call into
│                            #   acd/generated/ Kaitai parsers and normalize into SQL row tuples
├── generated/                # Kaitai Struct (.ksy) generated binary parsers (do not hand-edit;
│                            #   see "Developing" in README for regeneration)
├── integrity/                # FileInfo.Dat checksum / project-key handling (SDK compatibility)
└── zip/                      # ACD container (un)zipping and rewriting
```

**Data flow:** `ExportL5x.__init__` unzips the ACD, reads each `.Dat` file via `DbExtract`,
runs each raw record through its `record/*.py` parser, and bulk-inserts the normalized tuples
into an in-memory-ish SQLite DB (`comps`, `rungs`, `region_map`, `comments`, `nameless`,
`regnlink`, `regnlink_idx` tables).
`ControllerBuilder` (in `elements.py`) then queries that SQLite DB to build the full object
graph. Builder classes (`TagBuilder`, `ProgramBuilder`, `DataTypeBuilder`, `AoiBuilder`, ...)
all follow the same pattern: take a cursor + `object_id`, `SELECT` the raw record, parse fixed
byte offsets out of it (via `struct.unpack_from`), and construct the corresponding dataclass.

**Everything is binary-offset-driven, not name-driven.** A new/unfamiliar UDT, tag, or AOI
needs zero code changes to parse correctly — `DataTypeBuilder`/`MemberBuilder` read `dimension`,
`data_type`, `bit_number`, etc. from fixed offsets in the raw record for every UDT, whatever
it's called, including Rockwell "ProductDefined"/module-defined types and string-family types
(`STRING`, or a custom type like `STRING_20` detected via the `family` flag, never by matching
the type's own name — a type could just as easily be named `ASCII_TWENTY`). The **only**
name-based heuristics anywhere in the parsing pipeline are:
- `ControllerBuilder`'s I/O comment-resolution block (`elements.py`, search for `"FAULT",
  "STATUS"`), which excludes members literally named `Fault`/`Status` when guessing which
  member of an I/O module's UDT is "the data member" for legacy bit-comment resolution —
  scoped narrowly to that one use case, not to tag/UDT typing in general.
- `ModuleBuilder`'s connection-type name-heuristic fallback (see `_CONNECTION_TYPE_BY_CODE`),
  used only when a connection record's type-code byte is unrecognized or the record is too
  short — the primary path reads a real binary enum (see below), logging a warning when it
  falls back so unrecognized codes don't silently get mis-guessed.

**When you find a classification that currently has to guess from a name** (like the
connection-type heuristic did until it was replaced), look harder for a real discriminating
byte/flag before accepting the heuristic as final — see "Connection Type" below for the method
that worked, and consider adding a `log.warning()` (loguru, already used in this file) on the
fallback path so future unrecognized cases are visible instead of silently mis-guessed.

## Comment / description resolution — read this before touching `comments.py` or `_comments`

This is the trickiest, most bug-prone part of the codebase. `Comments.Dat` stores per-tag and
per-element/per-bit descriptions (what Studio 5000 shows as `<Comment Operand="...">` in an
L5X, or the tag's `<Description>`). Getting the full address (`Tag[3].Flags.2`, `Tag.Member.Bit`,
`Local:10:I.Data.13`, etc.) right requires resolving several layers of indirection:

1. **Container key.** Each tag's comments are found via `parent = (comment_id << 16) | cip_type`,
   where `comment_id`/`cip_type` are read from the tag's own comps record (`RxGeneric`).
2. **Scope collisions.** Multiple *unrelated* tags can share the exact same `(comment_id,
   cip_type)` key (e.g. tags that never got their own unique `comment_id` assigned — this can
   affect hundreds of tags in a single large project). **`comments` table has a `scope_id` column**
   (a 2-byte discriminator at absolute byte offset 16 in both the tag's own raw record and every
   comment record) that must be matched in addition to `parent`, or comments from completely
   different tags get merged together and mislabeled. `TagBuilder` already does this — if you
   add any *new* query against the `comments` table, make sure to filter by `scope_id` too.
3. **Record types.** `Comments.Dat` uses several different binary record layouts depending on
   what's being described (see `record_type` handling in `acd/record/comments.py`):
   - `1`/`2` (AsciiRecord): whole-tag/whole-object descriptions and rung comments.
   - `3`/`4`/`13`/`14` (Kaitai `Utf16Record`): standard structured Kaitai-dispatched types.
   - `5`/`6`/`7`/`8`/`11`/`15`/`19`/`24`/`29`/`30`/`37`/`39`: array/bit operand descriptions with
     an identical hand-parsed layout (`unknown(8, scope_id at [2:4]) + obj_id(u4 at [8:12]) +
     unknown(4) + utf16 tag_ref + ascii text`) — **not** dispatched by the Kaitai `.ksy` file,
     parsed by hand in `comments.py`. This list was built incrementally by finding real examples
     of each shape in an actual project and confirming the byte layout matched; if you find a
     new numbered type with this same byte shape (8-byte header, obj_id at offset 8), just add
     it to this tuple — don't assume the list above is exhaustive, more probably exist.
     `tag_reference` can be an arbitrarily long chain of `!HEXOID` references (one per nesting
     level) plus array indices (including multi-dimensional, comma-separated: `[2,2,1]`) and a
     trailing bit number, e.g. `"[1].!HEXOID1[1].!HEXOID2.9"` for
     `Tag[1].Member1[1].Member2.9` — already handled correctly by the existing multi-match
     hex-OID regex once the record type itself is recognized; no per-shape resolution logic
     needed, just recognize the type.
   - `19` is **overloaded**: most instances are genuine tag comments (as above), but some carry
     AOI edit-history metadata instead (a literal `tag_reference` of `"UDI_LAST_EDITED_BY"` with
     a username/computer string as the text, parallel to the `12`/`UDI_HISTORY` handling below).
     Verified these don't collide with any real tag's `(parent, scope_id)`, so no extra
     filtering was added — but re-check this if you ever see a `UDI_LAST_EDITED_BY` string leak
     into `Tag._comments`.
   - `16`/`17`: similar but with `obj_id` at a different offset (6, not 8).
   - `12`: UDI metadata (AOI RevisionNote) — different, unrelated layout.
4. **Hex-OID resolution.** References like `!06DC4E61` or `.!06DC4E61.!0751B500` are object IDs
   into `RxTypeMemberCollection`; `_build_hex_oid_map()` in `elements.py` resolves them to member
   names. This map is built **globally per-project**, not scoped to the specific tag's own
   DataType — a theoretical (not yet observed) risk if two unrelated members ever share an OID.
5. **Path normalization** (`TagBuilder.build()`, the `normalized = []` loop in `elements.py`):
   stitches the tag name + resolved ref into a final address string. Watch out for:
   - Refs that already carry their own leading `.` (from `.!HEXOID` resolution) — don't add a
     second dot (`sep = "" if ref.startswith(".") else "."`).
   - Multi-digit array indices — any regex touching bracket/digit patterns here (see
     `ExportL5x._normalize_comment`'s bare-`"N]"` → `"[N]"` fix) must use a lookbehind that
     excludes *both* `[` and digits, or it can match mid-way through a 2+-digit number and
     corrupt it (this was a real regression: `(?<!\[)` alone matched inside `"[10]"`, producing
     `"[1[0]"`).
   - Comma-separated multi-dimensional indices (`[2,2,1]`) — the same lookbehind must *also*
     exclude a comma, or it mis-fires on the last component of an already-correct index (`"1]"`
     preceded by `,` looks just like a bare missing-bracket case otherwise), corrupting
     `"[2,2,1]"` into `"[2,2,[1]"`.
   - String-family values (`STRING`, or a custom type like `STRING_20`) are represented
     identically at every nesting level — top-level tag, array element, or a member nested
     inside another struct — as `{"LEN": int, "DATA": str}`, rendered as a `Structure`/
     `StructureMember` with separate `LEN` (DINT) and `DATA` (ASCII) `DataValueMember`s. Never
     represent a string value as a bare/flat string internally — every consumer (XML rendering,
     comment-path matching for `.DATA[N]`/`.DATA[N].bit`) expects this dict shape, verified
     against a real non-blank custom string-family array tag. The `DATA` member's own text
     content is further wrapped as `<![CDATA['text']]>` (quoted L5K-style literal) when
     non-empty, or bare `<![CDATA[]]>` (no quotes) when empty — see `_string_literal_cdata()`.

6. **L5X `<Comments>` emission** (`_build_comments_xml()` in `elements.py`, called from
   `Tag.to_xml()`): renders every non-empty-path entry in `tag._comments` as a standalone
   `<Comments><Comment Operand="...">` block, positioned after `<Description>` and before
   `<Data>` — verified against a real project to be the correct position/shape. `Operand=` is
   the path with the tag name prefix stripped and the remainder **fully upper-cased** (e.g.
   `Operand=".GAIN"`, `Operand="[2,2,1].BFRLUG.Z5_SAWPATTERN.3"`), even though member names keep
   their original casing everywhere else in the document. The comment text itself is **not**
   collapsed to one line the way `.description`/`<Description>` is — multi-line text is
   preserved as-is inside the CDATA. There used to be a second, separate mechanism
   (`_build_elem_comments`) that embedded `<Comment>` as an inline child of an array `<Element>`
   node; it was removed after confirming **zero** such occurrences in a real project's L5X —
   array-element/bit comments only ever appear in the standalone `<Comments>` block.
7. **AOI InOut-parameter binding metadata masquerading as a comment.** When a UDT member's
   DataType is itself an AOI (e.g. a `VFD` member typed as AOI `VAB_PowerFlex_753`), Rockwell
   records which of that AOI's InOut parameters is wired up using the *exact same* Comments.Dat
   record shape as a real per-element comment: the ref resolves to the whole member (e.g.
   `.VFD`), and the text is literally the AOI's own parameter name (e.g. `"Ethernet_Module"`).
   This is not a user-authored description — verified against a real project, the same text
   recurs identically across every tag instance of several different UDTs, regardless of the
   owning tag's own identity, and it never appears in Studio 5000's own L5X `<Comments>` output.
   `ControllerBuilder.build()` strips these (after `aois`/`data_types` are both available) with
   a narrow rule: a comment is dropped only if it's a whole-member reference (no bit/array
   suffix) **and** that member's own DataType is an AOI **and** the text exactly matches one of
   that AOI's own parameter names verbatim. If you ever see a real user comment go missing on an
   AOI-typed member, check whether it happens to collide with that AOI's parameter names first.

**When verifying comment/description output, don't trust any pre-built "reference" JSON/index
a downstream project might hand you** (e.g. something like `ref.json` derived from an L5X/CSV
by another script) **blindly** — it's typically hand-built by a separate AI/script pass and can
silently encode the very same bugs it's meant to catch. It may also not exist at all, or be
stale relative to the ACD you're actually testing against. The only trustworthy ground truth is
a real Studio 5000 export: an L5X's `<Comment Operand="...">` / `<Description>` elements, or a
Studio 5000 "Export Tags" CSV's `COMMENT`/`TAG` rows. Don't assume either is already present in
the working directory — if you need to verify comment/description output and don't have one,
ask the user to export a fresh L5X (File > Save As / Export) and/or tag CSV report from Studio
5000 for the specific ACD under test.

**Pitfalls when writing your own script to diff generated output against a real L5X** (all
caused three false "bugs" in one verification pass before being caught):
- `comp_name` is **not unique** in `Comps.Dat` — a `<Tag>` and a `<Routine>` (or other object)
  can share the exact same name. `SELECT ... WHERE comp_name=?` can silently grab the wrong
  object entirely. Always resolve by `object_id` (from the already-built `Controller`/`Program`
  object graph) or by `parent_id`/collection membership, never by name alone.
- Self-closing `<Tag Name="..." .../>` elements (e.g. Alias tags with no children) have no
  `</Tag>` to search for — a naive `content.index('</Tag>', start)` after matching `<Tag
  Name="...">` will walk past the self-close and grab the **next** tag's content instead. Match
  `(?:/>|>)` and branch on which one matched before searching for a closing tag.
- I/O tags (`":" in tag.name`) are already correctly excluded from the real `<Tags>` XML section
  via `Tag._l5x_exclude` — that exclusion only takes effect when a *parent* element serializes
  its `tags` list (see `_LIST_SECTION_NAMES`/`_l5x_exclude` handling in `L5xElement.to_xml()`).
  Calling `tag.to_xml()` directly on an I/O tag bypasses that filter and will make it look like
  I/O tags are wrongly emitting `<Tag>`/`<Comments>` content when they never actually would be
  in a real full-project export — filter by `not tag._l5x_exclude` first when spot-checking.

## Connection Type / RPI (Module builder)

`ModuleBuilder` reads each I/O connection's Type (Input/Output/DiagnosticInput/MotionSync/
StandardDataDriven/...) from a real u16le CIP enum at raw offset 90, and its RPI (microseconds)
from a u32le immediately after it at offset 92 — not from the connection's name. The connection's
own name (e.g. `"Standard"`) gives **no reliable signal**: in a real project, most `"Standard"`
connections were `Type="Output"` while a couple were `Type="Input"`. If you ever need to
reverse-engineer a similar "guess from name" situation, the method that worked here: collect
every real `<Connection Name=... RPI=... Type=...>` from a project's own L5X export, match each
one to its raw ACD record (RPI is a convenient unique-ish key to match on, but not always unique
project-wide — scope the match to the owning Module too, since the same connection name/RPI pair
can recur across many different module instances), then scan every byte offset for one whose
value is constant within each `Type=` group and differs across groups — a real 1-byte/2-byte enum
will show up as a clean, zero-exception discriminator immediately.

`_CONNECTION_TYPE_BY_CODE` currently has 5/6/7/23/48; unrecognized codes log a `log.warning()` and
fall back to the old name heuristic rather than silently guessing — check the logs if you ever
suspect a module's connection Type is wrong. **Code 48 (`StandardDataDriven`) was added after a
user hit the warning on a real project** (module `MCC116_Output`, connection `OutputData`) — a
whole-project cross-check (every one of 205 real connections in that project, matched by
module+name+RPI between the ACD's raw bytes and the project's own L5X export) found all five
codes hold with zero exceptions, 134 of the 205 being code 48 alone. This case is a particularly
strong confirmation of the "don't trust the name" warning above: the exact same code 48 appears on
connections literally named both `"InputData"` and `"OutputData"` in this one project, meaning the
old name-based fallback silently guessed opposite answers ("Input" vs "Output") for two
functionally-identical connections depending only on which one happened to be in front of it —
neither guess was actually `StandardDataDriven`, so both were wrong, just not usually visible as
a hard error since callers mostly only care whether IO is input-like or output-like.

## Known limitations / things not implemented

- `Comps.Dat` binary serialization is not implemented — `save_acd()`/`patch_rungs()` only
  re-serializes `SbRegion.Dat` (rung text); tags/datatypes/AOIs/modules round-trip as raw bytes.
- `acd/l5x/catalog_numbers.py` and `acd/l5x/port_structures.py` are hand-maintained lookup
  tables (vendor/product-type/product-code → catalog number / port layout) because that
  information isn't stored as strings in the ACD binary. Only relevant for **new hardware
  module models**, not new UDTs/tags/AOIs.
- Module (I/O) metadata is not fully round-tripped to L5X (opaque CIP identity records).
- **Module/Connection-level comments are not implemented at all.** Studio 5000 stores per-bit
  descriptions for I/O module connection points inside
  `<Module><Connections><Connection><InputTag>/<OutputTag><Comments>` (a completely different
  XML location from a regular `<Tag>`'s `<Comments>` block, with its own comment_id/scope_id
  resolution scheme that hasn't been reverse-engineered yet). Verified on one large real project:
  570 `<Comment Operand="...">` entries live there — 0 of them are currently emitted. This is
  separate from (and larger than) the regular per-`<Tag>` `<Comments>` block, which **is**
  implemented and was verified byte-exact against that same project (see comment-resolution
  section above).
- **Whole-project L5X fidelity — current status (as thoroughly verified as this project has ever
  been checked)**: a full whole-project element-count comparison against a real Studio 5000 L5X
  export (see "Whole-project element-count verification" below) found and fixed real bugs causing
  `Tag`/`Module`/`Program`/`Routine`/`Rung`/`Task` count mismatches — all six are now **exact
  matches** (0 diff), joining `DataType`/`AddOnInstructionDefinition`. `Comment` (rung-level) is
  also now an **exact match** (582/582, every one on the exactly right rung, not just the right
  count — see "Rung comments: attribution via RegnLink.Idx" below) after finding the authoritative
  fragment→rung mapping in `RegnLink.Idx`. The **only** two remaining, fully-understood (not
  mysterious) discrepancies against that same real project's L5X, both already covered above: the
  `Comment` total is short by exactly 570 (the un-implemented `InputTag`/`OutputTag`/
  `InAliasTag`/`OutAliasTag` module-connection comments) and `Description` is short by exactly 19
  (16 of the same module-connection kind + 3 un-implemented `<Trend>`/`<Pen>` descriptions) —
  verified by breaking down both totals element-by-element, not just diffing the raw counts.
  Tag-level `<Comments>` and rung `<Comment>` content were both independently checked
  comment-by-comment (not just aggregate counts) against the real export with zero mismatches.
  Don't assume this same level of fidelity holds for a *different* real project just because one
  project now checks out this cleanly — re-verify against a fresh real export if it matters.
- `_decode_udt_initial_value`/`_decode_single_udt_element` (initial-*value* decoding from the
  data-table blob, `elements.py`) has a hardcoded recursion depth limit of 3 nested structs —
  this is a generic safety cap (not tied to any specific type/module), separate from the
  *structure*-generation recursion (`_struct_members_xml` and friends), which has no depth
  limit at all. If you ever see a deeply-nested UDT's initial value silently come back empty,
  check this limit first.
- ~~`<Description>` may need to preserve multi-line text~~ — **fixed.** Confirmed via a real
  Studio 5000 Import Routine diff: a tag's existing `<Description>` was genuinely multi-line
  (`"Program \nBit \nFlags"`, 3 lines), and our collapsed single-line rendering
  (`"Program  Bit  Flags"`) was flagged by Studio 5000's own import comparison as a real
  difference, not just cosmetic. `_multiline_xml_text()` now preserves line breaks in every
  `to_xml()` Description/RevisionNote renderer (Member, DataType, Tag, LocalTag, Parameter,
  Module, AOI) — verified byte-for-byte identical to the real export afterward. The
  `.description` **Python property** (`Member.description`/`Tag.description`) still
  deliberately collapses to one line — that's documented, existing convenience-API behavior,
  separate from XML fidelity.
- ~~SFC routine content is still not decoded~~ — **implemented**, see the "SFC (Sequential
  Function Chart) routine content" section below. All four routine types now export real content:
  `RLL` (ladder, via `SbRegion.Dat`), `ST` (structured text, via `Nameless.Dat`), `FBD` (Function
  Block Diagram), and `SFC`. Known SFC-specific gaps (not decoded, or decoded via a heuristic
  rather than a byte field): `IsBoolean="true"` on an Action, a populated Step
  `Preset`/`LimitHigh`/`LimitLow` expression, `<Stop>`/`<SbrRet>` elements, `<TextBox>` elements,
  and `SheetOrientation` (geometric heuristic, not decoded) — see that section for the full
  detail and why each one is currently unconfirmable rather than just unimplemented. Also found
  via SFC's own live-simulation verification, but unrelated to SFC decoding itself and now
  **fixed** in its own follow-up round: Equipment Phase `<Program>` elements were never rendering
  `Type="EquipmentPhase"` (or its accompanying `InitialStepIndex`/`InitialState`/
  `CompleteStateIfNotImpl`/`LossOfCommCmd`/`ExternalRequestAction` attributes) — see "Equipment
  Phase Program attributes" below for the real byte-offset fix and its own verification.

## Structured Text (ST) routine content (`_st_routine_lines`)

ST routine bodies are **not** stored in `SbRegion.Dat` like ladder rungs — they live in
`Nameless.Dat`, one record per source line, found by walking the nameless `parent_id` tree
breadth-first from the routine's own object id (routine → map → region → line, up to 6 levels).
A source-line record is identified by record type `0x01000002` (u32 at offset 4) — other record
types under the same subtree (`0x7d6` compiled neutral text, `0x7d2` region stubs, `0x8a4`
bookkeeping, in Kaitai node-kind terms) are *not* source lines and must be filtered out; the
sequence number (u32 at offset 20) gives source order, and the line text itself is `fffeff`-encoded
UTF-16 starting at offset 24 (`_parse_fffeff`, extended to handle the long-line form where the
one-byte length is `0xFF` and the real length follows as a u16). `@hexid@` placeholders (an
object-id-in-hex tag reference, distinct from rung text's `&hexid:` form) are batch-resolved to
comp names the same way rung text resolves module references. Rendered as `<STContent><Line
Number="N"><![CDATA[...]]></Line>...</STContent>` — verified line-for-line against the
`ACDTestsNonRedundant.ACD`/`ACDTestsWithAOI.ACD`/`ACDTestsFilledRedundant.ACD` fixtures' own
`STRoutine`, including preserved blank lines and resolved tag references
(`test_st_routine_content`). AOI logic routines store ST the same way and are picked up
automatically wherever `RoutineBuilder` runs. Adapted from an open, unmerged PR against
`hutcheb/acd` (our upstream) after independently re-verifying the layout against our own fixtures.

**A second, distinct "not a real line" case, found via a real false-positive routine diff**: some
`0x01000002` records — same record type as genuine source lines — carry sequence number
`0xFFFFFFFF` (u32 sentinel) instead of a real ordinal. These are a shadow/compiled copy of part of
the routine's logic (observed: the ladder-equivalent body backing a `for`-loop's semantics,
`ADD`/`CMP`/`MOVE`/`SIZE`/`SUB` instruction-call syntax, not valid ST), not source Studio ever
displays. `_st_routine_lines()` used to sort all lines by `(seq, text)` with no sentinel check, so
these all-`0xFFFFFFFF`-seq records tied on the primary key and fell back to sorting by their own
(still-unresolved) `@hexid@` text — which differs between any two saves of the *same* routine
simply because each save assigns different object ids to the same tags, producing a spurious,
save-dependent order for lines Studio never even shows. Root-caused by comparing the exact same
routine (`S01_Next_Board_Search`) across two real saves of one project that a user reported as
"identical" despite our tool reporting 4 differing lines — after excluding `seq==0xFFFFFFFF`
records, the remaining (real, numbered) lines were byte-for-byte identical between the two saves,
confirming both the fix and that the excluded records were never genuine source. Fixed by skipping
`seq == 0xFFFFFFFF` records entirely in `_st_routine_lines()`.

**Three more real bugs found verifying against a real, large ST-containing project** (the first
one either this library or its JS port (`js/`, see `js/CLAUDE.md`) had ever been checked against —
no local fixture has any ST content at all):

1. **`&hexid:` module-address placeholders can appear directly inside ST text, not just
   `@hexid@` tag references.** An I/O module reference written into ST (e.g.
   `PROC_TT_A001 := N2:5:I.Ch2Data;`) is stored in Nameless.Dat as
   `PROC_TT_A001 := &2a47752d:5:I.Ch2Data;` — the same encoding rung text uses, not the
   `@hexid@` form this function otherwise only expected. Affected the large majority of a real
   project's 57 ST routines (any one referencing an I/O module).
2. **Resolution must iterate to a fixed point, not run in a single pass.** A comps entry's own
   name can itself still be an unresolved `&hexid:` (or `@hexid@`) placeholder — a
   composite/derived module-address reference stored that way — so the name looked up for one
   placeholder can contain a further placeholder a single pass would leave untouched. Both forms
   are now resolved together in one bounded (5-iteration) loop; see `test_elements_helpers.py`'s
   `test_st_routine_lines_resolves_nested_hexid_placeholders` for a synthetic case exercising this
   specifically, since neither local fixture nor the one real project available so far actually
   has a nested placeholder in practice.
3. **`<Line Number="...">` is not a flat contiguous index across a routine's whole line list.**
   Assumed true for every real routine tested until one (`Alarms_from_Fox`) disproved it: its raw
   Nameless.Dat line records fall into two distinct groups by their own immediate `parent_id` (the
   "region" node directly above the line) — 92 lines under one parent (seq 1038-1129) and 93 under
   another (seq 1130-1222), an old/new near-duplicate pair retained side by side with neither
   marked by the `0xFFFFFFFF` sentinel above. Real Studio 5000's own native L5X renders this as two
   back-to-back `<Line Number="...">` runs, each independently 0-based (duplicated Number values
   across the runs) — not one contiguous index, and not each line's own raw stored `seq` either
   (a real *single-group* routine's raw seq starts at an arbitrary project-wide offset like 1532
   while its real Number is still plain 0-based). Fixed by grouping lines by immediate `parent_id`,
   sorting each group by its own seq, numbering each group locally from 0, and concatenating
   groups by ascending seq range — `_st_routine_lines()` now returns `(number, text)` pairs instead
   of bare text, and `Routine.to_xml()` renders that number verbatim rather than re-enumerating.
   Reduces to the original plain-index behavior for every routine with only one group (56 of the
   57 real ones checked).

Verified end-to-end after all three fixes: this project's real Studio 5000 L5X export matches our
own output exactly across all 64 ST routine occurrences (5,026 total lines, including
`Alarms_from_Fox`'s duplicate-Number edge case) — and separately, the whole converted document
(not just ST) is byte-for-byte identical between this Python implementation and the `js/` port for
the same real project, the strongest cross-language verification either has had against real
production data. See `js/CLAUDE.md`'s own Round 2 section for the parallel JS-side fixes (plus two
JS-only bugs — non-ASCII text decoding and a `toFixed()` magnitude quirk — found in the same pass).

**Provenance note on bug 1/2 above**: bug 1 (the `&hexid:` addition) and bug 3 (local-per-group
numbering) were found and fixed together in one session verifying the JS port against real data,
using a simpler *non-iterating* two-pass resolve for bug 1 at the time. A separate, earlier branch
(`fix/st-hexid-resolution`, never merged until this note) had independently found the same `&hexid:`
gap and fixed it more completely — with the fixed-point iteration bug 2 describes, which the
simpler two-pass version didn't have. That more complete version is what's merged in now; if you
ever find `_st_routine_lines()` missing a resolution that should have happened, check whether it's
because a comps name is itself still a raw placeholder (bug 2's exact scenario) before assuming a
new root cause.

## FBD (Function Block Diagram) routine content

Like ST (see above), FBD routine content is **not** stored as its own native binary shape —
Studio 5000 compiles an FBD sheet down to an equivalent ladder-logic ("compiled neutral text")
program at save time, stored via the exact same `region_map`/`rungs` SQL tables real RLL rungs
use, under a synthetic shadow region with no `Comps.Dat` object of its own (the same general
"shadow/compiled copy" pattern already documented for ST). Correlation mechanism
(`_fbd_shadow_region()`): a routine's own comps record has 4-byte extended-record attributes
referencing other objects; one references a `Nameless.Dat` object with record_type `0x01000002`
(the same record type ST source lines use, but here a single "compiled neutral text" blob, not
per-line records) — BFS down that node's nameless subtree (fanning out at each level, bounded to
6 depth levels, not a fixed hop count) finds whichever descendant owns by far the MOST
`region_map` rows (a decoy/stale single-row region_map owner elsewhere in the same subtree was
observed in real data, so "first match" isn't reliable — must pick the max, same lesson as the
`RegnLink.Idx` stale-entry handling documented elsewhere in this file).

**Confirmed working unchanged for an FBD routine embedded inside an
`AddOnInstructionDefinition`** (not just a Program) — `AOI_VESSEL`'s own "Logic" routine resolves
via the exact same `_fbd_shadow_region()`/BFS mechanism with zero AOI-specific special-casing,
verified as an exact match against real Studio 5000 ground truth. The only AOI-specific handling
needed anywhere in this feature is unrelated to routine *location* — it's about rendering an
AOI-*instance* block correctly (see below).

**Compiled-rung instruction grammar** (`_parse_fbd_network()`), reverse-engineered directly
against real ground truth (`RefProjA_V33_R17_4.ACD`/`.L5X`, a large real project with 28 FBD
routines, one embedded in an AOI):
- Block-execution rung: `OTL(Op.EnableIn)...wiring pairs...XIC(Op.EnableIn)MNEMONIC(Op);` —
  MNEMONIC is the block's Type (`ALMA`/`BNOT`/`RLIM`/`TONR`/etc. for built-ins, or an AOI's own
  definition name like `AOI_VESSEL`/`AOI_ALM2` for AOI instances).
- Wiring pairs inside a block rung: `MOV(src,Op.Pin)` or `XIC(src)OTE(Op.Pin)ATI()`.
- A mid-rung `OTL(Op.Pin)`/`OTU(Op.Pin)` (not the leading position-0 `OTL`, which is just the
  "this rung is a block" marker) means that pin is wired to a literal constant 1/0, not left
  disconnected — real Studio renders this as a genuine `<IRef Operand="1"/>`/`<IRef
  Operand="0"/>`, a real FBD feature (literal constants can be IRef sources). Verified: an AOI's
  own "Logic" routine wires a literal 0 into an ALMA block's `AckRequired` pin this way.
- IRef feeder rung: `MOV(RealTag,__lHEX);` or `XIC(RealTag)OTE(__lHEX)ATI();` (no trailing block
  instruction) — resolves the pseudo-tag (`__l` + 16 hex digits) back to its real source tag.
- ORef writer rung: `MOV(src,RealTag);` or `XIC(src)OTE(RealTag)ATI();` (no trailing block
  instruction) where `src` is a block's own output pin.
- **AOI-instance calls take extra positional arguments beyond the operand**
  (`AOI_VESSEL(TANK03,TANK03_GA,TANK03_PA,TANK03_OA,TANK03_FRA)`), corresponding 1:1 in order to that AOI's
  own declared InOut parameters (verified exactly: `LEVEL_ALM`, `PROG_ALM`,
  `OPER_LVL_ALM`, `ROOF_ALM`). Rendered as a **completely different L5X element**:
  `<AddOnInstruction Name="AOI_VESSEL" ...><InOutParameter Name="..." Argument="..."/></AddOnInstruction>`,
  not `<Block Type="...">` with `<Wire>`-based pin wiring. `_aoi_inout_order` (AOI name upper-cased
  → ordered InOut parameter names) is threaded onto each FBD `Routine` post-hoc from
  `ControllerBuilder.build()`, the same dataclass-field-attached-after-the-fact pattern already
  used for `tag._data_types_map`, since `RoutineBuilder` runs before the controller-level AOI list
  exists.
- IRef/ORef operands can themselves be dotted `tag.member` references (e.g.
  `TANK16_RET.CloseLS`, confirmed in real ground truth) — **not** the same as a block-pin reference
  (`BlockOperand.Pin`). `_fbd_split_pin_ref()` disambiguates correctly by checking whether the
  part before the dot is a known block operand, not just checking for dot-presence (an earlier,
  wrong version assumed any dot meant "block pin" and corrupted these real tag.member IRefs).
- A single pseudo-tag can be referenced with a trailing bit index (`__lHEX.19`) when several
  boolean IRefs are packed into one word-sized feed via a hidden bit-host member (e.g.
  `MOV(TANK19_SUP.__BitHost00,__lHEX);` then consumers reference `__lHEX.19`, `__lHEX.27`, etc.) —
  the same "hidden bit-overlay backing field" pattern documented elsewhere in this file for
  TIMER/COUNTER. `_fbd_resolve_source()` resolves the pseudo-tag base but **does not** map the
  bit index back to its real named bit-overlay member — see "Known gap" below.

**`_render_fbd_content()`** renders `<FBDContent><Sheet Number="1">...</Sheet></FBDContent>`,
assigning synthetic sequential IDs (sorted by operand name, IRefs then ORefs then Blocks) and a
simple synthetic X/Y grid — **deliberately not** Studio's own layout/ID numbering, per this
round's explicit scope (functional correctness — right blocks, right wiring, right parameters —
is the bar; exact sheet layout fidelity and Studio's own arbitrary element IDs are not). Emits
`<AddOnInstruction>`/`<InOutParameter>` for a block whose type matches a known AOI name (via
`aoi_inout_order`), else a plain `<Block Type="..." .../>`. `VisiblePins` includes only pins
actually observed wired (plus, for an AOI instance, its own InOut parameter names) — documented
as an incomplete approximation, since a real block/AOI instance can show an unwired pin too (e.g.
a real `InAlarm` pin shown but never wired) with no trace of that left anywhere in the compiled
rungs to recover.

**Verification**: built the whole `Controller` object graph once, iterated every FBD routine
(`programs[*].routines` + `aois[*].routines`) in the real 28-routine project, matched each
against its own real Studio 5000 L5X export (disambiguating same-named routines by
Program/AOI scope, since e.g. multiple AOIs each have a routine literally named "Logic"), and
diffed blocks/wires/oref-writes/InOutParameter sets programmatically (not by eye) — **28/28
routines match exactly** (see the `UNIT_STATUS` bit-index gap below for the one that initially
missed and how it was closed). That project has **zero multi-sheet FBD routines** (every one of
the 28 has exactly one `<Sheet>`) — see the "Multi-sheet FBD" section below for that case, solved
and verified separately against a different real project.

## Multi-sheet FBD — SOLVED, verified against a real 2-sheet project

A genuinely multi-sheet FBD routine (`FBDLevelControlSimulation.ACD`/`.L5X`, a Rockwell sample
project, 2 sheets: "Level_control_and_simulation" and "Agitator_control") answered the open
question above. **The compiled ladder-equivalent network is one continuous flat pool spanning
every sheet, with zero trace of any sheet boundary in it at all** — confirmed directly: a real
cross-sheet link (block `HLL_01` on sheet 1 feeding block `GRT_01` on sheet 2, via a
user-named `OCon`/`ICon` connector pair called `"TankLevel"` in the FBD editor) compiles down to
one ordinary direct rung (`MOV(HLL_01.Out,GRT_01.SourceA);`) — the connector name never appears
anywhere in the compiled rung text. `_fbd_shadow_region()`/`_parse_fbd_network()` therefore need
**zero changes** for multi-sheet routines; they already recover every block/wire correctly
regardless of sheet, exactly as they did for the single-sheet case.

Sheet **membership** and connector **identity** are a wholly separate, parallel metadata tree
(`_fbd_decode_sheets()`), hanging off `shadow_oid`'s own nameless `parent_id` (not the
compiled-rung subtree). Reverse-engineered structure, verified byte-for-byte against the real
2-sheet ground truth (every block/IRef/ORef/connector's resolved name AND its real X/Y position
matched exactly, though X/Y is unused, still out of scope):
- One "sheet description" node per sheet: `record_type` `0x01000002`, a flag `u32` at offset 16
  equal to exactly `0x00010003` (the discriminator that distinguishes a genuine sheet-description
  node from an ordinary per-element node that also happens to have its own child and an fffeff
  string of its own — e.g. a `DEDT` block's own `StorageArray` array-reference child, or a `PIDE`
  block's own extra metadata child — both initially false-positive-matched a looser filter before
  this exact flag value was found), an fffeff-encoded description string (same encoding ST source
  lines use), and a `u32` at offset 20 giving this sheet's own seq value — ascending seq order is
  real Sheet Number order (verified exact: seq 0 → Sheet 1, seq 20 → Sheet 2).
- Each sheet-description node has two meaningful children (plus occasional empty/unused reserved
  container slots, safely ignored):
  - an **elements** container: one child per `IRef`/`ORef`/`OCon`/`ICon`/`Block`/
    `AddOnInstruction` on that sheet. A plain tagref element (`record_type` `0x01000002`) carries
    an fffeff string, either a literal (`"20"`) or an `@hexid@` tag reference resolved the same
    way rung/ST text is. A connector element (`record_type` `0x01000000`) has no string of its
    own — its own trailing 4 bytes are the object_id of a *shared* leaf fffeff-string node (0
    children) holding the connector's Name, the same node its partner element on the other sheet
    also points to, which is how an `OCon` and its `ICon` are correlated as the same named
    connector.
  - a **wires** container: one child per `Wire`/`FeedbackWire` on that sheet, each a fixed
    40-byte record whose own flag `u32` at offset 16 has high word `7` (`0x0007xxxx`) — the
    reliable discriminator between this and the (variably-sized) elements container. `u32`s at
    offsets 24/32 are the FROM/TO element's own object_id (matched back to the elements list by
    identity, not by the numeric per-block-type pin "code" also present at offsets 28/36 — that
    code is a Rockwell-internal per-instruction-TYPE pin enumeration, not a byte offset or member
    index, and is **not** decoded at all: the real pin NAME for rendering always comes from the
    already-verified flat compiled-rung decode, this tree is only consulted for sheet membership
    and connector identity). The flag's low word distinguishes a real `<FeedbackWire>` (`0x12`)
    from a plain `<Wire>` (`0x11`) — verified against the same ground truth's two genuine feedback
    connections (e.g. `LevelController.CVEU` feeding back into `DEDT_01.In`, an upstream block it
    also feeds forward into elsewhere).

**Rendering** (`_render_fbd_content()`'s `sheet_layout` parameter): classifies every decoded wire/
oref-write as same-sheet (one ordinary `<Wire>`/`<FeedbackWire>`) or cross-sheet (needs an
`OCon`/`ICon` pair instead) purely from `operand_to_sheet` — the compiled network itself has no
notion of sheet at all, so this decision comes entirely from the separate metadata tree above. A
cross-sheet wire is matched to its real connector Name by object-identity correlation
(`connector_feed`'s recorded feeder/consumer operand pair), not by guessing from sheet numbers
alone — this stays correct even if a future project has multiple different connectors spanning
the same two sheets. There is deliberately only **one** rendering implementation, not two parallel
single-sheet/multi-sheet code paths: when `sheet_layout` is `None` (or a routine's layout metadata
can't be found), everything reduces to one `<Sheet Number="1">` with no description and every wire
classified "same-sheet" — mathematically identical to this function's original single-sheet-only
behavior, confirmed byte-for-byte unaffected by re-running the full 28-routine RefProjA project after
this change (still 28/28 exact, and the whole-project L5X output is byte-for-byte identical to
before this round save for the expected per-run `ExportDate`).

**Verified end-to-end** against the real 2-sheet ground truth: both sheets' own `<Description>`,
every `Block`/`IRef`/`AddOnInstruction`, every `Wire`/`FeedbackWire` (11 `Wire` + 2 `FeedbackWire`,
matching real counts exactly), and the one `OCon`/`ICon` connector pair (`Name="TankLevel"`) all
match exactly — checked via element-count comparison, not just presence, so a silently-dropped
duplicate or a wrongly-tagged `Wire`/`FeedbackWire` would have been caught. This project also
provided real ground truth for `PIDE`/`ADD`/`SUB`/`MUL`/`DEDT`/`LDLG`/`HLL`/`GRT`/`D2SD` block
types (none seen in the RefProjA project's `ALMA`/`BNOT`/`RLIM`/`TONR`/AOI-instance mix), confirming
block rendering stays generic rather than accidentally coupled to the specific types seen first.

**`UNIT_STATUS` bit-index gap — SOLVED (was the sole mismatch, now 28/28 exact).** Its wires
resolved to `RealTag.__BitHost00.N` (a bit index into the pseudo-tag's own packed feed) where real
Studio shows a friendly field name instead (e.g. `TANK19_SUP.OpenLS`). Investigated two scope
questions before fixing, per explicit ask, rather than assuming either answer:

- **Is this a `UNIT_STATUS`/one-tag special case, or general?** General — and NOT the UDT
  bit-overlay mechanism (TIMER/COUNTER's `EN`/`TT`/`DN`-style hidden-backing-field/`bit_number`/
  `target` triple) this was originally assumed to need. The referenced tags (`TANK16_SUP`,
  `TANK16_RET`, `TANK19_SUP`, `TANK19_RET`) all turned out to be **AOI-instance** tags (`data_type ==
  "AOI_VALVE"`), and `Parameter` objects (an AOI's own declared fields) have no `bit_number`/
  `target` at all — confirming the UDT mechanism literally can't apply here. Cross-referencing
  every real `(bit_index -> friendly_name)` pair against `AOI_VALVE`'s own declared `parameters` list
  found the actual rule: **the bit index is the field's own 0-based position among that type's
  BOOL-typed fields only** (skipping DINT/INT/FBD_TIMER fields) — verified exactly for all 5 real
  pairs (`11→Opening, 17→Closing, 19→OpenLS, 20→CloseLS, 27→Mismatch`), which only line up once
  non-BOOL fields are excluded from the count first. Implemented generically
  (`_fbd_bool_field_by_index()` counts BOOL-typed entries in either a `DataType`'s `members` or an
  AOI's `parameters`, keyed off whichever the tag's own `data_type` resolves to via
  `_fbd_make_bit_resolver()`) — not special-cased to `AOI_VALVE`/`UNIT_STATUS` by name. The UDT-member
  path (`dt.members`) is included in the same generic function for when a future project's tag
  happens to be UDT-typed instead of AOI-typed, but is **unverified** — only the AOI-instance case
  has real ground truth backing it; treat the UDT branch as inferred-by-analogy until a real UDT
  case is found and checked.
- **Is `UNIT_STATUS` the only routine affected in this project, or just the first one it surfaced
  on?** Scanned every one of the 28 FBD routines' resolved wire sources for the same
  `Tag.BackingField.N` (bit-suffixed, unresolved) shape — `UNIT_STATUS` is the **only** one in this
  project that exercises it; every other routine's 27/28 exact match was never masking a
  same-class miss elsewhere.

Resolution needs each referenced tag's own DataType/AOI scope, not available when `RoutineBuilder`
first runs — attached post-hoc in `ControllerBuilder.build()` (`_fbd_bit_resolver`, the same
after-the-fact pattern as `_aoi_inout_order`), scoped per program (program tags shadow same-named
controller tags) or per AOI (that AOI's own `parameters`/`local_tags`, plus controller tags).
Re-verified all 28 FBD routines after the fix: **28/28 exact match**, confirming no regression on
the 27 that already passed. Synthetic unit tests (`test_fbd_bool_field_by_index_counts_only_bool_
fields`, `test_fbd_make_bit_resolver_resolves_aoi_instance_tag`,
`test_fbd_resolve_source_uses_bit_resolver_when_available`) lock in the mechanism independent of
any real ACD fixture, since neither local fixture has an AOI-instance tag with a packed bit feed.

**A second, distinct instruction convention found via broader fixture testing (NOT the main
verified project)**: re-running the pre-existing small repo fixtures `ACDTestsWithAOI.ACD`/
`ACDTestsNonRedundant.ACD` as a regression check (previously silently rendering FBD as empty
shells) turned up a real `FBDRoutine` containing stateless "math"/bitwise blocks (`AND`, likely
shared by `OR`/`BAND`/`BOR`/`NOT`/etc.) using a shape never seen in the main project: wrapped in
`start_block(Op.Member)`/`end_block(Op.Member)` markers (lowercase mnemonics — never matched by
`_FBD_INSTR_RE`'s `[A-Z]`-anchored pattern, so they simply don't appear as parsed calls at all,
no special skip logic needed), with the final instruction call's own arguments being THEMSELVES
dot-qualified `Op.Pin` pin references (`AND(AND_01.SourceA,AND_01.SourceB,AND_01.Dest)`) rather
than one bare operand followed by AOI-style extra positional args. The original
`block_operand = final_args[0]` logic took `"AND_01.SourceA"` (a dotted member reference) as if
it were the whole bare operand, producing a corrupted `<Block Operand="AND_01.SourceA">` and a
literal Python `None` leaking into a `ToParam="None"` attribute (the pin lookup failed since
`"AND_01"` was never actually a key in `blocks`). Fixed by detecting when every final-call
argument shares an identical dot-prefix (a normal block/AOI operand is always a bare name with no
dot, so this is an unambiguous signal) and deriving `block_operand` from that shared prefix
instead — the individual pin wires themselves needed no fix, since they're populated by the
ordinary MOV/XIC-pair loop reading each pin name verbatim from the rung text, the exact same
already-verified mechanism every other block uses. Also added a defensive guard in
`_render_fbd_content()` so a wire whose destination pin can't be resolved is dropped (with a
`log.warning()`) rather than ever rendering a literal `"None"` into XML, independent of this
specific root cause. **No ground-truth L5X exists for either small fixture** (only
`resources/CuteLogix.ACD` has one, and it has no FBD content at all), so this fix is verified only
for structural sanity (no crash, no garbage/`None` in the output, blocks/wires look internally
consistent) — not byte-exact against a real Studio 5000 export the way the main 28-routine
project was. If you ever add ground truth for these fixtures (or hit this shape in a new real
project), re-verify properly rather than trusting this as "done."

## SFC (Sequential Function Chart) routine content — SOLVED, verified against two real projects

Like FBD before this round, nothing upstream (hutcheb/acd → PascalGodin/acd → this repo) has ever
decoded SFC content — `Routine.to_xml()`'s SFC branch was empty, so an SFC routine rendered as a
bare `<Routine Name="..." Type="SFC"></Routine>` shell. This was previously parked specifically
because there was no ground truth to verify against; that blocker was resolved when two real
sample projects turned up, each with both the `.ACD` source and its own genuine Studio 5000 L5X
export: `Equipment_Phase_Sequencer.ACD`/`.L5X` (routine `Recipe_Sweet_Cream_Op`: 8 Steps/8
Actions/5 Transitions/5 Branches/21 DirectedLinks) and `SFC_GearChange.ACD`/`.L5X` (routine
`SimpleMotion`: 7 Steps/10 Actions/9 Transitions/3 Branches/21 DirectedLinks).

**Don't assume the FBD shortcut applies.** FBD turned out to be tractable specifically because
Studio 5000 compiles an FBD network down to the same ladder-equivalent shadow-region mechanism RLL
already uses (see above). SFC does **not** do this — confirmed empirically: every `region_map` row
whose `parent_id` lands anywhere in an SFC routine's own nameless subtree is an inert `0xFFFFFFFF`
sentinel placeholder (the same "field absent" marker used everywhere else in this codebase), never
real ladder content. The real structure lives entirely in `Nameless.Dat`, reusing three mechanisms
this codebase already had independent precedent for, rather than needing a wholly new grammar:

1. **Steps and Actions are ordinary comps tags** of the built-in `SFC_STEP`/`SFC_ACTION` data
   types — decodable today, unmodified, by the existing `DataTypeBuilder`/`TagBuilder` machinery
   (confirmed: `SFC_STEP`'s full member layout — `Status` DINT + 22 BIT-overlay members `X`/`FS`/
   `SA`/`LS`/`DN`/`OV`/... + `PRE` DINT — and `SFC_ACTION`'s `Status`/`A`/`Q`/`PauseTimer`/`PRE`/
   `T`/`Count` both decode correctly via `DataTypeBuilder.build()` with zero code changes). This
   thread was **not** actually used by the final decode, though — the diagram's own Operand names
   are recovered directly from the raw nameless-tree wrapper nodes (see below), which turned out
   simpler than resolving through the tag layer.
2. **Action Body / Transition Condition text is stored using the *exact* same "Map → Region →
   Line" `Nameless.Dat` grammar as an ST routine's own source lines** (`_ST_LINE_RECORD_TYPE`,
   `_parse_fffeff`, `_st_routine_lines`'s grouping/local-numbering/`@hexid@`-resolution logic) —
   just hanging much deeper below an Action/Transition's own object than a plain ST routine's line
   tree hangs below the routine itself (13+ levels vs. the ST case's usual few). `_st_routine_lines`
   was given a `max_depth` parameter (default 6, unchanged for existing ST callers) specifically so
   SFC could reuse it verbatim with a larger value (15) instead of forking a near-duplicate
   function — the exact same "one function, one grammar" discipline the FBD section above already
   established for `_st_routine_lines` itself.
3. **The routine's own comps record has several 4-byte extended-record attribute values that are
   themselves other objects' object_ids** — the same "candidate object id list" shape
   `_fbd_shadow_region` reads. Unlike FBD (disambiguated by region_map ownership), SFC has no
   region_map signal to key off at all, so the real candidate is identified the same way FBD
   breaks its own remaining ties — "whichever candidate's own nameless subtree is by far the
   largest" (`_sfc_count_descendants`) — confirmed to unambiguously pick the right one in both real
   projects (hundreds of descendants for the real content vs. 0–9 for the other, genuinely-unused
   candidates, e.g. `Stop`/`SbrRet` collections, empty in both available samples).

**The investigation itself** (an earlier research-spike round, checkpointed before implementation
per this project's own discipline) started from nothing and had to work byte-by-byte from the raw
`Recipe_Sweet_Cream_Op` nameless subtree. The single most useful early break: dumping every node's
raw `uint32`-field-decoded bytes revealed that several small (28–52 byte) leaf/near-leaf nodes'
"text" (when decoded via the same `fffeff` marker scan `_parse_fffeff` already expects) was a bare
`@hexid@` reference resolving, via the ordinary `comps` table, directly to a real Step/Transition/
Action tag name (e.g. a node whose only content was the literal string `"@f4638583@"` resolved to
`Reset_All`). That one observation cracked the whole shape: Steps, Transitions, and Actions are all
*wrapper* nodes distinguished purely by (a) having this bare-`@hexid@` own-text and (b) their own
immediate child count — no other structural marker was needed:

- **Step**: own-text = bare `@hexid@` (resolves to the Step's own `SFC_STEP` tag name), 5
  children.
- **Transition**: own-text = bare `@hexid@` (`Tran` tag name), 2 children.
- **Branch**: no own-text at all, 1 child (a "legs" container whose own children — 2 or 3 observed
  across both real projects — are the Branch's Legs, themselves plain leaves).
- **Action**: own-text = bare `@hexid@` (`Action` tag name), 3 children. Not a content-root child
  like the other three — nested arbitrarily deep inside its owning Step's own subtree (a Step with
  N actions has N such nodes as siblings under one intermediate "actions" node — confirmed against
  `SimpleMotion`'s `ServosOn` step, which has 3 real actions, each correctly attributed).

Steps, Transitions, and Branches are all direct children of one shared "content root" node, found
generically (no hardcoded parent-chain depth — the two real projects' own intermediate structure
differs in exactly how many single-child "region" hops separate the routine from this node) by
searching the whole shadow subtree for whichever node has a Step-shaped child (bare `@hexid@` text
+ 5 children). DirectedLinks turned out to live as a **sibling** of this content root, one level
further up — not nested inside it at all — which made "first locate the DirectedLinks container by
name/position" the wrong approach; the actual fix was to stop trying to locate it as a specific
node and instead apply one global, self-contained filter over the *entire* shadow subtree: any
zero-child, `type==0x1000000` node whose own two reference fields (`u32` index 6 and 8) **both**
resolve to an already-identified Step/Transition/Branch/Leg object id is a real DirectedLink.
Confirmed to recover exactly the real 21/21 links in both projects, semantically isomorphic to the
real `FromID`/`ToID` graph (via names/coordinates — see below for why not literal ID numbers —
including each project's own `Show="false"` links: 1 in the first project, 4 in the second, all
correctly identified via `u32` index 10: `0` = shown, nonzero = hidden). A leaf node accidentally
matching this filter by coincidence is not a real concern: both fields must independently collide
with a real object id out of the full 32-bit id space, and every non-DirectedLink leaf shape in
practice already fails on other grounds (coordinates, GUID bytes, etc. are not valid object ids).

**Byte fields confirmed, with the exact evidence for each** (all offsets are `uint32` LE field
*indices*, i.e. `index * 4` bytes into the node's own raw record):

- **X/Y** (`u32` index 6/7 of the Step/Transition's own wrapper record) and **DescX/DescY**
  (`u32` index 6/7 of a dedicated child shaped `type==0x1000000`, 32 bytes total) — confirmed
  **exact** for all 15 Steps + 14 Transitions across both real projects (e.g. `Step_Agitate`:
  X=1080, Y=560, DescX=1120, DescY=540, matching the real L5X to the pixel).
- **HideDesc** (`u32` index 8 of the Step/Transition wrapper: `1` = hidden, `0` = shown) —
  confirmed exact against a real mix of both values (`SFC_GearChange` has both `HideDesc="true"`
  and `HideDesc="false"` Steps/Transitions; `Equipment_Phase_Sequencer` alone only ever showed
  `false`, so this specific attribute needed the second project to close).
- **InitialStep** (`u32` index 10 of the Step wrapper): `0x11` for every normal Step, `0x12` for
  the one Step with `InitialStep="true"` in each project (`Wait_For_Start`, `ServosOn`) — confirmed
  unique and correct in both, not just "differs from the others" but reproducibly the same two
  values across two unrelated real projects.
- **BranchType + BranchFlow, combined** (`u32` index 4 of the Branch wrapper) — a clean 2×2 grid,
  confirmed against all 8 real Branches across both projects (5 `Simultaneous` in the first
  project, 3 `Selection` in the second — the second project was the *only* one available with a
  positive `Selection` example, closing what had been an explicitly open gap after the first
  project alone):

      0x103fb = Simultaneous + Diverge      0x103f9 = Selection + Diverge
      0x103fc = Simultaneous + Converge     0x103fa = Selection + Converge

  `Priority="Default"` is only ever seen on a Selection+Diverge Branch in either real project
  (never on a Simultaneous+Diverge one, and Converge branches never have it at all — matching the
  real schema's own semantics, since Priority only matters when multiple legs could otherwise
  seize control simultaneously); no byte-level source for its own *value* was found (there is no
  contrasting non-`"Default"` example in either sample), so it's rendered as the confirmed-common
  literal string whenever that one structural condition holds, not decoded from any field.
- **Qualifier** (`u32` index 8 of the Action wrapper) — 4 distinct real values seen across the 18
  real Actions in both projects:

      0x1 = NonStored     0x6 = Pulse
      0x7 = PulseRisingEdge     0x8 = PulseFallingEdge

  These are Rockwell's own internal ordinals, not the IEC 61131-3 standard's own qualifier-letter
  ordering (N/S/R/L/D/P/SD/DS/SL/P1/P0) — the 4 known codes don't fit any obvious linear mapping
  onto that 11-value list, so the other 7 real Rockwell codes remain genuinely unknown.
  `_SFC_QUALIFIER_CODE` only maps the 4 confirmed values; an unrecognized code falls back to
  `_SFC_QUALIFIER_DEFAULT` (`"PulseRisingEdge"`, the single most common real value: 11 of 18 real
  Actions across both projects) rather than fabricating a mapping — flagged clearly here and in the
  code as an open gap, the exact same "don't guess a bit mapping to force it" discipline used for
  the still-open ALMA `AckRequired`/`Suppressed`/`Disabled` gap above.

**One real implementation bug found and fixed by the verification loop, worth restating the
pattern for**: the first working version of the Action Body decoder swept the *entire* Action
wrapper's subtree for `_ST_LINE_RECORD_TYPE` leaves with a real (non-`0xFFFFFFFF`) `seq`, exactly
mirroring `_st_routine_lines`'s own top-level walk. This produced exactly one extra, bogus, empty
(`""`) line in **every single real Action's Body across both projects** — invisible to a
smoke-level "does it produce lines" check, only caught by a full attribute-by-attribute line-count
diff against ground truth. Root cause: an Action wrapper's 3 children are a leader/sentinel node
(own text always `""`, but a *real*, non-sentinel `seq` — itself harmless, already correctly
excluded elsewhere), an unused Preset placeholder (`type==0x0`, structurally present even when
completely empty), and the real Body text container (`type==0x1000000`, a "region" node shaped
exactly like an ST routine's own Map→Region tree) — and the unused Preset placeholder's own
descendant chain, though never populated with real content in either sample, independently
contains one more zero-length-text `ST_LINE_RECORD_TYPE` leaf with a genuine `seq` number of its
own, which a subtree-wide sweep can't distinguish from a real (if empty) Body line. Fixed by
scoping the line search to the one specific child shaped `type==0x1000000`, not the whole Action
subtree — the same general lesson the FBD/ALMA sections above make repeatedly: a fix that produces
plausible-looking output on a smoke test isn't proof the underlying sweep is scoped correctly;
only a real, exact ground-truth diff catches an off-by-one-line bug like this.

**What is explicitly NOT recovered, and out of scope for this round** (mostly following the same
precedent the FBD "what is NOT recovered" list above already set):

- **Studio's own small integer ID numbering** (`0, 2, 4, ..., 37` in the real L5X). Unlike FBD's
  blocks (which also don't recover Studio's real numbering, but additionally never recover real
  X/Y either — they render at a synthetic grid position), SFC Steps/Transitions/Branches/Actions/
  Legs' real X/Y coordinates **are** recovered and rendered exactly, but the small integer
  `ID="..."` values themselves are freshly synthesized per render (sequential, in the same
  Step(+its Actions), Transition, Branch(+its Legs) order real Studio's own native L5X export
  uses — confirmed against both real ground truths structurally, just with different literal
  numbers) — the same "Studio's own element numbering is out of scope" position already taken for
  FBD.
- **`IsBoolean="true"`**: every real Action in both projects (18 total) is `IsBoolean="false"` — no
  positive example exists anywhere to find the differentiating bit, so it's always rendered
  `"false"`.
- **A populated `Preset`/`LimitHigh`/`LimitLow` expression on any Step**: every real Step in both
  projects (15 total) has `PresetUsesExpr="false" LimitHighUsesExpr="false"
  LimitLowUsesExpr="false"` and no `<Preset>`/`<LimitHigh>`/`<LimitLow>` child element at all. The
  3 per-step placeholder slots these would occupy WERE located in the raw record tree (structurally
  identical scaffolding under every Step, in both projects, each holding what looks like a raw GUID
  rather than any text), but since none is ever populated in either available sample there is no
  ground truth to confirm which of the 3 is which, or how a populated one would even be shaped — so
  these three are never emitted at all (matching what both real ground truths actually do for a
  Step with no expression), and the three `UsesExpr` attributes are always rendered `"false"`.
- **`<Stop>`/`<SbrRet>` elements**: the real schema has both, but neither appears even once across
  either available real project, so there is no ground truth to decode either against.
- **`<TextBox>` elements**: purely decorative diagram annotations, no bearing on the executable
  Step/Transition/Branch/DirectedLink graph a live SFC engine actually walks; not rendered at all.
- **`SheetOrientation`**: no byte-level source was found for it at all, and unlike `SheetSize`/
  `StepName`/`TransitionName`/`ActionName`/`StopName` (identical literal defaults in both real
  projects, so simply hardcoded), `SheetOrientation` genuinely differs between the two real
  projects (`Portrait` vs. `Landscape`) and a fixed default would be wrong for one of them.
  Instead it's inferred **geometrically** from the decoded elements' own bounding box (wider than
  tall → `Landscape`, else `Portrait`) — a principled heuristic that happens to get both real
  projects right, not a byte-level decode; if a future sample disagrees with this heuristic, that
  would be a genuine new finding worth its own investigation round, not evidence the heuristic's
  own logic is wrong as currently understood.

**Verified end-to-end, attribute-by-attribute, not just element counts, for both real projects**:
every Step (name/X/Y/DescX/DescY/HideDesc/InitialStep), every Action (name/Qualifier/Body text,
correctly attributed to its own owning Step — including `SimpleMotion`'s `ServosOn` step, which
has 3 real actions, all correctly attributed), every Transition (name/X/Y/DescX/DescY/HideDesc/
Condition text), every Branch (Y/BranchType/BranchFlow/Priority/Leg count), and the full
DirectedLink graph (topology + `Show` flag) match the real Studio 5000 L5X exactly for both
`Recipe_Sweet_Cream_Op` (8 Steps/8 Actions/5 Transitions/5 Branches/21 DirectedLinks) and
`SimpleMotion` (7 Steps/10 Actions/9 Transitions/3 Branches/21 DirectedLinks).

**A genuinely stronger check than the usual offline attribute diff, specific to SFC**: since the
sibling `plc-studio` repo (a separate, independently-developed, already-deeply-validated
Studio-5000-like viewer/simulator sharing the same real sample files) has a real, live SFC
execution engine already proven correct against `Equipment_Phase_Sequencer.L5X`'s own real Studio
export (see that repo's own `SFC_EQUIPMENT_PHASE_PLAN.md` and `test/live-scan-cycle.test.js`), the
converted output was fed through that exact same live engine (`loadModel` → force
`Recipe_Ops__Start` via the real `commitWatchEdit` path → `globalTick()` × 500, the identical
mechanism its own HEADLINE test uses) rather than just diffed offline. This genuinely proved
stronger: it caught a real, confirmed bug — **not** in this round's SFC decode itself (the
`<SFCContent>` topology drives the live engine through exactly the right graph, confirmed by
patching around the actual bug and observing the simulation then complete a full real cycle
identically to the real L5X: ends parked back at `Wait_For_Start`, `LoopCount == 1`, all 6
Equipment Phase programs reset to `Idle`) — but in a **separate, pre-existing gap**, diagnosed here
only via a transient, uncommitted, diagnostic-only patch (manually setting the 6 attributes on the
converted output just to unblock this specific check) and properly re-derived and fixed for real in
its own follow-up round — see "Equipment Phase Program attributes" below for the real byte-offset
fix, which this SFC round's own text originally (and correctly, per this project's own checkpoint
discipline) left as an open, not-yet-fixed gap rather than treating that transient patch as done.

**A second, separate pre-existing Python/JS divergence, found only because `SFC_GearChange.ACD`
was run through both pipelines for the first time this round** (this project has real Motion axis
tags — `axis0`/`axis1` — that no prior fixture, in either language, ever exercised): the two
languages' full converted documents differ starting partway through an axis-typed tag's own decoded
initial value (a `DataValueMember` list mismatch — different member names/order past a certain
point, e.g. `ProcessStatus`/`OutputLimitStatus`/`PositionLockStatus` on this (Python) side vs.
`ServoFault`/`ModuleFaults` on the JS side). The `<SFCContent>` section itself is confirmed
byte-identical between the two languages (see above) — this divergence is entirely outside it, in
the ordinary UDT/tag decode path this round never touched in either language. Left as an explicitly
flagged, unresolved finding for a future round (would need the same from-scratch byte-verification
rigor as any other decode gap in this project, starting from a real ground-truth L5X for this
specific project, which is not currently available for `SFC_GearChange.ACD` beyond its own SFC
content) — not investigated further here, consistent with this round's own scope.

## Equipment Phase Program attributes (`Type`/`InitialStepIndex`/`InitialState`/`CompleteStateIfNotImpl`/`LossOfCommCmd`/`ExternalRequestAction`) — SOLVED

Found (diagnosed, not fixed) by the SFC round's own live-simulator check above via a transient,
uncommitted, diagnostic-only patch — this section is the real, from-scratch re-derivation and fix,
in its own follow-up round, with its own verification, per this project's own standing "a
diagnostic patch is not a verified fix" discipline.

**The bug**: `Program`/`ProgramBuilder` never rendered `Type="EquipmentPhase"` (nor the 5
accompanying attributes) on an Equipment Phase Program's own `<Program>` element — every Program
was rendered as an ordinary one, regardless of its real kind. Real ground truth
(`Equipment_Phase_Sequencer.L5X`) has 6 real Equipment Phase Programs, all with identical values:

    <Program Name="Add_Cream_M2" Type="EquipmentPhase" TestEdits="false" Disabled="false"
     InitialStepIndex="0" InitialState="Idle" CompleteStateIfNotImpl="StateComplete"
     LossOfCommCmd="None" ExternalRequestAction="None">

— confirmed identical across all 6 (`Add_Cream_M2`/`Add_Egg_M2`/`Add_Milk_M2`/`Add_Sugar_M2`/
`Agitate_M2`/`Heat_M2`), and confirmed that the same file's one ordinary Program (`Recipe_Ops`)
correctly has none of these 6 attributes at all (`<Program Name="Recipe_Ops" TestEdits="false"
MainRoutineName="MainRoutine" Disabled="false">`).

**Where it lives, and how it was found**: `ProgramBuilder.build()` already reads several
Program-level flags out of the Program's own comps record's extended-record attribute `0x01` (a
large, ~4.2KB blob) — `Disabled` at absolute offset `0x24`, for one. Two hypotheses were checked
against real data before picking one, per this project's own "don't assume" discipline:

1. **A genuinely separate stored flag on the Program's own record** — checked by byte-diffing
   ext `0x1` across all 6 real Equipment Phase Programs against the one real ordinary Program in
   the same file, looking for positions where all 6 EquipmentPhase Programs agree with each other
   but disagree with the ordinary one. Found exactly 2 such byte positions: absolute offset `0xBD`
   (`0x00` for every EquipmentPhase Program, `0x01` for the ordinary one) and `0xBE` (`0x02` vs.
   `0x01`).
2. **Derivable from something else already decoded** (e.g. a `PHASE`-typed local tag or similar
   structural marker, the way `SFC_STEP`/`SFC_ACTION` turned out to be recognizable structural UDTs
   for the SFC round) — a real, separately-named comps object matching each Phase Program's own
   name does exist (`record_type=1280`, `cip_type=0x6B`, presumably the underlying phase-state tag
   the live engine reads, e.g. `engine.tags["Add_Egg_M2"].Complete`), but this is a SEPARATE
   `comps` object from the Program's own record, one extra join/lookup away — not needed, since
   hypothesis 1 already gave a clean, direct, single-record answer. Not investigated further; noted
   here in case a future round finds hypothesis 1's discriminator insufficient for some other real
   project's data and needs a fallback thread to pull on.

Hypothesis 1 was confirmed and used. **Cross-validated far beyond the one available sample**: byte
`0xBD`/`0xBE` were also checked against every ordinary Program in 4 other real projects with no
Equipment Phase content at all (`resources/CuteLogix.ACD`: 3 Programs; `SFC_GearChange.ACD`: 1;
`FBDLevelControlSimulation.ACD`: 1; `RefProjA_V33_R17_4_Changed_AOI_VESSEL.ACD`: 29) — all 30
additional real ordinary Programs show `0xBD=0x01, 0xBE=0x01` (same as `Recipe_Ops`), zero
exceptions. Combined with the 6 real EquipmentPhase Programs, this is a
clean, unambiguous discriminator confirmed against 37 real Programs total (6 positive, 31
negative), checked as a pair (not just byte `0xBE` alone) since both bytes are perfectly correlated
in every real example available and there's no reason to discard the extra confirmation:

    ext[0x1][0xBD] == 0x00 and ext[0x1][0xBE] == 0x02   ->  EquipmentPhase
    ext[0x1][0xBD] == 0x01 and ext[0x1][0xBE] == 0x01   ->  ordinary Program

**The 5 sibling attributes are NOT decoded from any byte field.** Every real EquipmentPhase
Program available (all 6, in the only real project with any) has identical values for all 5 —
`InitialStepIndex="0"`, `InitialState="Idle"`, `CompleteStateIfNotImpl="StateComplete"`,
`LossOfCommCmd="None"`, `ExternalRequestAction="None"` — so there is no contrasting example to find
the real per-attribute encoding against. Rendered as the confirmed-common literal defaults, same
"don't guess a bit mapping to force it" discipline as SFC's `IsBoolean`/`Priority` gaps above — if
a future real project ever shows a different value for any of these 5, that would be a genuine new
finding requiring its own investigation, not something this fix already accounts for.

**XML attribute ordering, a real subtlety worth documenting**: `Program`'s existing `use_as_folder`
field was previously always rendered as `UseAsFolder="false"` unconditionally. Real ground truth
shows NO `UseAsFolder` attribute at all on EITHER a real EquipmentPhase Program or the one real
ordinary Program checked (`Recipe_Ops`) — this is a **separate, pre-existing** discrepancy, not
part of this fix's scope, and it was carefully NOT touched for the ordinary-Program case (its
value stays exactly `"false"`, byte-identical to before this round, confirmed by diffing the full
converted output for every fixture with no Equipment Phase content against its own pre-this-round
baseline). For an EquipmentPhase Program specifically, though, `use_as_folder` now becomes `None`
(omitted) rather than `"false"` — required for correct output (real ground truth genuinely has no
`UseAsFolder` on any real EquipmentPhase Program either), and safe/well-scoped since it only
changes behavior for Programs newly recognized as EquipmentPhase by this same fix, never for an
ordinary Program. The new fields were positioned in `Program`'s own field list (`program_type`
right after `name`; `initial_step_index`/`initial_state`/`complete_state_if_not_impl`/
`loss_of_comm_cmd`/`external_request_action` right after `use_as_folder`) specifically so the
existing reflection-based `L5xElement.to_xml()` (attribute order follows field declaration order,
`None` values are skipped entirely) produces the exact right XML attribute order for BOTH Program
shapes with no special-casing: `Name, Type, TestEdits, Disabled, InitialStepIndex, InitialState,
CompleteStateIfNotImpl, LossOfCommCmd, ExternalRequestAction` for an EquipmentPhase Program
(`MainRoutineName`/`FaultRoutineName`/`SynchronizeRedundancyDataAfterExecution`/`UseAsFolder` all
correctly `None` for one, so skipped), and the original, unchanged `Name, TestEdits,
MainRoutineName, Disabled, UseAsFolder` order for an ordinary one.

**Verified attribute-by-attribute against real ground truth**: all 6 real EquipmentPhase Programs
in `Equipment_Phase_Sequencer.ACD` now render their full `<Program ...>` opening tag **exactly**
byte-for-byte identical to the real L5X export. `Recipe_Ops` (ordinary) and `SFC_GearChange.ACD`'s
own `MainProgram` (ordinary) correctly do NOT get `Type`/`InitialStepIndex`/etc — their own output
is unchanged from before this fix (still missing the separate, pre-existing, out-of-scope
`UseAsFolder` omission noted above, exactly as before).

**Regression-verified**: full `pytest` suite still 111 passed / 2 skipped (the one pre-existing,
environment-specific `test_to_xml` file-lock flake reproduces identically on the unmodified
codebase too, confirmed by stashing this round's change and re-running). Full converted-document
diff (modulo `ExportDate`) for every fixture with NO Equipment Phase content
(`resources/CuteLogix.ACD`, `FBDLevelControlSimulation.ACD`,
`RefProjA_V33_R17_4_Changed_AOI_VESSEL.ACD`) confirmed **byte-for-byte unchanged** by this round —
zero regressions outside the intended Equipment Phase Program fix.

## `VisiblePins` is a per-block-TYPE default, not "pins observed wired" — SOLVED (real
## PLC-Studio rendering bug, found because the multi-sheet round's own verification was blind to it)

The multi-sheet round above claimed the converted `FBDLevelControlSimulation` output "verified
exactly" — every block/wire/connector matched ground truth as a *set*. That was true and also not
enough: loading the actual converted file into a real third-party FBD-capable viewer (PLC-Studio)
showed it falling back to a generic "not yet supported" placeholder for `MainFBD` — not a garbled
render, a full refusal to recognize the routine as renderable FBD content at all — while the
original Studio 5000 export of the same routine rendered completely. The gap: `verify_all_fbd.py`
(and every "exact match" claim built on it) only ever parsed each `<Block>`'s own `Operand`/`Type`
into the comparison set — it never read the `VisiblePins` attribute's actual *value*, so a real,
severe bug in that one attribute sailed through every prior round undetected.

**Root cause**: `VisiblePins` had been assumed (and documented, repeatedly) to be "the pins this
decode actually observed wired" — plausible-sounding, and wrong. Checked properly this round by
extracting every real `<Block Type="..." VisiblePins="...">` from two independent ground-truth
projects (`RefProjA_V33_R17_4.L5X`, `FBDLevelControlSimulation.L5X`): **12 of the 13 built-in
instruction types seen have an IDENTICAL VisiblePins string across every real instance of that
type, project-wide** — `ADD`/`BNOT`/`D2SD`/`DEDT`/`GRT`/`HLL`/`LDLG`/`MUL`/`PIDE`/`RLIM`/`SCL`/
`SUB`/`TONR` all confirmed constant regardless of instance-specific wiring. This is a genuine
Rockwell UI convention — a fixed default pin-visibility set baked into Studio 5000 itself for each
instruction type, analogous to (and just as unrecoverable from the ACD binary as) the hand-
maintained `catalog_numbers.py`/`port_structures.py` lookup tables already in this codebase. The
old wired-pins-only approach silently dropped every pin that's real-and-shown-by-default but
happens not to be a wire endpoint in this specific instance — e.g. `DEDT_01`'s own `Out` pin (never
a wire *destination*, only ever a *source*, so the old `block_pins_seen` tracking — built solely
from wire destinations — never recorded it) was missing from `VisiblePins`, while a real `<Wire
FromParam="Out">` still referenced it. That specific self-inconsistency — a `Wire`'s own
`FromParam`/`ToParam` naming a pin absent from that block's own declared `VisiblePins` — is almost
certainly what a real third-party parser trips on hard enough to bail to "unrecognized" rather than
render a merely-incomplete diagram.

**Fix**: `_FBD_BLOCK_DEFAULT_VISIBLE_PINS` (`acd/l5x/elements.py`) is a hand-maintained table
(built directly from the ground-truth strings above) keyed by upper-cased instruction Type;
`_render_fbd_content()`'s plain-`<Block>` branch uses it when the type is known, falling back to
the old observed-wired-pins behavior only for a type with no ground-truth backing (documented as
still-incomplete for those, not silently treated as solved).

**`ALMA` is the one built-in type that is NOT a per-type constant** — 4 different real
`VisiblePins` strings observed across different `ALMA` instances in the same project, varying with
which alarm limits (`HH`/`H`/`L`/`LL`) that specific instance has enabled. Left out of the table
deliberately; `ALMA` blocks keep falling back to the old (still real, still incomplete)
observed-wired behavior. **This is a real, still-open gap** — `ALMA` instances (and AOI-instance
blocks, see below) are not fixed by this round and may still trip the same PLC-Studio "unrecognized
routine" failure mode. Whether the enabled-alarm-level pattern is cleanly derivable from each
`ALMA` instance's own decoded `HHEnabled`/`HEnabled`/`LEnabled`/`LLEnabled` tag values (plausible,
not yet investigated) is a follow-up, not something this round attempted or verified.

**AOI-instance blocks (`<AddOnInstruction>`) have the exact same class of problem, also unsolved**:
checked the same way against both ground-truth projects, and `VisiblePins` for an AOI instance is
**not** simply "that AOI's own declared parameter list" either — tried that hypothesis directly
against `AOI_VESSEL` (an AOI actually used inside an FBD network in the RefProjA project) and it failed:
ground truth's real `VisiblePins` for `AOI_VESSEL`'s own instances is a ~32-name *subset* of its own
~47 non-`EnableIn`/`EnableOut` parameters, in a different order than declaration order, omitting
whole parameter sub-groups (e.g. a `SCALED_LEVEL`/`DISP_RAWLO`/... "scaling display" group, and an
entire `OAHH_EN`.../`OALL` "operator-alarm" group tied to `OPER_LVL_ALM`) — this looks like a
genuine per-AOI-definition "configure visible pins" preference stored somewhere in the AOI's own
definition data, not derivable from anything already decoded. Not attempted further this round;
this is real reverse-engineering work still to be done, not a simple table lookup like the 12
built-in types above.

**A second, independent real bug found in the same investigation**: `DEDT`'s own compiled call
carries an extra positional argument beyond its operand (`DEDT(DEDT_01,DEDT_01array)`, the same
`extra_args` mechanism already used for AOI-instance InOut binding) that real Studio renders as a
genuine `<Array Name="StorageArray" Operand="DEDT_01array"/>` child of `<Block Type="DEDT">` —
previously rendered as nothing at all (a bare self-closed `<Block .../>`). **This does NOT
generalize to "any block with extra_args gets an Array child"** — tried that first and it broke
`PIDE`, whose own compiled call is `PIDE(LevelController,0)`: that trailing `0` is a bare literal
(an internal compiled-form artifact, e.g. a revision/variant flag) that renders as **nothing** in
real Studio output (`PIDE`'s own `<Block>` is plain and self-closed, no extra attribute or child).
Fixed by scoping the `<Array Name="StorageArray">` emission narrowly to `DEDT` specifically, not
generically to every type with extra args — a repeat of the exact lesson the AND/math-block
convention taught earlier in this same file: verify a new mechanism against every real example
available before generalizing it, not just the first one found.

**Verified end-to-end**: with both fixes, the full `MainFBD` routine (both sheets) now matches the
real `FBDLevelControlSimulation.L5X` ground truth exactly — block Type/Operand/**VisiblePins**/
`<Array>` child content, every `Wire`/`FeedbackWire`, and the one `OCon`/`ICon` connector pair, all
checked directly (not via the old, blind-to-`VisiblePins` set-based comparison). Re-ran the same
richer check against the RefProjA project: the 12 now-tabled built-in types (where present) also now
match ground truth's `VisiblePins` exactly project-wide; `ALMA` and every AOI-instance block remain
mismatched, exactly as expected given the still-open gaps above — **re-testing RefProjA's own converted
output in a real FBD-capable viewer, specifically routines using `ALMA` or an AOI instance, is
still an open action item, not something this round can claim to have closed.** Full `pytest` and
`npm test` both still pass with no regressions; ported the same fix to JS
(`FBD_BLOCK_DEFAULT_VISIBLE_PINS` in `js/l5x/elements.js`) and re-confirmed byte-for-byte identical
output between Python and JS on both real projects.

**Also checked and ruled out, per this round's own investigation checklist** (documented so the
next person doesn't have to re-derive these): `<FBDContent>` is correctly nested as a direct child
of the right `<Routine Name="MainFBD" Type="FBD">` element (not misplaced/duplicated); top-level
`RSLogix5000Content`/`Controller` metadata (`ExportOptions`, `SoftwareRevision`, schema) differs
between the converted output and this specific ground truth file only in ways that are additive or
expected, not something a routine-type/content detector would plausibly key off; and the one real
attribute-level difference PLC-Studio's own Compare feature flagged outside `MainFBD` itself —
`Local:0`'s `CatalogNumber` (`1756-L63` real vs `1756-L73` converted) — is fully explained and
benign: the `.ACD` file's own internal controller revision (`MajorRev="33" MinorRev="11"`,
`ProductCode="94"`) genuinely differs from the ground-truth `.L5X`'s (`MajorRev="17" MinorRev="2"`,
`ProductCode="56"`) — two different save-points/versions of the same sample project, not a
converter bug — confirmed by checking that `94 → "1756-L73"` is itself a real, correct
`catalog_numbers.py` entry, not a wrong guess reading the right bytes wrong.

**Not independently re-verified this round**: whether the fixed output actually opens and renders
correctly in a live PLC-Studio session — every check above is the most rigorous *offline* text/
structural diff achievable against the real ground-truth L5X (attribute-by-attribute, not just
element-set comparison), which is what actually caught this bug, but it is not the same as the
literal interactive load-and-look the user performed to originally find it. Treat "verified" here
as "matches real Studio 5000 output exactly, byte-for-byte, for every attribute checked" — the
actual PLC-Studio render-check is still the outstanding confirmation step for this specific fix.

**That outstanding confirmation step is now automated.** `plc_studio.html` (the external
Studio-5000-like L5X viewer/simulator the user built separately, repo `barry-heap/plc-studio`,
not accessible via cross-repo GitHub access from this codebase's own sessions) is committed at
`js/plc_studio.html` specifically so it's available to every future session without
being re-pasted. `js/test_plc_studio_fbd.js` drives it headlessly (same Playwright +
pre-installed-Chromium approach as `js/test_browser.js`): load the page, upload a converted
`.L5X` via `#fileInput`, wait for `#fileLabel`'s text to match the uploaded file's own basename
(the app auto-loads its own embedded demo model on open, so naively waiting on `window.model`
alone races with — and is satisfied by — that stale demo, not the just-uploaded file), then for
each `program:ProgramName:RoutineName` / `aoi:AOIName:RoutineName` spec, resolve the routine's
internal `routineId` via the in-page `model.programs`/`model.aois`/`model.routines` maps and call
`openRoutine(routineId)` directly (deterministic — avoids clicking through the collapsible tree
DOM, which is fragile when the same routine name repeats across scopes, e.g. multiple AOIs each
having their own "Logic" routine).

The check inspects `#tabContent` for the specific failure signature that caught the VisiblePins
bug: `renderUnsupportedTab()`'s generic fallback note, literal text `"...not yet supported by
this tool..."` — **not** simply the presence of a `.skip-note` element, since that CSS class is
reused for a second, benign, always-present explanatory caption shown *alongside* a real rendered
FBD sheet whenever FBD content DOES render (confirmed by testing against the app's own bundled
demo routine, `Trending/Trend_Main`, which renders successfully despite its own stale embedded
XML comment claiming otherwise — the comment predates the app's own FBD renderer being written
and was never updated). The authoritative success signal is `sheetCount > 0` (real
`<svg class="fbd-sheet">` content actually drawn); the fallback-text check only matters as the
*reason* when no sheet rendered.

Run against both real ground-truth cases this investigation established:
- `FBDLevelControlSimulation`'s converted output (`program:ProcessSimulation:MainFBD`) — **PASS**,
  2 sheets/17 blocks/11 wires, confirming the VisiblePins/DEDT-`<Array>` fix resolved the actual
  PLC-Studio symptom, not just the offline attribute diff.
- All 28 of RefProjA's real FBD routines, including the ones flagged above as not fitting the
  per-block-type `VisiblePins` table (`_77Proc`/`PROC_RATE_ALARM`, both `ALMA`-using; all 24
  `TKxx` routines plus `AOI_VESSEL`'s own `Logic` routine, all using the `AddOnInstruction`
  rendering path) — **28/28 PASS**. The still-open `ALMA`/AOI-instance `VisiblePins` gap does
  **not** currently trigger this fallback failure mode; it's a real but subtler
  attribute-completeness gap this DOM-text check cannot see (it doesn't inspect `VisiblePins`
  values at all, only whether a sheet renders).

**This is a coarse, cheap regression guard for "did this fail outright" — it is not a substitute
for an occasional real visual check of whether wires land on the right pins/sheets.** Keep doing
both; a routine can pass this check (a sheet renders, blocks/wires are drawn) while still having a
real fidelity bug the same class as `VisiblePins` that only surfaces on visual inspection or a
deep attribute-level ground-truth diff.

## ALMA `VisiblePins` tier-bit rule — CONFIRMED and implemented for the 12 tier pins; AOI-instance gap remains fully open

Follow-up investigation into the two gaps left open above (`ALMA` and AOI-instance `VisiblePins`).
Two separate investigations, one per gap, run in parallel — do not let a fix for one bend into the
other; they turned out to need genuinely different resolutions.

**ALMA — confirmed and implemented.** Gathered every real `ALMA` instance available anywhere in
this repo's ground truth: **7 real instances total** in `RefProjA_V33_R17_4.L5X`, not the "4
different `VisiblePins` strings" originally estimated by eyeball — re-grepped properly and found
`COND_CT_A001_ALM`, `PROC_TT_A001_ALM` (in `PROC_RATE_ALARM`), `A002_ALM` (in `_77Proc`),
plus **4 previously-missed instances** — `ROOF_ALM`/`LEVEL_ALM`/`OPER_LVL_ALM`/
`PROG_ALM` — living inside `AOI_VESSEL`'s own definition `Logic` routine (its InOut
parameters, generic/unbound at the AOI-definition level). 4 distinct `VisiblePins` strings across
those 7 (the AOI-internal 4 are byte-identical to each other). No other real `ALMA` instance exists
in any fixture, sample project, or `.ACD`/`.L5X` file checked into any repo in this tree
(`Test_FBD.ACD`/`.L5X` and `PROC_RATE_ALARM_Routine_FBD.L5X` are just extracts of the same 2
COND_*_ALM instances; the Rockwell sample projects have zero `ALMA` instances at all).

**The real mechanism**: each `ALMA` block instance has its own element node in the SAME per-block
FBD-diagram metadata tree `_fbd_decode_sheets()` already walks for sheet membership (hanging off
the shadow region's own nameless `parent_id`) — a `record_type=0x01000002` node whose u32 at offset
16 is `0x0005008C` (confirmed constant across all 7 real `ALMA` element records, distinct from
every other real block type's own tag at that offset seen in the same ground truth, e.g. TONR's
`0x0002005B`). Bytes 24:28 and 28:32 of the same record are the block's own X/Y diagram position —
verified byte-exact (`int32` LE) against all 7 real instances' ground-truth `<Block X="..."
Y="...">` attributes, strong proof this record is genuine per-instance Studio-authored metadata,
not shared/derived data (the same category of evidence the Multi-sheet FBD section above used).
**Byte 35's low nibble (bits 0-3) is a per-tier "Enabled" bitmask** — bit0=HH, bit1=H, bit2=L,
bit3=LL — confirmed to reproduce all 7 real instances' `HHEnabled`/`HEnabled`/`LEnabled`/
`LLEnabled` *presence* in `VisiblePins` exactly (`COND_CT_A001_ALM`'s L+LL both enabled → nibble
`0b1100`; `PROC_TT_A001_ALM`'s LL only → `0b1000`; `A002_ALM`'s H only → `0b0010`; the 4
AOI-internal instances' all four enabled → `0b1111`). This nibble is also byte-identical to each
instance's own `AlarmAnalogParameters` `HHEnabled`/`HEnabled`/`LEnabled`/`LLEnabled` tag values
where a real backing tag exists (the 3 non-AOI-internal instances) — two independent lines of
evidence agreeing. Implemented as `_fbd_decode_alma_tier_pins()` in `acd/l5x/elements.py`
(JS: `fbdDecodeAlmaTierPins()` in `js/l5x/builders.js`), feeding `_render_fbd_content()`'s/
`renderFbdContent()`'s `ALMA`-specific branch: each enabled tier contributes its own
`<Tier>Enabled`/`<Tier>Limit`/`<Tier>InAlarm` trio, in canonical `HH,H,L,LL` order.

**Deliberately NOT derived, left on the pre-existing observed-wired fallback** (confirmed
aliased/undecidable from the available real data — do not guess further to force a fit):
- `AckRequired`/`Suppressed`/`Disabled`: a candidate bit (byte 35 bit 4, plus correlated bits
  elsewhere in the record) tracks these in the 7 known instances, but is **100% aliased** with the
  HH-tier/H-tier enabled bits respectively in every available real sample (every instance with
  `AckRequired`/`Suppressed` shown also has the HH tier enabled; every instance with `Disabled`
  shown also has the H tier enabled or is one of the 4 AOI-internal ones) — cannot distinguish "own
  independent bit" from "coincidental co-occurrence" without a real counter-example instance, which
  does not exist anywhere in this repo's ground truth.
- Bare `InAlarm`: shown only in the two non-AOI-internal, non-`A002` instances (`COND_CT`/
  `COND_TT`) — plausibly "shown iff `AckRequired` is NOT shown", but only 2 real data points touch
  this, not enough to confirm a structural rule.

**A separate real ground-truth anomaly, also not modeled**: `PROC_TT_A001_ALM` has ONLY its LL
tier enabled, yet its real `Limit` pin is named `"LLimit"` (the L tier's own canonical name) rather
than `"LLLimit"` (the LL tier's own canonical name that `COND_CT_A001_ALM` — which has BOTH
tiers enabled — correctly uses alongside its own `"LLimit"` for the L tier). The implementation
always emits each enabled tier's own canonical `Limit`-pin name, so rendering
`PROC_TT_A001_ALM` shows this one specific, known, non-guessed-around mismatch — a genuine
Rockwell naming quirk (or bug) in the one real sample that exercises "LL enabled alone".

**Verified**: all 7 real instances' tier-scoped pins (`<Tier>Enabled`/`<Tier>Limit`/`<Tier>InAlarm`)
now match ground truth exactly, zero exceptions. Residual, expected, documented-above mismatches
remain for `COND_CT_A001_ALM`/`PROC_TT_A001_ALM` (missing bare `InAlarm`), `A002_ALM`
(missing `Disabled`), the COND_TT Limit-naming anomaly, and the 4 AOI-internal instances (missing
`Suppressed`/`Disabled`) — all pre-existing/expected, none newly introduced. Full whole-project
`ConvertAcdToL5x` output for `RefProjA_V33_R17_4.ACD` re-diffed directly against JS's
`convertAcdToL5x()` output: **byte-for-byte identical** (2,953,353 characters, modulo the usual
per-run `ExportDate`), same for `FBDLevelControlSimulation.ACD` and `Test_FBD.ACD`. All 28 of
RefProjA's real FBD routines, plus `FBDLevelControlSimulation`'s `MainFBD`, re-ran through the
PLC-Studio render check (`js/test_plc_studio_fbd.js`): still 28/28 and 1/1 PASS, zero regressions.
Full `pytest` (111 passed, 2 skipped, one pre-existing unrelated `pytest-asyncio` error, plus one
newly-observed Windows-only test-isolation flake in `test_api.py::test_to_xml` — passes in
isolation, fails only when run in the same process as other tests that leave a SQLite file handle
open on Windows; confirmed unrelated to this change, since it touches zero SQLite-connection-
lifecycle code) and `npm test` both still pass.

**AOI-instance `VisiblePins` — remains fully open.** A sibling investigation this session tested
the "AOI parameter has its own `Visible="true"/"false"` attribute, settable by the AOI's author,
independent of Input/Output/InOut usage type" hypothesis directly against real ground truth
(`AOI_VESSEL`'s own `AddOnInstructionDefinition` `<Parameter>` elements do carry a real `Visible`
attribute in the L5X) and **rejected it** — it does not reproduce the real, observed
`VisiblePins` subset/ordering for `AOI_VESSEL`'s own 24 real call-site instances. No raw-metadata
excavation (the same byte-offset approach that solved `ALMA` above) has been attempted yet for
AOI-instance blocks — worth trying next, following the identical method, but genuinely unattempted
this round. `AddOnInstruction` blocks are untouched by this round's code change and remain exactly
on the pre-existing "observed wired + own InOut parameter names" fallback.

## AOI-instance `VisiblePins` default rule — CONFIRMED and implemented; `AOI_VESSEL` remains a real, documented exception

Follow-up to the AOI-instance gap left open above. The "declared parameter `Visible="true"`, in
declaration order (excluding `EnableIn`/`EnableOut`)" hypothesis — rejected earlier against
`AOI_VESSEL` alone — is **confirmed exactly** once tested against real ground truth beyond `AOI_VESSEL`:

- Two AOI types in the official Rockwell sample project `Add_On_Instructions_Samples.L5X`
  (untouched since 2007) — `LoopSimulation` (`Visible="true"` on exactly `LoopOutput`/
  `SimulatedPV`/`DeadtimeInv` → real `VisiblePins="LoopOutput SimulatedPV DeadtimeInv"`) and
  `TankLevelSimulation` (`Visible="true"` on exactly `FlowIntoTank`/`FlowOutOfTank`/`TankLevel` →
  real `VisiblePins="FlowIntoTank FlowOutOfTank TankLevel"`) — both exact string and order matches.
- `AOI_ALM2` (`RefProjA_V33_R17_4.L5X`) is genuinely FBD-placed (routine `UNIT_STATUS`, real
  `<Wire>`s feeding `PRI_IN1`-`PRI_IN5` from real `IRef`s — re-confirmed directly, not a
  misattribution) and is trivially consistent too: all 6 non-system parameters are `Visible="true"`,
  matching its real 6-name `VisiblePins` exactly.

**`AOI_VESSEL` remains the one real, confirmed exception** — re-checked directly against the raw L5X:
`GAHH`/`GAH`/`GAL`/`GALL`/`GAHH_EN`/etc. are genuinely `Visible="false"` in the definition yet shown
in real `VisiblePins`, while `OAHH_EN` (also `Visible="false"`) is correctly hidden. Not a misread.

**A further, genuine search for a per-instance override field for `AOI_VESSEL` came up empty**, ruling
out three real candidate locations (not guessed at, not force-fit):
1. `AOI_VESSEL`'s own per-call-site FBD element record (`record_type=0x01000002`, u32 at offset 16 =
   `0x0002008A` — a distinct tag from ALMA's `0x0005008C`, confirmed genuine per-instance diagram
   metadata via byte-exact X/Y position match against all 5 real instances with known coordinates,
   `AOI_VESSEL` and `AOI_ALM2` alike). This record's own count-prefixed list of `comps.object_id`
   references (same `count:u16` + `N × (u32 object_id, u32=1)` shape found for both AOI types) is
   confirmed to be **wired-input-pins bookkeeping, not a display-visibility selection** — proven by
   two independent facts: (a) for `AOI_ALM2`, the list's per-instance content (3/4/3/5 entries)
   exactly equals each instance's own actually-wired `PRI_IN*` pins from the compiled FBD rung
   network, and never includes the never-wired `PRIOUT`, yet real `VisiblePins` always shows all 6
   including `PRIOUT` — the list plainly isn't the answer; (b) for `AOI_VESSEL`, the list has 28
   entries (matching the 28 non-InOut real `VisiblePins` names as a SET) while the compiled rung
   network for a real instance (`TANK01`) wires only ONE pin (`DISP_IN`; zero `oref_writes` at all) —
   directly contradicting the "wired pins" reading that fit `AOI_ALM2`, so the field cannot mean
   the same thing for both types, and doesn't explain `AOI_VESSEL`'s real `VisiblePins` either way.
2. Each `Parameter`'s own raw flags byte (`ext01[0x20e]`, already decoded for `Usage`/`Required`/
   `Visible` via bits `0x0c`/`0x20`/`0x40`) has 4 otherwise-unused bits (`0x01`/`0x02`/`0x10`/`0x80`)
   — checked directly against all 51 of `AOI_VESSEL`'s real declared parameters: **every** non-InOut
   `Input`-usage parameter (included or excluded from real `VisiblePins` alike) has this byte equal
   to exactly `0x04`; every `Output`-usage one equal to exactly `0x08` — zero variation whatsoever
   between the 32 shown and 19 hidden parameters. Conclusively rules out this byte as the source.
3. The `AddOnInstructionDefinition`'s own top-level extended records (`comps.record`'s own
   `extended_records`, same mechanism `revision`/`vendor` are already read from) — only 4 small
   (≤4-byte) attributes exist beyond the main 263-byte one, none list-shaped, no room for a
   32-element selection.

**Working theory, not yet provable either way**: `Visible="true"` declared order is the genuine
*default* rule, applying straight-through whenever an instance's pins were never individually
touched; `AOI_VESSEL` — actively edited very recently (`EditedDate="2026-07-15"`) — may be a case
where a real per-instance (or per-definition) override was made through Studio's own diagram UI and
is stored somewhere not yet found, OR the zero-variation-across-24-real-instances pattern (every
real `TANK01`..`TANK35` byte-identical) may instead mean this is a per-AOI-TYPE authored default that
just isn't derivable from anything decoded so far -- both remain open, undecided by the evidence in
hand.

**Implemented**: `_render_fbd_content()`'s `AddOnInstruction` branch (`elements.py`) now uses the
default rule (`aoi_default_visible_pins`, built in `ControllerBuilder.build()` right alongside
`_aoi_inout_order`, attached to each FBD `Routine` post-hoc the same way) for every real AOI type
**except** `AOI_VESSEL`, which is deliberately excluded from that map and falls straight through to
the pre-existing observed-wired+InOut-names fallback, unchanged — a real, still-open gap, not
silently forced to fit. Ported identically to JS (`fbdDecodeAlmaTierPins`'s sibling map,
`aoiDefaultVisiblePins`, in `js/l5x/builders.js`/`js/l5x/elements.js`).

**Verified**: `AOI_ALM2`'s real `VisiblePins` (`"PRIOUT PRI_IN1 PRI_IN2 PRI_IN3 PRI_IN4 PRI_IN5"`)
now matches exactly for all 4 real instances, both languages. `AOI_VESSEL`'s own rendered
`VisiblePins` (`"DISP_IN LEVEL_ALM PROG_ALM OPER_LVL_ALM ROOF_ALM"`, the pre-existing
observed-wired+InOut fallback) is **confirmed byte-identical to its pre-this-round output** across
all 24 real `TK*` instances — no regression. Full whole-project `RefProjA_V33_R17_4.ACD` output:
Python and JS **byte-for-byte identical** (2,953,421 characters, modulo `ExportDate`). All 28 of
RefProjA's real FBD routines PASS the PLC-Studio render check (`js/test_plc_studio_fbd.js`), plus
`FBDLevelControlSimulation`'s `MainFBD` (2 sheets/17 blocks/11 wires, unchanged) — zero regressions.
`FBDLevelControlSimulation.ACD`/`Test_FBD.ACD` (neither has AOI-instance content) confirmed
byte-identical to their own pre-this-round baselines. `Add_On_Instructions_Samples.L5X` has no
matching `.ACD` in this environment, so it could only be checked by direct inspection against the
implemented rule (done, matches exactly per above), not run through the actual conversion pipeline.
Full `pytest`/`npm test` both still pass (same one pre-existing, unrelated Windows-only
`test_api.py::test_to_xml` file-lock flake as every prior round on this platform).

**Not committed** — held in the working tree pending review, per this round's own explicit
constraint: `AOI_VESSEL`'s real routines must not regress, and they don't (confirmed above), but the
override-field hunt came up empty rather than closing the gap outright.

## AOI-instance `VisiblePins` — follow-up: the union rule closes `AOI_VESSEL` too, plus a real parameter-ordering bug fixed along the way

Barry supplied a controlled before/after ground-truth pair (`compare-test/RefProjA_V33_R17_4.L5X`
and `..._changed.L5X`, no matching `.ACD`, L5X-only): the only change is 6 `AOI_VESSEL` parameters
flipped `Visible="false"`→`"true"` (`DISP_IN`, `SCALED_LEVEL`, `GAHH_VAL`, `GAH_VAL`, `GAL_VAL`,
`GALL_VAL`). Only ONE new pin appeared in all 24 instances' real `VisiblePins`: `SCALED_LEVEL`. The
other 5 were already shown before the flip — flipping them made zero observable difference. That's
the signature of a **union rule**: `VisiblePins = (a per-instance persisted set) ∪ (currently
declared Visible="true" params)`. A param already in the persisted set is a no-op when its flag
flips; a param newly flagged visible gets added only if it wasn't already there.

This reframes the earlier override-hunt finding rather than requiring new raw-byte work:
`AOI_VESSEL`'s own per-block record (tag `0x0002008A`) holds a 28-entry list that set-matches the 28
non-InOut real `VisiblePins` names exactly — previously dismissed as wired-pins bookkeeping (the
compiled network for a real instance only wires 1 pin). Under the union theory this **is** the
persisted set: declared `Visible="true"` currently gives exactly `AOI_VESSEL`'s 4 InOut params, and
4 + 28 = 32 = the real total. `AOI_ALM2`'s "wired pins" reading never actually distinguished the
two theories — its own `Visible="true"` set alone already covers its entire real `VisiblePins`
regardless of what its own per-instance list holds.

**A real, separate ordering bug found and fixed while verifying this to the "exact order" bar.**
The union, filtered/sorted by "declaration order" using the pre-existing ordering (`ORDER BY
seq_number`, then implicit row order), did NOT reproduce the real order — `seq_number` is only a
coarse tier stamp (`0` for every InOut parameter, `16` for every Input/Output/local one, confirmed
across all of `AOI_VESSEL`'s real 51 members and `AOI_ALM2`'s 9), not a real declaration order at
all. Real Studio interleaves InOut parameters among Input/Output ones by their own authored
position (real `AOI_VESSEL` order: `EnableIn, EnableOut, DISP_IN, SCALED_LEVEL, LEVEL_ALM (InOut),
DISP_RAWLO, ...` — not "all 4 InOut first"). **This is a real, previously undetected bug in
`AoiBuilder.build()`'s own parameter/local-tag ordering** — confirmed by checking our own shipped
(pre-this-fix) `AOI_VESSEL`'s own `<Parameters>` XML block against real ground truth: it was already
wrong (all 4 InOut parameters emitted first), unrelated to `VisiblePins` specifically. Found the
real ordinal field: a `u16` LE value at **byte offset 6** of each tag-collection member's own raw
`comps.record`, confirmed to reproduce real declared order exactly for both `AOI_VESSEL` (51 members)
and `AOI_ALM2` (9, including its own interspersed `LocalTag`). Fixed in `AoiBuilder.build()`: the
existing `ORDER BY seq_number` SQL fetch is now re-sorted in Python by this ordinal before the
parameter/local-tag split, instead of trusting the SQL-level order.

**Implemented, replacing the earlier AOI_VESSEL-excluded default rule**: `_fbd_decode_aoi_block_lists()`
(new, alongside `_fbd_decode_alma_tier_pins()`) decodes each AOI-instance call site's own persisted
pin list (same record type/BFS mechanism as ALMA's tier bits, tag `0x0002008A`). `ControllerBuilder.
build()`'s `_aoi_default_visible_pins` now stores `{"order": [...], "visible_default": {...}}` per
AOI type (the full non-EnableIn/EnableOut declared order, plus the Visible="true" subset) for
**every** AOI, no more `AOI_VESSEL` exclusion. `_render_fbd_content()`'s `AddOnInstruction` branch
computes `union(visible_default, per_instance_override)`, filtered through `order` (which sorts as
a side effect of iteration, no separate index map needed).

**Verified**: all 24 real `AOI_VESSEL` instances and all 4 real `AOI_ALM2` instances now match
`compare-test/RefProjA_V33_R17_4.L5X` ground truth **exactly**, order included — not "no
regression from fallback," full correctness. The per-instance 28-entry list is confirmed
byte-identical across all 24 real `AOI_VESSEL` call sites (a persisted snapshot from AOI-definition
edit time, consistent with every real `TK*` routine being a template copy of one original
placement). `AOI_VESSEL`'s own `<Parameters>` XML block order also now matches real ground truth
exactly (51/51), a bonus correctness fix from the same root-cause repair. Full whole-project
`RefProjA_V33_R17_4.ACD` conversion: Python and JS **byte-for-byte identical**
(2,957,933 characters, modulo `ExportDate`). All 28 of RefProjA's real FBD routines PASS the PLC-Studio
render check, plus `FBDLevelControlSimulation`'s `MainFBD` — zero regressions.
`FBDLevelControlSimulation.ACD`/`Test_FBD.ACD` (no AOI-instance content) confirmed byte-identical to
their own pre-this-round baselines (the parameter-ordering fix doesn't touch them). Full
`pytest`/`npm test` both still pass (same one pre-existing, unrelated Windows-only
`test_api.py::test_to_xml` file-lock flake as every prior round on this platform).

**Not committed** — held in the working tree pending review, same discipline as every round.

## Ingestion robustness (`_parse_records` in `export_l5x.py`)

`Comps.Dat`/`SbRegion.Dat`/`Comments.Dat`/`Nameless.Dat` ingestion used to abort the *entire*
import if a single record failed to parse (one `UnicodeDecodeError`/`struct.error` on newer
firmware, e.g. V33+, previously made a whole ACD unloadable — matches symptoms reported against
upstream `hutcheb/acd` issues #14/#15). `_parse_records()` now parses each `.Dat` file's records
one at a time, skipping (and counting) any record whose parser raises, logging a single
`log.warning("<Table>: skipped N unparseable record(s) of M")` instead of propagating — a missing
or wholly unreadable `.Dat` file degrades to an empty table the same way rather than raising.
`TaskBuilder`'s scheduled-program list is also bounds-checked against the record buffer (a
firmware-version-dependent layout could otherwise read a garbage count past the end of the
buffer), and a single task that still can't decode is skipped with a warning rather than aborting
`ControllerBuilder.build()` entirely. Adapted from an open, unmerged PR against `hutcheb/acd`;
existing test suite (which only exercises files that already parse cleanly) is unaffected by
design — this only changes behavior on records/files that previously would have raised.

## Native-import escape hatches for write-back (routine L5X is the one active mechanism)

Because `FileInfo.Dat` is enforced on open (see "ACD write-back"), the sanctioned way to get an
edit into a project is to hand Studio 5000 a file it imports through its own UI — Studio then
does the binary write + re-sign. **`export_routine()` (partial L5X via "Import Routine") is the
one actively-developed, verified-end-to-end mechanism** — it now covers both rung edits (its
original purpose) and tag-level edits (description/value), the latter via the routine-carrier
trick below, per user direction. CSV "Import Tags" was explored as an alternative and is kept
below for reference, but **deprioritized**: the user does not want to rely on CSV. A standalone
single-tag partial-L5X exporter (via Studio's "Import Component") was also drafted early in this
investigation but removed before merging — its wrapper was never calibrated against a real
Studio single-tag export, and the routine-carrier approach superseded the need for it entirely.

### Tag CSV import format (Rockwell "CSV-Import-Export")

Reverse-engineered from a real `...-Tags.CSV` "Export Tags" output and verified reproducible
from our own parsed object model (100% of controller-scope base-tag DATATYPE fields and 99.9%
of DESCRIPTION fields regenerated byte-exact for a real 2724-tag project; the last handful are
rare escape chars, still being chased). Layout:
- Preamble: five `remark,"..."` lines (`CSV-Import-Export`, Date, `Version = RSLogix 5000 vNN.NN`,
  Owner, Company), then a bare `0.3` version line, then the column header
  `TYPE,SCOPE,NAME,DESCRIPTION,DATATYPE,SPECIFIER,ATTRIBUTES`. Encoding is latin-1, CRLF lines.
- Row TYPEs seen: `TAG` (base tag), `ALIAS` (SPECIFIER = the AliasFor operand, DATATYPE empty),
  `COMMENT` (per-element/bit description; SPECIFIER = the full operand *including* the tag name,
  e.g. `IO074:I.DATA[0].0`), `RCOMMENT` (rung comments — same 582 count our RegnLink.Idx work
  resolves), `TYPE` (datatype/UDT declarations).
- `SCOPE`: empty = controller; a program name for program-scope; `<AOIName>:AOI` for AOI-local
  tags.
- `DATATYPE` **folds the array dimension in** (`DINT[64]`, `STRING[960]`) — our model stores
  `data_type` and `dimensions` separately, so recombine them here.
- `DESCRIPTION`/comment text uses the **raw multi-line** description (NOT `Tag.description`,
  which deliberately collapses newlines — use the empty-path entry of `Tag._comments`), with
  Rockwell's `$` escapes: `$` → `$$` (do this first), newline → `$N`, tab → `$T`,
  apostrophe `'` → `$'`. The whole field is then CSV-quoted.
- `ATTRIBUTES`: `(RADIX := …, Constant := …, ExternalAccess := …)` for controller/program base
  tags; program/AOI tags add `Usage := Local/Input/Output/InOut` and `Required`/`Visible`; the
  key set present varies by tag kind (some omit `RADIX`, InOut params omit `Constant`).

Studio's Import Tags accepts a *subset* CSV (just the preamble + header + the changed rows), so
an edit doesn't require regenerating all rows.

**Deprioritized per user direction**: the user does not want to rely on CSV import/export as the
tag-edit mechanism. The format reverse-engineering above is kept for reference (it's real,
verified-reproducible knowledge), but the active path for tag edits is the routine-carrier
mechanism below, not `export_tags_csv()`.

### Tag edits via the routine-import overwrite prompt (the active mechanism)

Confirmed by the user: Studio 5000's **Import Routine** dialog offers to overwrite a tag's
description when the imported file's `<Tag>` context element differs from what's already in the
project. Since `export_routine()` already embeds a full `<Tag>` definition for every
controller-/program-scope tag a routine's rung text references (see below), a tag-level edit
(description, value, ...) can be pushed through the *already-verified* routine-import path with
no new binary/XML format to trust:

1. Find an existing routine whose rung text already references the target tag by name (a
   controller-scope tag can be referenced from any routine in the project; a program-scope tag
   only from routines in its own program).
2. Edit the tag's description (or other field) on the in-memory `Tag` object.
3. `export_routine()` that *unmodified* routine — the routine's own logic doesn't change, but the
   tag's context `<Tag>` element now carries the edit.
4. Import in Studio; accept the overwrite prompt for the tag.

**Real limitation, measured on the current project** (`BPM_TrimmerSorter_20260709.ACD`): a
sizeable fraction of tags are never referenced in any routine's ladder or ST text at all —
**35% of controller-scope base tags, 59% of program-scope base tags** (measured by building the
full set of identifier tokens across every routine's `rungs` + `_st_lines`, project-wide, and
checking which base — non-Alias, non-I/O — tags never appear; the project has no FBD/SFC
routines, ruling that out as an explanation). These are presumably HMI/SCADA-only or legacy tags.
**This is not a bug to work around**: per the user, this should replicate what Studio's own
"Export Routine"/"Export Component" does, which likewise only includes what a routine actually
references — a tag with no logic reference wouldn't be in Studio's own export either. Tags in
this category are simply out of scope for the routine-carrier mechanism; no fallback (like
synthesizing a dead-code reference) has been built, pending a decision on whether one is wanted.

**CONFIRMED WORKING END-TO-END, via a real tag-description edit imported into real Studio 5000.**
This is the first fully successful real-world round-trip of the routine-carrier write-back
mechanism: editing `LsRead_Start`'s description (a controller-scope tag, referenced in
`Continuous/LS_Read`) and importing the exported routine via Studio's real Import Routine
feature. Getting there took two rounds of real import failures, then a full ground-truth
comparison against the user's own native `LS_Read` export that closed out every remaining gap —
both rounds found real, general, previously-undiscovered bugs, not edge cases specific to one tag:

- **Round 1**: `Error: ... Failed to set the 'Data' property (Data type mismatch...)` on
  `Test_Bit_DINT`, plus a warning on `Luci_NOBRD`. See "Initial-value decoding offset bugs" below
  for the full root-cause and fix of both (a genuine one-element-array collapsing to a scalar, and
  TIMER/COUNTER-style built-in structs losing their BIT-overlay status members).
- **Round 2** (after fixing round 1): `Error creating 'Tag[@Name="Remote_TrimmerIO:0:I"]' (Invalid
  name.)`. Root cause: an Alias tag referenced by the routine (`LngthLmt_16ft`) has
  `AliasFor="Remote_TrimmerIO:0:I.Data.7"` — an I/O tag target. The existing alias-target
  base-name resolution correctly identified `Remote_TrimmerIO:0:I` as "referenced," but
  `export_routine()` then rendered that literal I/O `Tag` object as its own `<Tag>` element.
  Fixed by filtering `controller_tags`/`program_tags` through the existing `Tag._l5x_exclude`
  rule (I/O tags never appear as standalone `<Tag>` elements in a real full-project export
  either), which `export_routine()`'s own ad-hoc tag-list building had never applied.

**After round 2 succeeded, the user provided a real Studio 5000 "Export Routine" of `LS_Read`
itself** — ground truth for the exact same routine, letting every remaining discrepancy be found
by direct comparison rather than waiting for the next import attempt. A naive string diff falsely
flagged all 64 common tags as different (attribute order and `<Comments>` child order aren't
semantically significant but a plain text diff treats them as such); a proper XML-tree-based,
attribute-order/comment-order/L5K-whitespace-independent comparison found five more real,
previously-undiscovered bugs, all now fixed and reverified to an **exact match — zero differences
across every Tag/DataType/Module/AddOnInstructionDefinition/Routine**:

1. A UDT tag's `<Structure DataType="...">` used the internal all-uppercase lookup key directly
   instead of the real DataType's own declared casing (a project UDT named `Timing` rendered as
   `TIMING`) — `_udt_array_to_xml` already looked this up correctly; the scalar-UDT branch in
   `Tag.to_xml()` never did.
2. A top-level UDT-array tag's own `<Array>` element incorrectly carried a `Name="..."`
   attribute — real Studio never has one there (only nested `ArrayMember`s do), the same
   already-fixed convention for primitive arrays, never applied to `_udt_array_to_xml`.
3. A UDT member's own declared `Radix` (e.g. `"Binary"`) was ignored in favor of a generic
   per-type default, and `Radix="Binary"` members never got Rockwell's `"2#0000_..._0000"`
   grouped-binary-literal formatting at all.
4. `_referenced_tag_names()` wrongly matched a token immediately followed by `"("` as a tag name
   (that position is always an instruction/AOI/JSR mnemonic in RLL syntax) — a real tag literally
   named `AFI` collided with the `AFI()` (Always False Instruction) mnemonic used elsewhere in the
   same routine, pulling in an unrelated tag as context.
5. The same function wrongly matched a token immediately preceded by `"."` (Rockwell address
   syntax: `.` always introduces a MEMBER name, e.g. `Length_In` in
   `ToTrim[Timing.Length_Lug].Length_In`, never a fresh tag reference) — a real, unrelated tag
   named `Length_In` got the same treatment.
6. An Alias's own I/O-tag target needs its *owning Module(s)* referenced too (the rack
   `Remote_TrimmerIO` AND the module occupying its slot 0, `Trimmer_Inputs`) — resolved via the
   same rack/slot rule already verified for direct rung references, just never fed the
   alias-resolved I/O tag names before.

See "Initial-value decoding offset bugs" and "UDT L5K rendering" below for full detail on each.
This routine happens to exercise nearly every dependency class at once (tags, UDTs, TIMER/COUNTER
built-ins, aliases, I/O tags via both direct and alias-target reference, Modules via both direct
and rack/slot addressing), so this is a strong verification result — but it's still one routine;
treat "verified" as "verified for the patterns this routine exercises," not "every possible RLL
construct."

**Final result**: `LIVE_TEST_LsRead_Start_desc_v5.L5X` (same project/tag/routine, all six fixes
applied) imported into real Studio 5000 with the exact same behavior as importing Studio's own
native `LS_Read.L5X` export — no errors, only the expected/normal "tag exists in project only"
messages for I/O tags (see below), and the tag description overwrite applied successfully. The
routine-carrier mechanism is proven end-to-end for the tag-description-edit case.

**Second edit class also confirmed end-to-end: creating a brand-new tag from scratch** (not
editing an existing one). Test: a controller-scope `Tag` object constructed directly in Python
(never existing anywhere in the ACD, name `ACDTOOLS_NEW_TAG_TEST`, `DINT`, value 42, with a
description), appended to `project.controller.tags`, referenced via one new rung appended to
`LS_Read` (`XIC(Always_Off)MOV(42,ACDTOOLS_NEW_TAG_TEST);` — guarded by `Always_Off`, a tag
conventionally always 0, so the rung can never execute; it exists purely so
`_referenced_tag_names()` picks up the new tag as context). Exported via the same
`export_routine()` path and imported into real Studio 5000 successfully, confirmed by the user
("everything worked as expected") — Studio created the new tag and added the new (dead) rung with
no errors. Both core edit classes the routine-carrier mechanism needs to support (editing an
existing tag's fields, and introducing a brand-new tag) are now proven end-to-end against real
Studio 5000, using the exact same code path with no special-casing required for "new" vs
"existing" — Studio itself decides create-vs-overwrite based on whether the name already exists
in the project.

**Confirmed normal, not a gap**: Studio's own Import Routine comparison shows "tag exists in
project only" for `IO042:I` and `Remote_TrimmerIO:0:I` (I/O tags backed by `AB:` module-defined
datatypes) when importing our file — but the user independently confirmed Studio's own *native*
export of `LS_Read` produces the **identical** message when imported back. This isn't something
our exporter is missing; it's inherent to how Studio's own partial/context export mechanism
handles these tags — the `<Module Use="Reference">` stub (name only, no definition) is all that's
needed, since Studio regenerates the I/O tag itself from the *live project's own* already-existing
Module/connection configuration on import, rather than needing an explicit `<Tag>` or full
`<Module>` definition in the partial file. Confirms `Tag._l5x_exclude` correctly keeping these out
of the `<Tags>` section entirely (see the "I/O tag exclusion" fix above) matches real Studio
behavior, not just avoids an error.

## Partial/context L5X exports (`export_routine()`)

`export_routine()` (`acd/api.py`) exports a single routine as a standalone partial L5X file for
Studio 5000's native "Import Routine" feature, sidestepping the `save_acd()`/`patch_rungs()`
limitations entirely for the common case of editing/adding rungs (including rung comments) in
an existing routine — Studio 5000 itself handles all the internal consistency (cross-reference
index, object database, re-signing) that a raw binary write would otherwise require.

**Confirmed working end-to-end**: a real, edited `export_routine()` output (a routine with a new
rung instruction added, referencing one controller-scope and two program-scope tags, including
one array tag) was successfully imported into a real Studio 5000 project via native Import
Routine, with zero errors. This took several rounds of real-data verification to get right —
see below for the full list of bugs found and fixed along the way, most of which only surfaced
once an actual *import* (not just an export/shape comparison) was attempted:

1. **The wrapper shape** was calibrated against a real Studio 5000 "Export Routine" output (a
   2-rung routine referencing one controller-scope tag and two program-scope tags):
   `<DataTypes Use="Context">` (always present, even empty), `<Tags Use="Context">` at both
   Controller and Program scope (full `<Tag>` definitions, reusing `Tag.to_xml()`, for every tag
   the routine's rung text references — found via a simple identifier scan intersected against
   the project's known tag names, not a real ladder-logic parser), `<Programs Use="Context">`,
   and `<Routines Use="Context">` wrapping `<Routine Use="Target" ...>`.
2. **Program-scope tag shadowing.** A program-scope tag must shadow/exclude a same-named but
   unrelated controller-scope tag (standard Logix bare-name resolution) when resolving which
   tags a routine's rung text actually references — previously both were incorrectly included.
3. **THE actual crash root cause** (`0x80004003` "Invalid pointer" in Logix Designer, confirmed
   via the app's own fatal-error log): individual `<Tag>` elements must **never** carry a
   `Use=` attribute themselves — only the wrapping container elements (`<Controller
   Use="Context">`, `<Tags Use="Context">`, `<DataTypes Use="Context">`, `<Programs
   Use="Context">`, `<Routines Use="Context">`, `<Program Use="Context">`) and the routine
   actually being targeted (`<Routine Use="Target">`) do. This was found by the most reliable
   method available: making the identical edit directly in Studio 5000, exporting it natively,
   confirming *that* file imports successfully, then diffing our file against it
   attribute-by-attribute (not just child-element shape, which had already matched) — the one
   remaining difference was `Use="Context"` present on every `<Tag>` in ours, absent in the real
   one. This exactly explained every earlier experimental result: an empty `<Tags
   Use="Context"></Tags>` never crashed, but *any* populated `<Tag>` did, regardless of whether
   it was a scalar or array, regardless of whether it had `<Data>` content at all (even
   attributes-only `<Tag>` elements crashed) — because the bad attribute was on the Tag element
   itself in every case.
4. **Two more bugs found along the way, both affecting `Tag.to_xml()` generally (not specific to
   `export_routine()`)**, uncovered because building real context tags for this feature was the
   first time this session's verification touched a scalar-with-known-value tag and a real
   populated array tag: scalar primitive tags were missing their `<Data Format="L5K">` block
   entirely and used the wrong Decorated element shape (`<BOOL Name=...>` instead of `<DataValue
   DataType="BOOL"...>`), and primitive *array* tags were also missing their entire L5K block —
   see the "Rung patch write-back" section's sibling fixes below for `Tag.to_xml()` details, and
   the dedicated "BOOL array bit-packing" fix a few paragraphs down.
5. **Array trailing-zero truncation was removed entirely** (`Tag.to_xml()`'s primitive array
   branch and `_udt_array_to_xml`) — it was never actually verified against real Studio 5000
   output despite an existing docstring claiming otherwise, directly contradicted by a real
   Export Routine sample (a 256-element array shown in full, not truncated), and strongly
   suspected (though not proven, since fix #3 above turned out to be the actual root cause) as a
   contributing crash risk before that was found.
6. **A serious, unrelated data-correctness bug found while checking the imported tag's actual
   value against the project's live value**: BOOL *array* initial values were bit-unpacked
   incorrectly — see "BOOL array bit-packing" below. This affects every BOOL array tag's decoded
   value project-wide, not just `export_routine()`.

**Confirmed importing a real edit succeeds**: after fix #3, importing an `export_routine()` file
with a genuinely new rung instruction (referencing a controller-scope tag and two program-scope
tags, one an array) into a real Studio 5000 project completed with zero errors.

Verified against a **second**, more complex real routine (`Lug_Skip`: 6 rungs, a UDT array tag
`To_Skip[25]`, two Alias tags) by diffing against a real Studio 5000 export of the identical
routine, unmodified — 0 remaining differences (attributes and children) across every element.
This round found and fixed several more real gaps:
7. **`Routine._description`** — routines can have their own whole-routine description, rendered
   as a `<Description>` child of `<Routine>` before `<RLLContent>`, AND as a leading XML comment
   (`<!--description text-->`) right after the `<?xml ...?>` declaration in the partial-export
   wrapper. Root-caused via the comments table: the routine's own comment parent/scope_id key has
   an `AsciiRecord` (record_type=1) entry with `rung_content==0`, previously only understood as
   "internal metadata to exclude" — it's actually this description. See "Routine-level
   Description" below for the leading-XML-comment newline-doubling pitfall found along the way.
8. **UDT scalar/array tags were also missing their `<Data Format="L5K">` block** — same class of
   bug as the primitive scalar/array cases (fix #4 above), just not yet applied to UDTs. Verified
   against the real `To_Skip[25]` tag. See "UDT L5K rendering" below.
9. **A latent bug this exposed**: a raw NUL byte could end up inside a decoded string member's
   own text (not just its computed padding), producing non-well-formed XML when rendered via L5K.
   Fixed `_l5k_string_padded()` to escape any embedded NUL the same way as padding (`"$00"`).
10. **`Member.byte_offset` leaked into L5X output** as an unintended `ByteOffset="..."` XML
    attribute (real Studio 5000 output never has this) — it was a plain, non-underscore dataclass
    field used only for internal UDT decode offset calculations, and `L5xElement.to_xml()`
    auto-serializes any non-underscore field. Renamed to `_byte_offset`.
11. **An Alias tag's target must also be included as its own context `<Tag>`** — a routine using
    alias `Sort_Enc_Calibrated` (→ `HTV_ECal_SortPos`) needs the target tag's own full definition
    included too, even though the target's name never literally appears in the rung text (only
    the alias name does). Resolved iteratively in `export_routine()` (a target could itself be
    an alias) with the target name stripped of any trailing member/bit-index suffix.

Still open / not yet verified: whether the `Owner` attribute is actually required for import to
succeed (included as an optional parameter, omitted by default; both successful tests included
it, so its necessity hasn't been isolated), and scenarios beyond a single UDT array level
(nested UDTs within UDTs, AOI-typed members, multi-dimensional UDT arrays) haven't been
exercised through `export_routine()` specifically yet (though the underlying `_l5k_udt_literal`/
`_udt_scalar_to_xml` recursion has been separately verified for nested cases in other contexts).

12. **UDT/AOI/Module/called-Routine dependency closure — SOLVED, verified exact against a real
    Studio "Export Routine".** The user clarified the intent directly: replicate what Studio's own
    routine export does, "including UDT, AOI, MODULES, Etc" as transitive dependencies. A real
    export of `Motors/Main_Motors` (`BPM_TrimmerSorter_20260709.ACD`, obtained from the user) —
    whose rungs call `AOI_RPMtoFPM(TestFPM,VFD_P_INTBL2:I.OutputFreq)`, reference
    `Local:12:I.Data.0`, and `JSR(Infeed_LandingTable,0)` — exercised every open question in one
    file. Diffing our generated output against it (element vocabulary, `Use=` values, AND full
    top-level child order) came back an **exact match** except for one unrelated, separately-scoped
    gap (`<DefaultData>`, see below). Concretely:
    - `referenced_data_types` was single-level (a UDT containing another project UDT as a member
      wouldn't pull that inner UDT in) and `project.controller.aois` was never consulted at all —
      an AOI instruction call's instance tag has its AOI name resolvable through the tag's own
      `data_type` field (here `TestFPM.data_type == "AOI_RPMtoFPM"`) exactly like a UDT tag, but the
      AOI collection was simply never searched. `_resolve_type_closure()` (`acd/api.py`) now does a
      proper worklist-based transitive closure over both `project.controller.data_types` and
      `project.controller.aois` (following a UDT's own members, and an AOI's own parameters/local
      tags, for further nested dependencies).
    - `<AddOnInstructionDefinitions Use="Context">` (individual `<AddOnInstructionDefinition>`
      elements carry no `Use=`, matching the Tag/DataType convention) sits right after
      `</Modules>` and before `<Tags Use="Context">` — confirmed exact against the real export's
      full top-level child order: `DataTypes, Modules, AddOnInstructionDefinitions, Tags,
      Programs`.
    - **Module dependencies**, previously unhandled entirely (I/O tag names contain a `:` and
      aren't picked up by the plain-identifier `_referenced_tag_names` scan), are resolved by
      `_referenced_modules()` via a real Logix addressing-convention rule, verified exact: a
      2-part I/O reference (`ModuleName:Type...`, e.g. `VFD_P_INTBL2:I` — a directly-addressed
      Ethernet device) needs only that module; a 3-part reference
      (`ModuleName:SlotNumber:Type...`, e.g. `Local:12:I` — rack/chassis-slot addressing) needs
      BOTH the chassis module itself (`Local`) AND whichever module occupies that slot (found via
      `Module.parent_module == chassis_name and Module._slot == slot_number` — here `AC_IN_12`,
      slot 12 of `Local`). The real export's `<Modules Use="Context">` contained exactly
      `{AC_IN_12, Local, VFD_P_INTBL2}` for this rung, matching the rule precisely; critically, it
      did **not** include `Ethernet2` (`VFD_P_INTBL2`'s own `parent_module`) — a directly-addressed
      module's parent is not walked, only a slot-occupant's rack is. Each `<Module>` is an empty
      `Use="Reference"` stub (bare name, no definition content), a new `Use=` value distinct from
      `Context`/`Target` seen anywhere else in this wrapper. **Caveat**: verified against exactly
      one rack + one direct Ethernet device; bridged/remote racks (ControlNet, DeviceNet, a remote
      Ethernet chassis through an adapter) haven't been exercised.
    - **Routine dependencies**: a target routine calling another routine in the same program via
      `JSR` needs that routine included too — as an empty `<Routine Use="Reference" Name="...">`
      stub (no rung content), positioned *before* the real `<Routine Use="Target">` inside the same
      `<Routines Use="Context">` wrapper. `_referenced_called_routines()` resolves this via a
      `JSR\s*\(\s*(name)` scan against the *same program's* own routines (JSR can't cross program
      boundaries in native ladder logic). Verified exact against the real export
      (`Infeed_LandingTable` stub before `Main_Motors` target).
    - All of the above are purely additive/conditional (only emitted when actually referenced),
      confirmed to leave the earlier, already-verified no-AOI/no-Module/no-JSR case byte-for-byte
      unaffected.
    - **A genuine, general bug found and fixed along the way** (not AOI/Module-specific):
      `_decorated_real_literal()`'s `"%.6g"`-style formatting silently drops the decimal point for
      an exact whole-number float (`f"{1800.0:.6g}"` → `"1800"`, not `"1800.0"`) — this went
      undetected in every earlier verification sample because none happened to include a REAL
      value that reduces to a whole number. Confirmed against four real values on the AOI instance
      tag `TestFPM` (`MotorRPM=1800.0`, and three sheave/sprocket diameters at `6.0`/`12.0`/`14.0`,
      all rendered by real Studio with an explicit `.0`). Fixed by appending `.0` whenever the
      formatted string has neither a decimal point nor scientific notation. This affects every
      Decorated-format REAL/LREAL rendering project-wide (plain tags, UDT members, AOI members),
      not just AOI structures.

    **Separate, deeper, NOT-yet-solved gap found via the same real `TestFPM` comparison — AOI
    *instance value* decoding is measurably wrong, independent of the dependency-declaration fixes
    above**: comparing our rendered `TestFPM` tag (`DataType="AOI_RPMtoFPM"`) against the real
    export's byte-for-byte:
    - Two members are silently missing from both our `<Data Format="L5K">` and `<Structure>`
      output: `EnableIn`/`EnableOut` (both real BOOL members present in Studio's own output, not
      BIT-overlay pseudo-members). The underlying synthetic "DataType" that backs an AOI instance's
      value decode (found via `all_data_types_map[dt.name.upper()] = dt` in `ControllerBuilder`,
      which inserts *every* `RxDataTypeCollection` entry regardless of `cls`, not just `cls ==
      "User"` — meaning an AOI's own instance-data-shape record lives there under the AOI's name,
      separately from the AOI's own `AddOnInstructionDefinition`/Parameters) appears to mark these
      two members `hidden`, and `_udt_scalar_to_xml`/`_decode_single_udt_element`'s generic
      "skip if hidden" rule (correct for real UDT BIT-overlay members) incorrectly drops them here
      too. Whether that's a raw-byte misread of the hidden flag for this specific case, or a
      genuine semantic difference (AOI system-defined params need to never be skipped regardless
      of a hidden flag) is not yet determined.
    - The real `<Data Format="L5K">` literal has **17 comma-separated values**; ours has only 8
      (matching the 8 members we do emit). Real Decorated `<Structure>` only shows 10 named
      members (`EnableIn`/`EnableOut` + our 8) — still short of 17, meaning L5K encodes something
      beyond even the full named-Parameter list, quite possibly the AOI's own `LocalTags` (private
      storage) packed into the same flat blob, plus the leading value `3` in the real L5K array
      that doesn't map to any named Parameter or LocalTag at all (possibly an internal AOI
      execution-state field Studio never exposes as a named member).
    - `<Structure DataType="AOI_RPMtoFPM">` in real output preserves the AOI's own mixed-case name;
      ours renders `AOI_RPMTOFPM` (all-caps) — traceable to `display_name` falling back to the
      already-uppercased lookup key when the synthetic backing DataType's own stored `.name` isn't
      the properly-cased one.
    - `<DefaultData Format="L5K">`/`<DefaultData Format="Decorated">` (an AOI's own default value
      for a `Parameter`/`LocalTag`, e.g. `MotorRPM`'s default `0.0`) is never emitted at all —
      `Parameter`/`LocalTag` dataclasses don't even have an `_initial_value`-equivalent field yet,
      so this needs new binary reverse-engineering (where an AOI *definition's* own default values
      live in Comps.Dat, analogous to but distinct from `_read_tag_initial_value`/
      `_decode_udt_initial_value` for a tag *instance's* current value) before it can be
      implemented at all — not attempted this session.
    None of this blocks the dependency-declaration fixes above (which only need the AOI/Module/
    UDT/routine *names* to be correctly identified and included, not their values decoded
    correctly) — but any future work rendering an AOI-typed tag's own current value, or an AOI's
    own parameter/local-tag default values, should start here rather than assume the existing UDT
    value-decode pipeline already handles AOIs correctly.

## `export_datatype()` — create/modify a UDT (NOT YET VERIFIED against real Studio 5000)

Added per user request (concrete example: insert a new member in the middle of the real `Lug`
UDT). Same "native-import escape hatch" architecture as `export_routine()`: exports a single
`DataType` (plus its transitive dependency closure via the already-existing `_resolve_type_closure()`)
as a standalone partial L5X, for Studio 5000's own **"Import Data Type..."** command (right-click
the Data Types folder) — sidestepping `save_acd()`/raw `Comps.Dat` writing entirely, the same way
`export_routine()` sidesteps it for rungs/tags.

- `new_member(name, data_type, dimension=0, radix=None, description=None)` (`acd/l5x/elements.py`)
  builds a plain (non-BIT, non-hidden) `Member` with a sensible default `Radix` (`_PRIMITIVE_RADIX`
  lookup, or `"NullType"` for a struct-typed member) — constructing `Member` directly is awkward
  (duplicate `_name`/`name` positional args, no radix default).
- To modify an existing UDT: mutate `dt.members` directly (`dt.members.insert(i, new_member(...))`
  inserts at a specific position — Studio recomputes the real byte layout on import, since
  `Member._byte_offset` is an internal decode-only field never emitted in XML at all). To create a
  brand-new UDT: build a `DataType` and append it to `project.controller.data_types` first, then
  export the same way — no special-casing needed, matching the already-proven "new vs existing tag"
  pattern (see "Native-import escape hatches" above).
- Wrapper shape (`<DataTypes Use="Context">` containing every dependency's full `<DataType>` element
  plus the one being edited/created with `Use="Target"` injected via the existing
  `_inject_use_attr()` helper, `TargetType="DataType"`, no `<Tags>`/`<Programs>`/`<Modules>`
  sections) was built by **direct symmetry** with `export_routine()`'s already-verified wrapper —
  it has **not** been confirmed against a real Studio 5000 "Export Data Type" output, nor against a
  real "Import Data Type..." attempt. Given how many real-import rounds it took to get
  `export_routine()`'s shape exactly right (see "Partial/context L5X exports" below — a crash, a
  missing `Use=` rule, several tag-rendering gaps, all only found via actual import attempts), expect
  this to need the same kind of iteration once tested against real Studio 5000.
- Verified so far (without Studio 5000): generated XML is well-formed, the target `DataType`
  carries `Use="Target"` and nothing else does, and a member inserted at a given list index appears
  at the correct position in the rendered `<Members>` — covered by
  `test_export_datatype_inserts_member_at_requested_position` (`test/test_api.py`), using the
  `UDT_Test` fixture in `resources/ACDTestsWithAOI.ACD`. Also manually generated and inspected a
  real `Lug_modified.L5X` (new `DINT` member inserted right after `Z1_Board_Length`) against the
  real `BPM_TrimmerSorter_VAB_20260721.ACD` project — well-formed, correct member order — but this
  has **not yet been imported into real Studio 5000**; do that on a **copy** of the project first.

## Routine-level Description (leading XML comment newline pitfall)

The leading `<!--description-->` XML comment `export_routine()` emits (see item 7 above) must
have its line endings normalized to bare `"\n"` *before* being embedded, using the same
`_multiline_xml_text()` already used for `<Description>` child elements — NOT the raw
`routine._description` string as-is. `Path.write_text()`'s default text-mode newline translation
on Windows blindly replaces every `"\n"` with `"\r\n"`, including the `"\n"` half of an
already-present `"\r\n"` pair from the ACD's own raw text, which doubles into `"\r\r\n"` (renders
as a spurious blank line) if left un-normalized. Caught by comparing byte-for-byte against a real
export where line breaks were single, not doubled.

## Whole-project element-count verification, and a real Comments.Dat dedup bug

`export_routine()` and individual-tag/routine spot-checks had been the only verification method
until this investigation: exporting an entire real project's `to_xml()` and comparing element
counts (`<Tag>`, `<Module>`, `<Routine>`, `<Rung>`, `<Program>`, `<Description>`, `<Comment>`,
...) against that same project's own Studio 5000 L5X export. This surfaced several real bugs no
per-feature test had caught (see "Known limitations" for the ones still open):

- **Phantom `<Program>`/`<Module>`/`<Tag>`/`<Routine>` elements**: deleted-but-not-purged comps
  records with a distinct `record_type` (or, for Routine, a `routine_type_enum(0) ==
  "TypeLess"` CIP value) that don't appear in the real L5X at all. Fixed by filtering these out
  in `ControllerBuilder`/`ProgramBuilder`/`RoutineBuilder` — see each builder's own inline
  comments for the specific record_type values found.
- **`populate_region_map()`'s read loop silently dropped the table's last entry** (an erroneous
  `- 4` in the loop bound, present since the function was first written) — lost whichever single
  16-byte entry happened to be physically last in the whole table, which for one real project
  landed in the *middle* of one routine's own rung sequence, silently shifting every subsequent
  rung's number by one in that routine alone. Fixed by removing the `- 4` (verified: `region_length`
  is always an exact multiple of 16 across every local fixture and this real project).
- **A real comment-dedup bug, found via a routine's own missing `<Description>`**: the
  `seen[key]` dedup step in `export_l5x.py` (see the comment-resolution notes above) used
  `(parent, tag_reference, scope_id)` as its key, keeping whichever candidate had the longest
  text. A routine's own whole-routine Description (`rung_content == 0`) and one of its *rung*
  comments (`rung_content != 0`) can share the exact same `(parent, tag_reference="", scope_id,
  object_id)` — found via a real "Get_Bin" routine where the real Description ("Find bin for
  current set") was shorter than an unrelated rung comment sharing the same key, so the
  dedup step silently kept the rung comment and discarded the Description. Fixed by adding
  `rung_content` to the dedup key. This also means a **routine can have at most one dedup
  collision saved per (parent, tag_reference, scope_id, rung_content) tuple** — see the next
  section for a related, *unsolved* problem this investigation also uncovered.

## Rung comments: attribution via RegnLink.Idx (SOLVED — 582/582 exact on a real project)

**The mechanism, in one paragraph**: a rung comment's `rung_content` upper 16 bits are a
"fragment" ID. The authoritative fragment→rung mapping lives in **`RegnLink.Idx`** (never
examined until this was solved): B-tree-style index pages containing dense 16-byte entries,
all little-endian — `[0:2] fragment` (same value as a `RegnLink.Dat` record's `[18:20]`),
`[2:3]` the same 7-bit value as the `.Dat` record's `[20:22]` "unknown", `[3:4]` always `0x00`
(used as a validation byte when scanning), `[4:8] routine_id` (comps object_id), **`[8:12]
rung_object_id` — directly names the comment's target rung**, `[12:16] ptr` = file offset + 12
of the paired `RegnLink.Dat` record carrying the same fragment (used as a validation bound:
must be ≤ the `.Dat` size, which filters false-positive scan matches). Resolution:
`fragment = rung_content >> 16` → look up `(routine_id, fragment)` in these entries → that
entry's `rung_object_id`'s position in the routine's region_map-ordered rung list. Stale
entries from old/free index pages survive the file scan (a fragment can appear twice with
different rung UIDs — observed in a real project), so prefer the entry whose `rung_object_id`
is one of the routine's own live rungs; if Idx entries exist but none names a live rung, drop
the comment (genuinely stale) rather than falling back. See `populate_regnlink()` in
`export_l5x.py` and `RoutineBuilder.build()`.

**Verified**: 582/582 rung comments on exactly the right rung for a real, decades-old production
project, against that project's own Studio 5000 full L5X export (including AOI logic-routine rung
comments — remember AOIs when parsing L5X ground truth), plus every purpose-built staged edit test
(fresh comments, delete-then-recreate, rung inserted mid-routine shifting comments below it).

**History — how this was misunderstood twice, kept so nobody re-treads it**:
1. First theory: comment `object_id` − 1 = rung index. Wrong (`object_id` is constant 1 across
   every rung comment in a routine); only 98/582 of a real project's comments were emitted.
2. Second theory ("the chain reading", previously documented here as the real mechanism):
   resolve the fragment against **`RegnLink.Dat`** — a per-routine linked list of rungs
   (22-byte records: `[0:4]` routine, `[4:8]` own rung, `[8:12]` next rung, `[12:16]` type,
   `[16:18]` flags, `[18:20]` fragment, `[20:22]` unk) — as "the fragment belongs to the rung
   in `next_id`". This is only *coincidentally* correct, for routines whose rungs were never
   reordered/relinked (true of freshly-created test projects, which is why it verified clean at
   the time): 522/582 of the real project's comments were *emitted*, but that number hid that
   the fragment→`next_id` association is wrong whenever the chain was ever edited — scored for
   *placement* against Studio's own export, only 113/533 landed on the right rung (317 were off
   by exactly +2). A fragment sticks to its 22-byte *link record*, not to the rung: verified by
   a staged rung-insertion test where the record `own=rung3` had its `next_id` redirected to the
   new rung while keeping its old fragment. `RegnLink.Idx`'s `rung_object_id` is the field that
   tracks the *current* rung for each fragment.
3. The "Rockwell editor quirk" theory (four staged reproductions of delete-a-comment-then-
   create-one appearing to write the *preceding rung's* fragment) — **retracted, it was our own
   misreading**. The written fragment was correct all along per `RegnLink.Idx`; it merely looked
   like rung 2's fragment under the broken chain reading (in that test routine the rungs had
   been created out of order, so chain order ≠ link-record order for exactly three fragments).
   The user's observation that Studio 5000 shows the comment on the correct rung after a full
   close/reopen was the decisive clue that the answer had to be recoverable from disk.

**`RegnLink.Dat` facts worth keeping** (the `.Dat` chain reading is retained only as a fallback
when a fragment has no Idx entry at all, e.g. missing `RegnLink.Idx`):
- Records are **not reliably contiguous** for a long-lived project — scan the whole file for
  known comps object_ids in the `[0:4]` slot rather than assuming adjacency.
- Type `0xFFFF0000` marks a stale/deleted link (filter it); additionally the physically-last
  record of a routine's block can carry type `0xFFFFFFFF` with fragment `0xFFFF` — it is not
  dead, it's the not-yet-finalized tail link (its own/next fields are still live chain data;
  observed getting a real fragment assigned only when a later edit appended another record).
- Physical record order = rung *creation* order (independently confirmed by `SbRegion.Dat`
  record order), not current rung order.

**Comments.Dat deletion/reuse facts** (corrects an earlier claim that deletion changes no
bytes): deleting a comment flips its record marker `fa fa` → `fd fd` and zeroes a constant
`0x3A` u32 at body offset 0 (a live-record tag shared by every live comment record); the text
and the rest of the body stay intact. Deletion also appends a free-list entry in the `0xFF`
free space after the last record, containing the freed record's offset and length as
**big-endian** u32s; creating a new comment physically reuses the freed slot and zeroes parts
of that free-list entry. None of this carries rung-attribution information.

## UDT L5K rendering (`_l5k_udt_literal`)

Mirrors `_udt_scalar_to_xml`'s own member-iteration rules (skip hidden and `BIT` members, same
declaration order) but emits an L5K array literal instead of XML: `"[1,0,0,...]"` for a scalar
struct, `"[[...],[...],...]"` for an array of structs, recursing into nested
structs/arrays/string-family members. Shares `_l5k_prim_literal()` (BOOL/BIT → `"2#0"`/`"2#1"`,
REAL/LREAL → `_l5k_real_literal()`, else plain decimal) with the primitive-array literal builder.
Verified against a real 25-element UDT array tag (`To_Skip[25]`): every element's L5K literal
matches Studio 5000's own `<Data Format="L5K">` content exactly.

## Initial-value decoding offset bugs (`_read_tag_initial_value`)

Two separate, serious bugs were found here in the same investigation (verifying `export_routine()`
imports against a project's actual tag values) — both affected the decoded initial value of
primitive tags, one for arrays and one for scalars. **If you ever see a primitive tag's decoded
value look wrong, this function is the first place to check**, and don't trust a "looks
plausible" value without comparing against real Studio 5000 ground truth — both of these bugs
produced plausible-looking (but wrong) values for many tags before being caught.

**1. BOOL array bit-packing.** Every array element was read at its own naive per-element byte
offset (`offset + i * elem_size`). This is correct for every primitive type *except* BOOL/BIT
arrays, which Rockwell bit-packs 32 bits per 4-byte DWORD — the same packing `_get_type_size()`
already accounts for when *sizing* a `BOOL[N]` array (`ceil(N/32)*4`), but this function was
never updated to match, and silently returned a raw packed byte value (e.g. `32`) instead of the
correct `0`/`1` bit for every element of every BOOL array tag. Fixed by reading the correct DWORD
(`offset + (i // 32) * 4`) and extracting bit `i % 32` for BOOL/BIT arrays specifically. Verified
against a real 256-element array tag: all 256 values now match Studio 5000's own export exactly.
Covered by a synthetic unit test (`test_read_tag_initial_value_bool_array_bit_packing`) since the
small fixture has no BOOL array tags.

**Same bug, second location, found much later via the tag-value-blob-offset investigation above.**
This fix was only ever applied to `_read_tag_initial_value` (a top-level *primitive tag*'s own
value). `_decode_single_udt_element` — which decodes a UDT's own members, including array-typed
ones — has a separate, parallel array-decode loop that never got the equivalent fix: a BOOL array
**member** inside a UDT (e.g. `Encoder`'s `Ons`, `BOOL[32]`) was still read one raw byte per
element (`elem_size = _get_type_size("BOOL", ...) = 1`), not from its shared packed DWORD. Found
via a real Studio 5000 "Tag Name Collision / Data Compare" dialog: `EncTrm.Ons[5]` decoded as `1`
instead of the real `0` — only **one** of 32 elements differed, since reading bit 0 of the wrong
byte coincidentally reproduces the correct packed bit for most positions, making this an easy bug
to miss without checking every element against real ground truth. Fixed the same way as above
(read the correct DWORD, extract bit `i % 32`), scoped to array members whose own `data_type` is
`BOOL`. Covered by `test_decode_single_udt_element_bool_array_member_bit_packing`. Verified against
the real project: `EncTrm.Ons` and `Trim_Decision.Ons` (both `BOOL[32]`) now decode to all zeros,
matching Studio's own "Existing Value" exactly.

**2. Scalar offset was simply wrong (0x19E instead of 0x1A2).** This was caught as a *direct
follow-on* to fix #1 above, and turned out to be much bigger: after fixing the array case,
`SecFlasher` (a scalar BOOL) still decoded as `1` when the real project value is `0` (confirmed
consistently across two real Studio 5000 exports taken hours apart from an offline, unchanging
project copy). Root-caused by comparing raw bytes for `SecFlasher` against `Always_Off` (a tag
that by convention must always be `0`) — both shared an *identical* 419-byte boilerplate
data-table record, with byte `0x19E == 1` for **both**, proving `0x19E` was never actually each
tag's own value at all, just incidental template/boilerplate data that happens to often be
nonzero. Systematically verified against the real project: comparing all 758 controller-scope
scalar BOOL tags and 812 scalar DINT tags against Studio 5000's own values (from a real
full-project L5X export), the old offset (`0x19E`) matched only 21.4% (BOOL) / 2.8% (DINT) of the
time, while the array offset (`0x1A2`) matched **100% for both** — there was never a real
scalar/array distinction; `0x1A2` is simply where the data-table's value region always starts.
This affected the decoded initial value of every scalar primitive tag project-wide (BOOL, DINT,
REAL, etc.), not something specific to one tag or type. Fixed by removing the scalar/array offset
distinction entirely — always read from `0x1A2`. Covered by
`test_read_tag_initial_value_scalar_uses_0x1a2_offset` (a decoy-vs-real value at each offset in a
synthetic blob) plus a correction to `test_scalar_primitive_tag_xml_shape`'s own expected value,
which was itself a casualty of this bug (never independently verified against real ground truth
for the small fixture, just whatever the wrong offset happened to produce).

**3. A genuine one-element array (`Dimensions="1"`) silently collapsed to a scalar**, causing a
real, reproducible Studio 5000 import rejection ("Data type mismatch") — found via the first
actual live end-to-end test of the routine-carrier write-back mechanism (see "Native-import
escape hatches" above): editing `LsRead_Start`'s description and importing the carrying routine
via Studio's real Import Routine failed, not on the intended edit, but on an unrelated context
tag (`Test_Bit_DINT`) swept in because the routine's own rung text also references it.
`_read_tag_initial_value`/`_decode_udt_initial_value` both collapsed to a bare scalar whenever
`n_elements == 1`, unable to distinguish "no dimensions declared at all" (a true scalar) from
"genuinely declared as a 1-element array" (`Dimensions="1"`, `n_elements` also 1) — both cases
hit the same `if n_elements == 1: return values[0]`. This produced an internally inconsistent
`<Tag>`: `Dimensions="1"` in the attributes (correctly derived from the raw record) alongside a
scalar `<DataValue>` in `<Data Format="Decorated">` (from the collapsed value) instead of the
`<Array><Element Index="[0]" .../></Array>` shape Studio expects for a declared array — exactly
the mismatch Studio's importer rejected. Fixed by threading an explicit `is_array` flag (derived
by the caller from `dimensions is not None`, not from `n_elements`) through both functions, only
collapsing to scalar when `not is_array`. Verified: `Test_Bit_DINT` (a real project tag with this
exact shape) now renders as `<Array Dimensions="1">...<Element Index="[0]".../></Array>`.

**4. Rockwell built-in structured types with BIT-overlay status members (TIMER, COUNTER, likely
CONTROL) were missing those members entirely from both `<Data Format="L5K">` and
`<Data Format="Decorated">` whenever the tag had a real decoded value** — the second bug the same
live import test surfaced: a `COUNTER`-typed tag (`Luci_NOBRD`) got a hard Studio import **error**
("Data does not have enough data type members"), not just a warning, because its `<Structure
DataType="COUNTER">` showed only `PRE`/`ACC`, missing `CU`/`CD`/`DN`/`OV`/`UN` entirely.
Root cause, found by comparing member metadata: TIMER/COUNTER's own hidden `Control` DINT member
(`hidden=True`) is where `EN`/`TT`/`DN` (or `CU`/`CD`/`DN`/`OV`/`UN`) actually live, as BIT-overlay
pseudo-members (`data_type=="BIT"`, `hidden=False`, `bit_number`+`target="Control"`) — but the
generic decode/render skip rule (`if member.hidden or member.data_type == "BIT": continue`),
correct for a UDT's own genuine bit-overlay members that shouldn't be independently serialized,
was ALSO unconditionally dropping BOTH the hidden backing value (needed for L5K) AND the BIT
pseudo-members themselves (needed for Decorated) for these built-in types. **This also falsified
last session's own "exact match" claim for the AOI/Module/JSR dependency-closure verification** —
that check only compared element vocabulary and top-level section order, never this deep into a
specific tag's own member content, so it did not catch that a TIMER tag in that very same
calibration file (`DelayedControlPowe`) was already missing `EN`/`TT`/`DN` the whole time; a
narrower "vocabulary + order" diff is not sufficient evidence for "byte-exact," a lesson worth
remembering for future verification passes. Fixed across four call sites with a decode/render
split, not a single shared skip rule: `_decode_single_udt_element` now decodes hidden non-BIT
members normally (first pass) and derives each BIT-overlay member's own value by extracting its
`bit_number` from the already-decoded `target` sibling (second pass) — Python's `>>` on a negative
int is sign-extending, so this works correctly for a negative packed `Control` value without special-
casing; `_l5k_udt_literal` now skips only BIT members (hidden members' raw value IS part of the L5K
literal); `_udt_scalar_to_xml` now skips only hidden members (BIT-overlay members DO get their own
`<DataValueMember DataType="BOOL">`); `_get_type_size` now skips only BIT members when computing a
struct's total byte size (a hidden member's own byte extent still counts). Verified against real
Studio ground truth for two different built-in types: `DelayedControlPowe` (TIMER) now renders L5K
`[-1607863227,3000,3000]` and Decorated `PRE/ACC/EN=1/TT=0/DN=1`, matching a real Studio export
exactly; `Luci_NOBRD` (COUNTER) now renders all 5 status bits (structurally verified, though no
independent real-Studio ground truth exists for this specific tag's own `Control` value).

**5. Arrays need offset 0x1A2 + 2, not 0x1A2 — a major, project-wide bug, found via a real Studio
5000 import error that turned out to be unrelated to what was actually wrong. SUPERSEDED — see the
"RESOLVED" note in "UDT total size must round up to a multiple of 4" below: the "array vs scalar"
framing here was itself wrong; the real, general mechanism is `_tag_value_blob_offset()`.** After
re-testing an
`export_routine()` export following the `Trim_Decision`/`LugWrk` fixes above, Studio reported `Only
ASCII characters are supported` on an unrelated tag (`LugTrm`) — chased down and fixed (see the
STRING/latin-1 section below) — but while re-verifying the *other* tags swept into that same export
as context, a completely different, far larger bug turned up: `Comm_From_VABView_Recipe_Status`
(a plain `DINT[40]` tag, no UDT involved at all) showed every decoded value as if multiplied by
65536 versus the real Studio value (e.g. existing `3` → our `196608`, existing `192` → our
`12582912`) in Studio's own **Tag Name Collision / Data Compare** dialog — the exact tell-tale
signature of a value's real bytes landing in the high 16 bits of a 4-byte read that started 2 bytes
too early (if the true low-order bytes are zero, as they always are for a small value, `value` read
2 bytes early becomes `value << 16` = `value * 65536`, with no other distortion). The 0x1A2 offset
established two findings up was **only ever verified against scalar tags** — arrays were never
independently checked. A project-wide sweep confirmed this is not a one-off: **273 of 347 primitive
array tags and 14 of 22 BOOL array tags** (SINT/INT/DINT/BOOL, every one checked against this same
project's real Studio 5000 L5X export) decoded wrong at 0x1A2, and **all of them** decoded correctly
at 0x1A2 + 2 — including a real `Dimensions="1"` tag (`Test_Bit_DINT`), confirming the split is keyed
on `is_array` (declared array, even a 1-element one), not `n_elements > 1`, mirroring the identical
scalar-vs-array distinction already established for the collapse-to-scalar behavior. Fixed by
splitting `offset = 0x1A2 + 2 if is_array else 0x1A2` in both `_read_tag_initial_value` (primitives)
and `_decode_udt_initial_value` (UDTs/struct arrays) — previously both hardcoded a single `0x1A2`
with an explicit comment claiming "for both scalar and array tags... no separate scalar offset,"
which this finding disproves.

**This also caught and reversed a wrong turn from the very same investigation just above (the
`Trim_Decision`/dead-member fix)**: `_get_type_size()` had been given a `+ dt._dead_member_bytes`
addition on the untested assumption that a deleted member's persisting footprint would affect an
*array* element's stride the same way it affects a scalar struct member's trailing siblings
(`_apply_dead_member_byte_corrections()`, which is unrelated and still correct). Verified wrong
against a real 200-element array of the exact UDT this was found on (`Lug`, via tag `LugTrm`): by
directly locating two known-consecutive elements' own leading field value in the raw data-table
blob (searching for the literal 4-byte little-endian encoding of "158" and "159"), the true
per-element stride is exactly 568 bytes — the *plain* `max(offset + size)` computation, with **no**
dead-byte addition (570 was wrong). Reverted `_get_type_size()` to never add `_dead_member_bytes`;
the scalar-sibling case remains correctly handled by the separate, already-verified
`_apply_dead_member_byte_corrections()` pass, which was never affected by this reversion.

**Verified end-to-end**: with both the array-offset split and the `_get_type_size()` reversion in
place, `Trim_Decision`/`Fence_Decision` still match real Studio ground truth exactly (unaffected,
since they're scalar), `LugTrm`'s array elements now show the correct incrementing sequence
(158, 159, 160, ...) at the correct stride, and the full project-wide sweep of every primitive/BOOL
array tag with real ground truth (369 tags) came back with **zero mismatches**, up from 273+14
wrong. This is the single highest-impact bug found in this investigation — it silently corrupted
the large majority of every project's array tag values, primitive or UDT, scalar-vs-array
distinction notwithstanding, and had gone undetected because the earlier verification pass (758
BOOL + 812 DINT tags) happened to only include scalars.

**Methodological lesson, worth restating a third time in this file**: a fix that resolves the
specific reported symptom (here: the `Trim_Decision` "Data type mismatch") is not evidence the
*surrounding* changes made along the way are correct — the `_get_type_size()` addition was never
actually required to fix the reported bug (`_apply_dead_member_byte_corrections()` alone was
sufficient) and was wrong for a case (arrays) nobody had checked yet. When touching a shared,
widely-called helper like `_get_type_size()`, verify the *new* behavior against a case that
specifically exercises the path being changed, not just the one bug report that prompted the change.

## BIT-overlay member Target resolution (`MemberBuilder.build`/`_resolve_bit_target`)

A UDT's BIT-type members (bit-overlay pseudo-members aliasing one bit of a sibling field, e.g.
TIMER's `EN`/`TT`/`DN` aliasing its hidden `Control` DINT — see the section above) need a `Target=`
attribute naming that sibling in the exported L5X; Studio 5000's schema requires it, and rejects
Import Routine with `Required property 'Target' was missing` if it's absent. This was originally
resolved via a small enumerated "pattern" on the member's raw `0x68` value (0/1/0x800), each
branch using a different resolution mechanism. **A downstream agent found this incomplete on a
real UDT** (`LugWrk` in a real project): its 4 BIT members (`ActvtnArea`/`AcqstnArea`/`TrtmntArea`/
`TrtmntAllwd`, overlaying hidden `ZZZZZZZZZZLugWrk9`) all had `val_68=0x9`, a value outside the
enum, which fell into the code's "not a BIT sub-element, leave as plain BOOL" catch-all — so
`export_routine()` emitted these as `<Member DataType="BOOL">` with no `Target=` at all, and
Studio's Import Routine rejected the file. The agent traced the raw bytes far enough to identify
`0x68=0x9` as the distinguishing value and confirm the existing "Pattern 1" mechanism (treating
`0x6c` as an offset60_to_name lookup key) failed for this case (`0x6c=596` matched no real member's
own `0x60`, including the true backing field's `0x60=640`), but didn't have real Studio ground
truth in hand to determine the *correct* fix.

**Investigation, with the user then providing a real Studio 5000 export of the exact UDT as ground
truth** (`LugWrk_DataType.L5X`, plus a whole-project L5X for broader verification) — the decisive
resource for getting this right rather than guessing:

1. Confirmed `LugWrk`'s 4 BIT members share their own `0x60` value (640) with the hidden backing
   field (`ZZZZZZZZZZLugWrk9`, also `0x60=640`) — this is the SAME condition the code's existing
   "Pattern 3" branch already checked (`offset60_to_name.get(own 0x60)`), just gated behind
   `val_68 == 1` specifically. Generalizing "Pattern 1"/"Pattern 3" into a single "not a BIT
   sub-element only if `0x68==0x800` and `0x6c==0xFFFFFFFF`; otherwise try `0x6c`-lookup then
   own-`0x60`-lookup" fixed `LugWrk` and, cross-checked against the same ground truth file's
   sibling `Lug` UDT (which the agent hadn't examined), ALSO fixed 8 more real BIT members there
   with yet more previously-unseen `val_68` values (0x2, 0x14) that had been silently misclassified
   as plain BOOL by the original code's catch-all `else` branch — not just left unresolved, actually
   wrong. Neither `LugWrk` nor `Lug` mentioned anywhere in this repo before this session.
2. **A separate, real bug found in the same pass**: `Member.to_xml()`'s generic attribute
   auto-serialization emitted `BitNumber="0"` on `Ons`, a plain `BOOL[32]` array member — because
   `member.bit_number` is set for every BOOL member internally (needed as a data-table decode hint
   by `_decode_single_udt_element`/`_decode_scalar_member`, unrelated to XML rendering) but the
   base `to_xml()` has no way to know that distinction. Real Studio export never emits `BitNumber=`
   for a non-BIT member. Fixed by having `Member.to_xml()` strip a spurious `BitNumber=` attribute
   whenever `data_type != "BIT"`, without touching the field's internal (still-needed) value.
3. **A deeper, more consequential bug found while cross-checking the *whole* project's L5X against
   ground truth** (99 `DataType`s, not just the two directly implicated): the "own `0x60` lookup"
   mechanism from step 1 is not reliable in general — `offset60_to_name` is a flat, UDT-wide map
   keyed purely by raw byte offset, and nothing prevents an unrelated, real (non-hidden) field from
   coincidentally sharing a BIT member's own `0x60` with a *different* field than its true backing
   one. Found concretely in `Bin_Sequence`: `Action_1`..`Action_16`'s own `0x60` all read `4`,
   which matches real field `Sling_Pos_1` (also `0x60=4`) — NOT either of the UDT's two genuine
   hidden backing fields (`ZZZZZZZZZZBin_Sequen1`/`ZZZZZZZZZZBin_Sequen10`, at `0x60=2`/`0x60=3`
   respectively). The lookup didn't fail — it returned a wrong-but-plausible name, which is worse
   than failing outright, and 3 more real UDTs in the same project turned up the identical
   collision (`Product_Definition`, `Sorts`, `VAB_Data_Sorter_To_Scanner`). The ONE mechanism that
   resolved every real case found correctly, including this collision — `LugWrk`, `Lug`, TIMER,
   COUNTER, and all four collision UDTs — is **declaration order**: a BIT-overlay member always
   immediately follows its own backing field, so the pre-existing `_fallback_target` (most-recent
   preceding hidden member, originally only used for one narrow `val_68==0` branch) is now tried
   FIRST, before either offset-based lookup. The offset-based lookups are kept only as a fallback
   for when no hidden member precedes at all (verified this is what makes TIMER/COUNTER's `EN`/
   `TT`/`DN` resolve — their shared `0x60=12` matches no plain-field entry, since `_fallback_target`
   already gives the right answer, "Control", before either lookup is even tried).
4. Extracted the whole decision into a small, independently unit-tested pure function,
   `_resolve_bit_target(target_key, val_60, offset60_to_name, fallback_target)` — this logic had
   zero test coverage before this session (surprising, given TIMER/COUNTER's own bit-overlay
   handling has been revisited multiple times per the section above) and is fragile enough
   (three real, wrong revisions in one investigation) to deserve permanent regression tests
   independent of any real ACD fixture.

**Verified**: every one of 362 BIT members across the whole real project resolves a Target after
the fix (0 unresolved, down from several); a full attribute-by-attribute comparison of all 99
`DataType`s against that project's own real Studio 5000 L5X export came back with **zero
mismatches** (previously 2 `DataType`s had entirely unresolved targets and, after the first-pass
fix, 4 different `DataType`s had wrong-but-resolved targets from the collision in step 3).

**Methodological note, worth repeating given how this session went**: the first-pass fix (step 1)
looked complete — it silenced the original bug report and matched ground truth for the two directly
implicated UDTs. It was only proven wrong by deliberately widening verification to the *whole*
project against a *whole-project* L5X export, not just the specific UDT named in the bug report.
Don't treat "fixes the reported case" as "correct in general" for this kind of byte-offset
heuristic — cross-check against everything available before considering it done.

## Nested-UDT decode recursion-depth double-increment (`_decode_single_udt_element`)

A real Studio 5000 import of an `export_routine()` output failed with `Failed to set the 'Data'
property (Data type mismatch...)` at the line of a tag's `<Data Format="L5K">` element
(`Trim_Decision`, `LugWrk`-typed). Traced to `_decode_single_udt_element`'s `depth` counter being
incremented **twice** per real struct-nesting level: once where it calls `_decode_scalar_member(...,
depth + 1, ...)`, and again inside `_decode_scalar_member`, which itself calls
`_decode_single_udt_element(..., depth + 1)` before descending. This silently halved the usable
nesting depth from the documented 3 levels (`_max_depth=3`) to effectively 1 — a real UDT only 2
real levels deep (`LugWrk` → `Lug` → `LugErrorCode`, via `Trim_Decision.BfrLug.ErrorCd`) had its
innermost member (`ErrorCd`) decode to `{}` well within the intended limit. An empty dict for a
struct-typed member renders as nothing at all in `<Data Format="Decorated">` (the whole
`<StructureMember>` is silently dropped since `_udt_scalar_to_xml` only appends it `if inner:`,
easy to miss entirely in a spot-check) but as a bare `"[]"` in the `L5K` literal's fixed-position
array — a shape Studio 5000 rejects on import, which is how this was actually caught (an ordinary
Decorated-only diff would have missed it, another argument for checking L5K too, not just
Decorated, per the AOI-instance-value gap noted elsewhere in this file).

Fixed by removing the redundant increment at the two call sites in `_decode_single_udt_element`
(now passes plain `depth`, not `depth + 1`, to `_decode_scalar_member` — which still owns the
single `depth + 1` when it actually recurses into a nested UDT). Verified: `ErrorCd` now decodes
all 36 of its own members instead of `{}`. Two synthetic unit tests
(`test_decode_single_udt_element_two_real_levels_of_struct_nesting`,
`test_decode_single_udt_element_still_truncates_beyond_max_depth`) lock in both the fix (2 real
levels of nesting must decode fully) and that the depth-limit safety net itself still works (4
real levels must still truncate the innermost to `{}`) — this had zero prior test coverage.

**A second, separate discrepancy found on the same tag while verifying the fix above — SOLVED**:
5 scalar members of `LugWrk` itself (`pntrTpStrt`/`pntrTpStp`/`pntrTpTrtmnt`/`pntrLug`/`pntrDrtn`,
declared directly after the nested `BfrLug` (`Lug`-typed) member) decoded values shifted by exactly
one `INT` (2 bytes) versus real Studio ground truth — confirmed by direct raw-byte inspection: the
true values (`24,25,0,183,0`) sit at byte offsets 570/572/574/576/578, but each of these members'
own *stored* `_byte_offset` (the raw ACD record's own `0x60` field) says 568/570/572/574/576 — 2
bytes short. Ruled out several explanations before finding the real one: `Lug`'s own 133 members
are individually self-consistent and 100% correct (the STRING member `Z5_Product_Name` at offset
340 correctly gaps 88 bytes to the next member, matching `_STRING_SIZE`; the struct's own last
member, `Trim_Decision`, a `DINT[10]`, is contiguous with its neighbors); `_get_type_size("LUG",
...)` and `Lug`'s own declared total-size attribute (a real, separate stored field, value 568)
both independently agree on 568; and — decisively — 568 is already aligned to 2, 4, *and* 8 bytes,
so a generic "round the struct size up to alignment" rule is mathematically a no-op here and
cannot explain needing 570 (ruling out a general alignment-padding theory the user separately
raised: Rockwell does pad individual members for natural alignment, e.g. three `SINT`s followed by
a `DINT` leaves a 1-byte gap — real and relevant to how *live* members get positioned, which we
already handle correctly by trusting each live member's own stored offset — but that's a different
mechanism from this specific gap).

**Root cause**: `Lug`'s member collection has a **deleted member** — a real child comps row
(`Z1_Nominal_Width`, `record_type=512` vs `256` for a live member) with **no matching
extended-record descriptor at all** (found by comparing the member-collection's child comps-row
count, 134, against the DataType's own extended-record-derived member count, 133 — the mismatch
itself is the detection signal). Deleting a UDT member removes its type-level descriptor
(`data_type`/`dimension`) entirely, but **not** its old byte range from any tag data table already
allocated before the deletion — so the type's own declared size (568) and every live sibling's own
stored offset are both computed from *currently-visible* members only, blind to the dead member's
physical footprint, while the real data table (frozen at allocation time) still reserves it. The
user confirmed (having authored the deletion) that `Z1_Nominal_Width` was originally `DataType=
"INT"` via an older Studio 5000 export of the same UDT from a sibling project
(`Lug_DataType_Snider.L5X`) — exactly the missing 2 bytes.

We cannot recover a dead member's original type from anything else available: its own comps row is
mostly boilerplate template data (nearly byte-identical to a live member's own row past a short
prefix that's absent/zeroed in the dead one — likely a type reference, which is exactly the thing
that's missing), and `CanonicalSize.Dat`-style per-object size tables weren't found to cover this
either. Fixed as a **documented best-effort default, not a general algorithm**: any orphaned
member-collection child (no extended-record descriptor) is assumed to cost 2 bytes (INT-sized —
the smallest non-BOOL primitive), logged via `log.warning()` so a wrong guess for a *different*
project's dead member is visible rather than silently corrupting values, stored on the owning
`DataType` as `_dead_member_bytes` (`DataTypeBuilder.build()`).

`pntrTpStrt` etc. are *scalar* (non-array) siblings of `BfrLug`, and a scalar struct-typed member
never consults `_get_type_size()` at all; its own (and every subsequent sibling's own) byte offset
comes directly from Rockwell's stored per-member value, equally blind to the dead member's
footprint. Fixed via `_apply_dead_member_byte_corrections()`, a post-processing pass run once every
`DataType` is built (so nested-type name references resolve, including forward references), which
walks each DataType's own members in declaration order and shifts every member *after* a scalar
struct-typed member whose nested type carries dead bytes, cumulatively (so multiple dead-byte-
carrying structs in the same chain compound correctly).

**A first attempt also added `dt._dead_member_bytes` inside `_get_type_size()` itself, reasoning
this would additionally fix an *array* of a dead-member-carrying struct type's element stride —
this was wrong, and reverted.** See "Initial-value decoding offset bugs" (finding 5) below for the
full story: verified against a real 200-element array of this exact UDT that the true per-element
stride is the plain `max(offset + size)` value with **no** dead-byte addition. `_get_type_size()`
must never add `_dead_member_bytes`; only `_apply_dead_member_byte_corrections()` needs it.

**Verified**: `Trim_Decision` and its sibling `Fence_Decision` (both `LugWrk`-typed) now match real
Studio 5000 ground truth **exactly** — 170/170 leaf `Decorated` values identical, and the `L5K`
literal byte-for-byte identical (736 chars, zero diff) — up from 5 wrong scalar values and a
truncated `L5K` shape. Re-ran the full 99-`DataType` whole-project comparison (see the BIT-target
section above) after this fix: still zero mismatches, confirming the correction pass doesn't
disturb any DataType lacking a dead member (the overwhelming majority — `_dead_member_bytes`
defaults to 0, making it a no-op unless a real orphan is detected). Unit tests
(`test_get_type_size_does_not_add_dead_member_bytes`,
`test_apply_dead_member_byte_corrections_shifts_subsequent_members`,
`test_apply_dead_member_byte_corrections_noop_when_no_dead_bytes`) lock in both the correction pass
and that `_get_type_size()` stays a no-op for dead bytes, independent of any real ACD fixture.

**Caveat for the next dead member found in a different project**: the "2 bytes, INT-sized" default
is confirmed correct for exactly one real case. If a future orphaned member turns out to need a
different size (DINT=4, LINT=8, etc.), the `log.warning()` this fix added is the signal to
investigate — check for an old export of the same UDT from before the deletion (as the user
provided here) rather than guessing.

## REAL/LREAL NaN and Infinity rendering (`_l5k_real_literal`/`_decorated_real_literal`)

Found while attempting a full whole-project `to_xml()` export of a large real project for the
first time (previously only individual routines/tags had been spot-checked) — it crashed
entirely with `ValueError: not enough values to unpack` in `_l5k_real_literal`. Root cause: a
handful of real REAL/REAL[] tags in that project (uninitialized, never written) decode to
NaN/Infinity, and Python formats these as bare `"nan"`/`"inf"` (no `"e"` to split on), which
`_l5k_real_literal` assumed would always be present. **This affected every non-finite REAL value
project-wide, and made whole-project export impossible for any project containing one** — not a
cosmetic issue.

Confirmed against that same project's own Studio 5000 L5X export (it has 6 such tags: one
`REAL[12]` array with `Infinity` in one element, several scalar `REAL` tags with `NaN`) that
Rockwell uses the classic MSVC CRT special-value convention, but the two output contexts
(`<Data Format="L5K">` vs `<Data Format="Decorated">`) render it differently, and a scalar
Decorated value renders differently again from an *array* Decorated value:

- **L5K** (`_l5k_real_literal`): the special-value label is left-padded with zeros into the same
  8-character mantissa slot a normal number occupies, then the usual `e+000` exponent is still
  appended: `"1.#QNAN000e+000"` for NaN, `"1.#INF0000e+000"` for +Infinity.
- **Decorated, scalar** (`_decorated_real_literal(..., in_array=False)`): the bare label with no
  padding/exponent — confirmed `"1.#QNAN"` for NaN; `"1.#INF"` for Infinity is inferred by direct
  symmetry (not independently observed in this project, no scalar Infinity tag existed to check).
- **Decorated, array element** (`_decorated_real_literal(..., in_array=True)`): a genuinely
  different, truncated value — `"1.$"` for the one case observed (+Infinity) — this is a real,
  reproducible quirk/bug in Studio 5000's *own* array-element exporter (verified byte-for-byte:
  `<Element Index="[11]" Value="1.$"/>` in the real L5X), not something we're free to "fix" to be
  more sensible. Applied to NaN too since no counter-evidence exists and the truncation looks like
  a generic "any `#`-prefixed label gets mangled in this code path" bug rather than one specific
  to Infinity.
- Sign-prefixed forms (`-1.#QNAN...`, `-1.#INF...`, `-1.$`) and the classic MSVC `-1.#IND`
  indeterminate-NaN special case were not observed in this project (all 6 tags were positive-signed)
  and are inferred by symmetry only — revisit if a real negative-signed non-finite value is ever
  found to disagree.

Also applied `_decorated_real_literal` to UDT member REAL/REAL[] fields (`_udt_scalar_to_xml`),
which previously used bare `f"{val}"` (Python's full-precision float repr, e.g.
`"1.2999999523162842"`) instead of the short `.6g`-style form every other REAL value in the
codebase uses — likely a latent, separate fidelity bug beyond just the NaN/Infinity crash, though
not independently verified against a real nested-UDT-with-REAL-member sample.

Regression tests: `test_l5k_real_literal_nan_and_infinity_do_not_crash`,
`test_decorated_real_literal_scalar_nan`, `test_decorated_real_literal_array_infinity_matches_real_quirk`.

## STRING-family decode must use latin-1, never utf-8 (`_decode_string_family_value`)

Found immediately after re-testing the `Trim_Decision` export fixes above against real Studio 5000:
a *different* real tag (`LugTrm`, a `Lug[200]` array) failed import with `Only ASCII characters are
supported` on its `<Data Format="L5K">` element. Root cause: `_decode_string_family_value` decoded a
STRING member's raw bytes with `raw.decode("utf-8", errors="replace")` — a Rockwell STRING is just a
raw `SINT[]` byte array with no guarantee of valid UTF-8 content, and for element 114 of that array
(uninitialized/garbage data — its own `LEN` field read as ~17.8 million, obvious nonsense, clamped to
the type's 82-byte capacity, meaning the "text" that follows was never real content either) the raw
bytes weren't valid UTF-8. `errors="replace"` silently inserted U+FFFD (the Unicode replacement
character) for every invalid sequence — itself a non-ASCII codepoint, and unlike control characters
(already `$XX`-hex-escaped by `_l5k_string_padded`, see above), nothing was escaping it, so it reached
the L5K literal raw and Studio rejected it.

Fixed by decoding as **latin-1** instead — a 1:1 byte↔codepoint mapping that can never fail (every
byte 0x00-0xFF maps to a valid codepoint), so every original byte value survives intact whether it's
meaningful accented/extended text (plausible in this project — French terminology in tag/product
names) or pure garbage. `_l5k_string_padded`'s existing `$XX`-escape logic (originally only for
control characters 0x00-0x1F/0x7F) was extended to also escape any byte `> 0x7E` (non-ASCII), so
every possible byte value the latin-1 decode can now produce is representable in an ASCII-only L5K
literal. **`_string_literal_cdata`/`Tag._sanitize_xml_text` (used for the `Decorated` CDATA content)
needed no change** — XML 1.0 legitimately allows Unicode text in CDATA (0x20–0xD7FF, 0xE000–0xFFFD),
so a latin-1-decoded accented character (or garbage byte) renders there as valid, unescaped XML,
matching what real Studio would show; only the `L5K` text-literal format has the ASCII-only
restriction.

Verified: the same real project's `LugTrm`/`LugALL`/etc. tags no longer produce any non-ASCII
character in their `L5K` output (swept every controller-scope tag), while `Decorated` output still
correctly contains the raw latin-1-decoded characters in CDATA (not stripped or escaped away) — and
`Trim_Decision`/`Fence_Decision` (fixed earlier in this same investigation) still match real Studio
ground truth exactly, confirming this change didn't regress anything for tags without STRING content.
Regression tests: `test_decode_string_family_value_uses_latin1_never_replacement_char`,
`test_l5k_string_padded_escapes_non_ascii_bytes`, `test_l5k_string_padded_still_escapes_control_chars`.

## UDT total size must round up to a multiple of 4 (`_get_type_size`), and alignment can absorb a
## pending dead-byte shift (`_apply_dead_member_byte_corrections`)

Found via a fresh Studio 5000 "Tag Name Collision / Data Compare" dialog on a re-exported routine
(same investigation as the fixes above): a plain `DINT[40]` tag (`Comm_From_VABView_Recipe_Status`)
showed every value multiplied by 65536 vs. the real Studio value, AND (after fixing that) a *scalar*
UDT tag (`EncTrm`, type `Encoder`) showed the exact same 65536x pattern on several plain scalar
members despite `Encoder` having zero orphaned members of its own. Two genuinely different bugs
were found chasing the `Encoder` case, both confirmed **directly against Studio 5000's own UDT
Properties dialog** (`Data Type Size` field — an authoritative value the user screenshotted for
`Lug`, `Encoder`, and `LugWrk`), after seven other hypotheses (TIMER/COUNTER reference, array-of-
struct members, `DataType`-level `built_in`/`module_defined`/`string_family` flags, tag-level
attributes, `record_format_version`/`cip_type`, object_id ordering) were tested and ruled out:

1. **`_get_type_size()` must round a UDT's computed size up to a multiple of 4, not just leave it
   as-is.** Rockwell always declares a UDT's total size as a multiple of 4, confirmed directly:
   `Encoder`'s members sum to 263 bytes (its own last member is one of three trailing 1-byte hidden
   `SINT` backing fields for BIT-flag groups), but Studio's own Properties dialog shows `Encoder`'s
   `Data Type Size` as **264** — later, the user explicitly confirmed this in general ("UDT can
   only have a multiple of 4 byte total size"), correcting an initial narrower guess of just
   "round to even" (264 happens to also be even, which is why the narrower guess wasn't immediately
   caught). `Lug` (568) and `Timing` (144) are already multiples of 4, which is why testing only
   those two earlier didn't surface this.
2. **A BOOL array member can absorb part or all of a pending dead-byte shift via its own 4-byte
   alignment, so `_apply_dead_member_byte_corrections()` must not apply the shift flatly.** Found by
   comparing `LugWrk`'s own computed size (650) against Studio's declared size for the *same* UDT
   (**648**) — a 2-byte *overcorrection*, in the opposite direction from the original dead-member
   bug. Root cause: `LugWrk`'s trailing `Ons` (`BOOL[32]`, 4-byte aligned since it's bit-packed into
   DINT-sized words — the same rule `_get_type_size()` already uses for BOOL-array *sizing*) had its
   own stored offset already correctly positioned by Rockwell's own alignment padding (which
   naturally absorbs a smaller gap left by the preceding dead-member correction); blindly adding the
   full pending +2 on top of an already-correctly-aligned offset overcorrected it. Fixed by having
   `_apply_dead_member_byte_corrections()` track each member's own true end as it walks a DataType's
   members, and for a BOOL array specifically, recompute its start by aligning up from the previous
   member's true end (`-(-prev_true_end // 4) * 4`) instead of adding the flat cumulative shift —
   the *effective* shift actually applied (which may be less than the pending amount) is what
   carries forward to subsequent members. Also fixed a related latent bug this exposed: a scalar
   struct-typed member's own contribution to the running "true end" tracker didn't include its
   nested type's own dead bytes, which would have mattered if a BOOL array followed such a member
   with nothing in between (not exercised by `LugWrk`'s own shape, but fixed since found).

**Verified**: `Lug` (568), `Encoder` (264), and `LugWrk` (648) computed sizes now all match Studio
5000's own declared "Data Type Size" for the same three real UDTs exactly. Re-ran the full
99-`DataType` whole-project comparison and the 369-tag array sweep (both established earlier in
this investigation): still zero mismatches for both, confirming these two fixes are a no-op for
every UDT that doesn't need them (the overwhelming majority — no dead members, no BOOL array
immediately following one). `Trim_Decision`/`Fence_Decision`'s `L5K` literal re-verified
byte-for-byte identical to real Studio ground truth after this change. New regression test:
`test_apply_dead_member_byte_corrections_bool_array_absorbs_shift_via_alignment`.

**RESOLVED (was "still open" above) — the whole "some tags need +2" mystery, definitively.** The
`0x1A2`/`0x1A2 + 2` split described throughout this section and "Initial-value decoding offset
bugs" below was **never actually about scalar-vs-array, or about which UDT type is involved** —
every one of those correlations (array-vs-scalar, `Lug`/`LugWrk`-vs-everything-else) was
coincidental to the specific projects tested. The real mechanism, found by finally parsing the
tag's `data_table_instance` comps record as the ordinary structured `RxGeneric` record it actually
is instead of guessing an absolute byte offset into it:

- That record's own header declares `count_record` attribute records, but `RxGeneric._read()`'s
  Kaitai-generated parsing loop (`for i in range(self.count_record - 1)`) always leaves the
  **last** one unparsed in the stream — deliberately or not, this last attribute record (always
  `attribute_id 0x66`) is never read into `extended_records` at all.
- That unparsed last attribute record **is the tag's own value blob**: its own 4-byte `len_value`
  field always exactly equals the tag's computed value size (verified across every scalar/array,
  primitive/UDT tag checked), and its value payload — starting 8 bytes (`attribute_id +
  len_value`) after wherever the 3 parsed `extended_records` leave off — is the real data.
- The "some tags need +2" appearance came entirely from this: the byte length consumed by the 3
  *parsed* attribute records (in particular attribute `0x1`, an opaque boilerplate blob) genuinely
  varies by a couple of bytes between records/projects — 286 bytes in one fresh Studio 5000 V32
  test project, 288 bytes in an older V38 production project — which is a real, computable
  difference in the record's own self-declared structure, not something dependent on whether the
  tag is a scalar, an array, or which UDT type it uses.

Fixed by adding `_tag_value_blob_offset(raw_rec)` (`elements.py`), which parses the record via
`RxGeneric.from_bytes()` and computes `82 + sum(8 + len(value) for er in extended_records) + 8` —
replacing the old fixed-constant/`is_array`-conditional guess entirely in both
`_read_tag_initial_value` and `_decode_udt_initial_value`.

**A second, compounding bug was found and fixed in the same investigation**: with the above fix
alone, a real, *populated* `Trim_Decision` tag (`LugWrk`-typed; the user provided a live Studio
5000 screenshot of its Monitor tab) still decoded 5 populated fields wrong
(`pntrTpStrt`/`pntrTpStp`/`pntrLug`/`Wrk[4]`) — because `_apply_dead_member_byte_corrections`
(see "Nested-UDT decode recursion-depth double-increment" below) was *also* adding a +2 shift to
every `LugWrk` member following `BfrLug` (`Lug`-typed, which has one deleted/orphaned member),
double-counting a correction that the fix above already fully accounts for. The earlier "verified
exact, 170/170 leaf values" claim for this exact tag was made against an **all-zero/unpopulated**
instance, which cannot distinguish a correct offset from one that's off by 2 — this is why a real,
populated instance was necessary to catch it, and a reminder that an "exact match" check is only
as strong as the ground truth data actually exercises the code path in question. Fixed by making
`_apply_dead_member_byte_corrections` a no-op — Rockwell's own stored per-member byte offsets
already account for everything correctly, with no adjustment needed for a nested type's dead
bytes. `_dead_member_bytes` is still computed and logged (`DataTypeBuilder.build()`) as a
diagnostic that a type has an orphaned member, but no longer feeds into any byte-offset math
anywhere.

Verified end-to-end against the real project: `EncTrm.PlssQty=256`, `Trim_Decision.pntrTpStrt=24`/
`pntrTpStp=25`/`pntrLug=183`/`Wrk=[0,0,0,0,32790,0,0,0,0,0]` (all matching the user's live Studio
5000 screenshot exactly), `LugTrm[0].No=158`/`Year=2026`, `Comm_From_VABView_Recipe_Status`'s first
10 values — and, separately, the fresh V32 test project's `TestDintArray`/`TestLug`/`ZZTest1` all
still decode correctly (proving the fix generalizes rather than just re-fitting the V38 project).
A full whole-project `to_xml()` export of the real project also completes without error. Full test
suite: 101 passed, 2 skipped (up from 97/2, after rewriting the tests that had encoded the old,
disproven fixed-offset assumptions to instead build a synthetic `RxGeneric`-shaped record via a new
`_build_dti_record()` test helper).

## Rung patch write-back (`patch_rungs`/`patch_sbregion_dat`)

This path (`acd/zip/write_dat.py`) had **zero test coverage** until it was manually exercised
against a real, large project and found to have two real bugs (both now fixed, with regression
tests in `test/test_patch_rungs.py`):

1. **Compression.** `patch_sbregion_dat()` used to return *decompressed* `SbRegion.Dat` bytes.
   `build_acd_bytes()`/`save_acd()` never compresses anything — it writes whatever is in
   `_raw_files` verbatim — so the patched file alone ballooned ~12x in a real project (1.08MB →
   13.8MB decompressed) and was stored as a plain, non-gzip stream while every other internal
   `.Dat`/`.Idx` file stays gzip-compressed. `patch_sbregion_dat()` now re-compresses before
   returning. Rockwell's own encoder was reverse-engineered by trial: `gzip.compress(data,
   compresslevel=1, mtime=0)` reproduces the **entire DEFLATE payload + CRC32 + ISIZE trailer
   byte-for-byte** against a real project's original `SbRegion.Dat` — the only remaining
   difference is the header's XFL/OS bytes (offsets 8-9 of the gzip stream), which are purely
   informational per RFC 1952 and don't affect decompression; they're patched to Rockwell's
   values anyway (`XFL=0x00`, `OS=0x0b`/NTFS) for a fully byte-identical no-op round-trip.
2. **Hex-ref formatting.** `_restore_tag_refs()` re-encoded `@HEX_OBJECT_ID@` tag-reference
   placeholders with `:X` (uppercase, no zero-padding). The real convention, verified by sampling
   20,710 real `@...@` refs in one project's `SbRegion.Dat`, is **exactly 8 hex digits,
   zero-padded, lowercase** (`:08x`), 0 of them uppercase. Using `:X` produced a
   numerically-equivalent but textually different reference, so even a true no-op patch (rung
   rewritten to its own existing text) silently produced different bytes.

With both fixes, a no-op patch (rewrite a rung to its own current text) now reproduces the
**exact original ACD container, byte-for-byte** — verified against both the small test fixture
(`test_patch_rungs.py`) and a large real-world project manually. This is the strongest available
confidence check for this write path, since it proves the full decompress → re-encode →
recompress cycle is lossless and matches Rockwell's own encoding conventions closely enough to
be indistinguishable from the source, without needing an actual Studio 5000 install to verify.

**Still unverified: whether a real, non-no-op edit (i.e. actually different rung text) produces
a file real Studio 5000 accepts.** Two separate open questions remain, neither resolved yet:
- Without a registered `FileInfo.Dat` signing key (see `acd/integrity/`), any mutation leaves
  the checksum stale; whether Studio 5000 actually enforces/checks this on open (as opposed to
  only the SDK) is untested — **three purpose-built experiment ACDs now exist to answer this;
  see the next section**.
- Even with a valid key, nobody has confirmed a `save_acd()`-produced, mutated ACD actually
  opens correctly in real Studio 5000 — that would require an actual test against the real
  software, which hasn't been done as of this writing.

## ACD write-back: what a real Studio 5000 save/edit actually writes (three-way diff)

Reverse-engineered from three sibling saves of the same large real project (in
`...\PLC_Claude_Code\Bethel_Planer\source\`): `BPM_TrimmerSorter_20260707.ACD` (original),
`..._STUDIO_NOOP.ACD` (opened in Studio, saved unmodified), `..._STUDIO_EDITED.ACD` (opened,
one edit, saved). `Version.Log` (plain text, one `"...: Saved - V32.04"` line per save)
revealed the EDITED save actually happened *before* the NOOP save — both are independent
children of the original, so `noop→edit` isolates exactly one edit's footprint on an identical
save-normalization baseline. Compare **decompressed** contents (every internal `.Dat`/`.Idx`
is gzip-compressed in the container); many `.Dat` files have page-quantized sizes (multiples
of 65535) that stay constant while content changes.

**The identified edit** (recovered purely from the binary diff): rung `0x17c4b9bd` in routine
`Flasher` had `OTE(BitFlags[21])` appended, and — incidental leftover of the same editing
session — a new, unused controller-scope tag `BitsFlags` (note the extra "s": almost certainly
typed first, auto-created by Studio's inline new-tag flow, then corrected) was created under
`RxTagCollection`.

**Finding 1 — save-time compaction/GC exists but is NOT required on open.** A no-op resave
shrank `Comps.Dat` by ~581KB (19113→19097 records, dead `fd fd` records 151→142), dropped 372
stale `SbRegion.Dat` records, 54 `Nameless.Dat` records, etc. But the *original* (uncompacted,
dead-record-laden) file opens fine in Studio — that's where the NOOP/EDITED saves came from.
So a writer does **not** need to replicate compaction; it only needs to express its own delta
with consistent cross-file invariants.

**Finding 2 — the complete per-file footprint of the one rung edit (`noop→edit`)**:
- `SbRegion.Dat`: the rung's `Rung NT` record is **excised in place (bytes compacted out, not
  tombstoned) and the new version appended as the physically-last record**. Every other record
  byte-identical — including the rung's own 1065-byte `REGION AST` record (compiled form is
  NOT regenerated). Header: u32 at file offset 0 = (file length − 1), u32 at offset 8 =
  record-region length (both adjusted); `DatHeader` also has `no_records` at 0x14 and a
  second count at 0x18 (unchanged here: −1 removed +1 appended).
- `SbRegion.Idx`: ~10k tiny diffs — the B-tree entries store **absolute `.Dat` record offsets**
  which all rebase by the length delta after the excision point. Any length-changing `.Dat`
  edit MUST rebase its `.Idx` (our current `patch_rungs` does not — see experiments below).
- `Nameless.Dat`: the routine's compiled-artifact records are **deleted, not regenerated**
  (a 1740-byte compiled-body record and a 68-byte link record removed; a 56-byte list record
  keyed by the routine's object_id at body[8:12] rewritten shorter with its child references
  emptied). Net −2 records.
- `Comps.Dat`: 422 differing bytes in 13 regions, fully decoded:
  - the routine's own record: one byte at body[10] flips `0x03 → 0x00` (compile-state/"dirty"
    flag, matching the deleted compiled artifacts);
  - the controller's own record: an 8-byte FILETIME last-edit timestamp updated;
  - **new-object creation via free-slot resurrection**: a dead `fd fd` record (an old deleted
    tag `Test3dudt` — deleted comps records keep their full bytes, and *pointer* records get
    renamed to `$hex$` placeholder names like `$447f0b6a$`) is flipped to `fa fa` and
    overwritten with the new tag's record; same for its paired pointer record elsewhere;
  - a **free-list structure inside Comps.Dat** (same idea as the Comments.Dat free-list): a
    count field decremented (0x18→0x17) and the entry holding the resurrected slot's file
    offset — stored as a **3-byte big-endian** value inside a 10-byte entry — removed from the
    list (tail shifted up, last entry left duplicated as garbage);
  - `.Dat` header counts at file offsets 0x14/0x18: live-record count +1, free-record count −1;
  - two allocator/seed fields (one near the file header at ~0xc25 holding the most recently
    allocated object_id, one at ~0x4cce) updated.
  - Comps record body layout (relative to the 6-byte `fa fa`+u32len prefix): body[0:4] inner
    length, body[8:12] flags (body[10] = the dirty byte for routines), body[16:20] object_id,
    body[20:24] parent_id, body[24:] UTF-16LE name.
- `CanonicalSize.Dat`: a per-object table of `(0x0200 marker u32, canonical_size u32,
  object_id u32)` entries; the edited rung's size went `0x18 → 0x1c` (+4 for one added
  instruction).
- `RegnLink.Dat`: **header counter/timestamp only — zero record changes** (the rung kept its
  object_id and chain position); `RegnLink.Idx` byte-identical.
- `XRefs.Dat`: +3 records appended (header count at 0x14 `0xbbdf→0xbbe2`, count at 0x18 +1),
  one ~89-byte tail region rewritten with entries referencing the rung and routine ids —
  format still not reverse-engineered (`record_format` 132; `DbExtract` refuses it).
  `XRefs.Idx` grew by exactly one 0x3FFF page.
- Every `.Dat`/`.Idx` header also has a save-generation counter + unix-timestamp pair in the
  `[0x6c:0x74]` region that bumps on each save even when the file is otherwise untouched.
- `QuickInfo.XML`: the `CopyUID="..."` attribute value is regenerated per save.
  `OfflineChangelog.Dat`: a 4-byte counter. `Version.Log`: appends a `Saved - V<ver>` line.
  `FileInfo.Dat`: the 32-byte digest at [2:34] differs on every save (as expected).

**Finding 3 — experiment files for the FileInfo-enforcement question** (built with this
library from the NOOP baseline, in `...\Bethel_Planer\source\WriteBack_Tests\`; all three
verified to re-parse correctly with our own reader; none has a valid FileInfo digest):
- `EXP0_deadrecord_byte.ACD` — one byte inside a *dead* Comps record's leftover text
  (`Test3dudt`→`Xest3dudt`); semantically invisible. If Studio opens it → the FileInfo
  checksum is **not** enforced on open (nothing else can be blamed).
- `EXPA_comment_letter.ACD` — one letter changed in place, same length, in a live rung
  comment (`VAB_MainProgram/R02_Flash` rung 3: `Bit flash X/5`→`Bat flash X/5`). If it opens
  AND shows "Bat" → same-length in-place `Comments.Dat` edits are viable end-to-end.
- `EXPB_rung_append_ote.ACD` — the same rung edit Studio itself made, but via our
  `patch_rungs()` (in-place, length-changing), deliberately leaving `SbRegion.Idx` offsets,
  Nameless compiled artifacts, the Comps dirty flag, `CanonicalSize`, and `XRefs` all stale.
  If it opens and shows the new rung → Studio's loader is lenient about all of that; if it
  fails, add the bookkeeping pieces one at a time (start with `SbRegion.Idx` rebasing —
  the most likely hard requirement).

**RESULT — `FileInfo.Dat` IS enforced by Studio 5000 on open (definitive).** The user opened
`EXP0_deadrecord_byte.ACD` in real Studio 5000: it was **rejected** with *"File is not
recognized as a valid project file"* — a container-level rejection that fires before any
project-content parsing. This is the cleanest possible proof, because EXP0 is provably NOOP
with exactly ONE semantically-dead byte changed:
- A zero-edit passthrough (read the NOOP container's raw file blocks, rebuild via
  `build_acd_bytes`, no changes) reproduces the NOOP `.ACD` **byte-for-byte** — so the
  container writer is not the culprit.
- Recompressing an unchanged `Comps.Dat` with `gzip.compress(level=1, mtime=0)` + XFL/OS
  patch reproduces the original compressed stream **byte-for-byte** — so the recompression
  is not the culprit.
- EXP0's only change vs NOOP is one byte inside a dead `fd fd` record (invisible to parsing)
  and, consequently, a now-stale `FileInfo.Dat` digest. NOOP itself opens; EXP0 doesn't.
  The stale digest is the only remaining difference → `FileInfo.Dat` is enforced on open.

**Consequence: the entire raw-binary write path is blocked on recomputing `FileInfo.Dat`,
which needs the HMAC key.** EXPA/EXPB were not worth testing after this — they change *more*
than EXP0, so they can only also fail at the same gate; they become useful only once files
can be correctly re-signed. The key situation, corrected from earlier notes:
- `acd/integrity/fileinfo.py` implements the (hypothesised) construction:
  selector `02 00` = `HMAC-SHA-256(key, sha256(container − FileInfo.Dat))`, key = 32 bytes.
  This project's `FileInfo.Dat` is selector `02 00` (header bytes `02 00 …`), so it needs the
  32-byte key.
- **The key is a per-Studio-version constant, NOT a per-project brute-force target** (earlier
  task framing was wrong on this). Per our own module docs it is extractable from a legitimate
  Studio 5000 install. It is not shipped with this library and is not present anywhere in the
  repo, tests, or environment (`ACD_FILEINFO_KEY` unset).
- **The HMAC construction in `fileinfo.py` has never been validated against a real key** — the
  integrity tests only check self-consistency with dummy keys; the real end-to-end test is
  gated behind the unset `ACD_FILEINFO_KEY`. So even once a key is obtained, the algorithm
  itself is still an unconfirmed hypothesis. We hold three genuine Studio-signed containers
  (orig / noop / edit, all same project, all with *different* valid `FileInfo.Dat` digests):
  the instant a candidate 32-byte key is available, verify it against all three with
  `verify_fileinfo()` — a correct key must match all three, which simultaneously confirms both
  the key and the algorithm.

**Open paths from here** (none pursued yet, pending a decision):
1. Obtain the 32-byte key from the user's Studio 5000 install (DLL/static extraction on their
   machine — not installed on the dev machine). Biggest unlock: if the algorithm is right,
   `save_acd()` re-signs correctly and EXP0/EXPA become the next probes.
2. Native-import escape hatch (mirrors `export_routine()` → Studio "Import Routine"): sidesteps
   `FileInfo.Dat` entirely for the edits it covers. Likely the pragmatic path for actually
   getting tag/rung/comment edits into a project without solving the key.
Outcome of any Studio re-test after re-signing not yet recorded — update here when known.

## Comparing I/O addresses across two projects (`find_io_addresses`/`diff_io_addresses`)

Added after a downstream LLM session, asked to find I/O address changes between two ACDs (two
saves of the same project, and separately a "mill" vs "VAB" variant), hand-rolled a regex that hit
a `re.error: unbalanced parenthesis`, then an `IndexError` from zipping two routines' rungs by
index once it worked — routines routinely have a different rung count between two otherwise-
similar projects/saves, so index-based comparison is fundamentally the wrong approach, not just a
bug to patch around.

`acd/api.py` now exposes three public functions for this instead of leaving every caller to
reinvent the tokenizer:
- `find_io_addresses(text) -> List[str]`: extracts every I/O-style address from one rung/ST-line
  of text (`"IO024:I.Data[0].13"`, `"Remote_GraderConsole:3:I.Pt13.Data"`,
  `"Local:10:I.Data.11"`, `"Sorter_VFD:I.DriveStatus_Active"`). A real I/O address always contains
  `":"` (reserved by Rockwell's own tag-naming rules for module addressing), so this never
  collides with a plain UDT member path like `"M304_Sorter_Lug_Chain.VFD.Running"` — verified
  against real examples pulled from an actual project-vs-project diff (see the regex `_IO_ADDRESS_RE`:
  base name, optional `:slot`, required `:Type`, then a repeating `.Member`/`.bit`/`[idx,...]` chain).
- `io_addresses_by_routine(project) -> Dict[(program_name, routine_name), List[str]]`: every
  routine's full set of I/O addresses (RLL rungs + ST lines), duplicates included, in source
  order. AOI logic routines are keyed as `("AOI:<name>", routine_name)` since they have no Program.
- `diff_io_addresses(project_a, project_b) -> Dict[(program_name, routine_name), {"removed":
  [...], "added": [...], "common": [...]}]`: routine-by-routine, set-based (not index-based) I/O
  address diff between two projects — only routines with an actual difference are included. A
  routine unique to one side still gets an entry (everything shows as fully added/removed).

Verified end-to-end against the real `BPM_TrimmerSorter_20260713.ACD` /
`BPM_TrimmerSorter_VAB_20260713.ACD` pair (`Bethel_Planer_20260713_Compare`): 64 routines reported
with real, sensible I/O address differences (e.g. `Advance`'s `Sorter_VFD:I.DriveStatus_Active`/
`Sorter_VFD:I.OutputFreq` present only in the mill project), with zero crashes despite routines
differing in rung count between the two files — the exact scenario that broke the ad hoc script.

**Follow-up gap, found immediately after shipping the above**: the user reported their downstream
LLM defaulted to `diff_io_addresses()` whenever asked for a *generic* "what changed between these
two files" comparison, not just I/O-specific requests — because it was, at the time, the only
`diff_*`-named function in the public API, so an LLM pattern-matching on "diff" had nothing more
appropriate to reach for. Added `diff_project()` (same file) as the actual general-purpose entry
point, and tightened `diff_io_addresses()`'s own docstring to explicitly disclaim general use
("do not reach for this function by default just because it has 'diff' in the name") — the lesson
being that a narrowly-scoped function with a generic-sounding name will get misused by an LLM
caller unless a correctly-scoped alternative exists *and* the narrow one's docstring actively
steers away from itself, not just describes what it does.

`diff_project(project_a, project_b) -> dict` covers, each only populated when something differs:
- `"routines"`: keyed like `io_addresses_by_routine()` (`(program_name, routine_name)`, AOI logic
  routines as `("AOI:<name>", routine_name)`). `"status"` is `"added"`/`"removed"`/`"changed"`; a
  `"changed"` entry's `"changes"` list comes from `difflib.SequenceMatcher(a=lines_a,
  b=lines_b).get_opcodes()` over the routine's rungs (RLL) or `_st_lines` (ST) — reusing the same
  alignment-based approach (not index-zipping) as `diff_io_addresses()`, for the same reason: two
  routines routinely have a different rung count even when "the same" logic-wise.
- `"tags"`: keyed `(program_name_or_"", tag_name)` (`""` = controller scope); compares
  `data_type`/`description`/`_initial_value` for tags present on both sides.
- `"data_types"`/`"modules"`/`"aois"`: presence-only (added/removed by name) — deliberately does
  NOT diff UDT member layout, module connection/RPI details, or AOI parameters; documented as a
  known scope limit in the function's own docstring rather than silently doing something partial.

**Second follow-up, found the very next time a downstream LLM actually used `diff_project()` on a
real large project pair**: it technically worked, but the "tags" section dumped every changed
tag's FULL old/new `_initial_value` inline — for a UDT array tag that's a list of dozens of
per-element dicts, so one real comparison (`BPM_TrimmerSorter_20260713.ACD` vs
`BPM_TrimmerSorter_VAB_20260713.ACD`, 1601 changed tags) produced an unreadable wall of raw numeric
noise that overflowed the LLM's context before it could even start summarizing. `_diff_tags()` now
runs each tag's `"value"` entry through `_summarize_value_diff()`: values under 200 chars of
`repr()` are still shown in full (`{"old": ..., "new": ...}`), but a large list is reduced to
`{"summary": "list[N] vs list[M]: K of N common elements differ", "differing_indices": [...]
(first 10)}` and a large dict similarly to `{"summary": ..., "differing_keys": [...] (first 10)}`
— callers can tell which shape they got by checking for a `"summary"` key vs `"old"`/`"new"` keys.
Verified against the same real project pair: total `repr()` size of the whole diff dropped from
"too large to read" to ~468KB (290 of 1018 changed-value tags actually needed summarizing; the
rest were small scalars shown in full) — the routines/tags sections can still legitimately be
large for two *genuinely very different* projects (this pair is a mill vs. a substantially
different VAB variant, not two saves of the same logic), so don't expect `diff_project()` output
to always be small; the fix targets the *per-value* blowup, not the *aggregate* size when the
underlying projects really do differ everywhere.

**Third follow-up**: despite both fixes above and the module docstring already recommending
`diff_project()`, a downstream LLM asked to look at one specific routine (`Motors/Main_Motors`)
across the same two real projects still wrote its own manual comparison — fetched both `Routine`
objects, then printed `.rungs` for each side by side by index. Three JSR rungs were removed near
the top of one project's copy, shifting every later rung's index by 3, which made the printed
lists look like the whole routine had changed even though the tail (`Infeed_LandingTable` onward)
was byte-identical. This wasn't a bug in `diff_project()`/`diff_io_addresses()` (both already
handle this correctly via `difflib`) — it was a *discoverability* gap: the LLM had two `Routine`
objects in hand and reached for `print()`/manual zip rather than any diff function, likely because
nothing in the public API matched that exact shape ("I already have two routines, just diff
these") as directly as `diff_project(project_a, project_b)` (which needs whole projects) did.

Extracted the per-routine alignment logic `_diff_routines()` already used into a new public
`diff_routine(routine_a, routine_b) -> {"status": "unchanged"/"changed", "changes": [...]}`, and
rewrote the top of `acd/__init__.py`'s module docstring to lead with an explicit "COMPARING TWO
PROJECTS/SAVES/ROUTINES — READ THIS BEFORE WRITING YOUR OWN COMPARISON CODE" section (previously
this guidance existed but was positioned after the Quick Start snippet, one paragraph among
several, with no equivalent function for the single-routine case) naming all three diff functions
by exact use case. Verified `diff_routine()` reproduces the real `Main_Motors` scenario exactly:
`{"status": "changed", "changes": [{"op": "delete", "old": [the 3 removed JSR rungs], "new": []}]}`
— nothing else reported, confirming the tail is correctly recognized as unchanged.

The recurring lesson across all three follow-ups: a correct implementation is not sufficient for
an LLM caller to actually use it — the function matching the caller's exact mental model ("I have
two routines" vs. "I have two projects") has to exist, and the guidance steering them to it has to
be positioned where it will actually be read (at the very top, restated at the point of need), not
just documented accurately somewhere in the file.

## Testing gotchas

- `test/conftest.py` chdir's into `test/` for the whole session — needed because many tests
  reference `resources/CuteLogix.ACD` via `"../resources/..."` relative paths. If you add a new
  test file, you can rely on cwd already being `test/`.
- Some AB module DataType names contain `:` (e.g. `CHANNEL_DI_TIMESTAMP:O:0`), which is invalid
  in Windows paths — anything that turns a comp name into a filename/directory (see
  `DumpCompsRecords` in `elements.py`) needs to sanitize it first.
- The full suite (`pytest` from repo root) should show all real tests passing and 2 skipped (the
  exact passed count grows as tests are added — as of this writing, 109). If you see
  `FileNotFoundError`s or `PermissionError`s across many unrelated test files, first check you're
  not missing the `conftest.py` chdir behavior or that a previous test crashed and left a locked
  SQLite file/build artifact behind.
- **One test, `test_database.py::test_open_file`, errors in this dev container specifically —
  confirmed pre-existing and environmental, not a code bug.** It errors with `'test_open_file'
  requested an async fixture 'sample_acd', with no plugin or hook that handled it`. Root cause,
  confirmed rather than assumed: `sample_acd`/`sbregion_dat` (both `async def` fixtures, needing no
  `await` at all — plain synchronous `Unzip(...)`/`DbExtract(...)` calls, likely an authoring
  mistake) were introduced together with this test file itself (commit `1c57142`), and that same
  commit's `setup.py` already lists `pytest-asyncio` as a required dev dependency for exactly this
  reason — but `pytest-asyncio` isn't actually installed in this environment (`pip show
  pytest-asyncio` finds nothing), so pytest has no plugin to run an async fixture through. This is
  an environment-provisioning gap (this container wasn't set up via the documented `pip install -e
  ".[dev]"`), not a defect in the fixtures or the code under test — installing `pytest-asyncio`
  would make it pass as originally intended. Confirmed narrow scope: only this one test function
  uses those two fixtures; nothing else in the suite depends on them, and no other test's outcome
  is affected. Already independently identified once before (see `js/CLAUDE.md`'s Round 2 section),
  so this isn't a new finding — re-documented here since it keeps resurfacing in every fresh
  `pytest` run's output and is worth not re-investigating from scratch each time.
