import math
import sqlite3
import struct
from datetime import datetime
from xml.dom import minidom

from types import SimpleNamespace

from acd.l5x.elements import (
    DataType,
    Member,
    _apply_dead_member_byte_corrections,
    _decode_single_udt_element,
    _decode_string_family_value,
    _decorated_real_literal,
    _escape_xml_attr,
    _fbd_bool_field_by_index,
    _fbd_decode_sheets,
    _fbd_make_bit_resolver,
    _fbd_resolve_source,
    _fbd_split_pin_ref,
    _filetime_to_iso,
    _get_type_size,
    _l5k_real_literal,
    _l5k_string_padded,
    _read_tag_initial_value,
    _render_fbd_content,
    _resolve_bit_target,
    _st_routine_lines,
)


def test_filetime_to_iso_zero_is_empty():
    assert _filetime_to_iso(0) == ""


def test_filetime_to_iso_valid_roundtrip():
    # 2020-01-01T00:00:00.000Z expressed as a Windows FILETIME (100-ns units
    # since 1601-01-01).
    ft = int((datetime(2020, 1, 1) - datetime(1601, 1, 1)).total_seconds()) * 10_000_000
    assert _filetime_to_iso(ft) == "2020-01-01T00:00:00.000Z"


def test_filetime_to_iso_out_of_range_is_empty():
    # A corrupt/garbage FILETIME maps to a year far beyond datetime's 9999
    # ceiling; it must degrade to "" rather than raising OverflowError.
    assert _filetime_to_iso(0xFFFFFFFFFFFFFFFF) == ""


def test_escape_xml_attr_basic_entities():
    assert _escape_xml_attr('a&b<c>d"e') == "a&amp;b&lt;c&gt;d&quot;e"


def test_escape_xml_attr_strips_illegal_control_chars():
    assert _escape_xml_attr("a\x00\x15\x1fb") == "ab"


def test_escape_xml_attr_encodes_whitespace_delimiters():
    assert _escape_xml_attr("a\tb\nc\rd") == "a&#x9;b&#xA;c&#xD;d"


def test_escape_xml_attr_keeps_attribute_well_formed():
    # A mis-parsed binary field (e.g. an AOI Vendor) with a raw newline and
    # control bytes must not produce non-well-formed XML.
    garbage = "Acme\x15Corp\nv\t1.0\ufffd"
    xml = f'<AOI Vendor="{_escape_xml_attr(garbage)}"/>'
    parsed = minidom.parseString(xml)  # raises on malformed XML
    assert parsed.documentElement.tagName == "AOI"


def _build_dti_record(value_blob: bytes, attr1_len: int = 288) -> bytes:
    """Build a synthetic data-table-instance comps record matching the real
    RxGeneric layout: a fixed 82-byte header, 3 parsed AttributeRecords
    (attribute_id 0x1/0x64/0x65 -- arbitrary content, only their lengths
    matter), then a 4th, deliberately *unparsed* AttributeRecord (see
    RxGeneric._read(): `for i in range(self.count_record - 1)` always
    leaves the last one unread) whose own value IS the tag's value blob.
    This mirrors real ACD data rather than assuming any fixed byte offset.
    """
    header = struct.pack("<IIHHH", 0, 0, 40, 106, 0)  # parent_id, uid, rfv, cip_type, comment_id
    main_record = b"\x00" * 60
    attr1 = struct.pack("<II", 0x1, attr1_len) + b"\x00" * attr1_len
    attr64 = struct.pack("<II", 0x64, 16) + b"\x00" * 16
    attr65 = struct.pack("<II", 0x65, 2) + b"\x00" * 2
    count_record = 4  # 3 parsed + 1 left unparsed (the value blob itself)
    len_and_count = struct.pack("<II", 0, count_record)
    value_attr = struct.pack("<II", 0x66, len(value_blob)) + value_blob
    return header + main_record + len_and_count + attr1 + attr64 + attr65 + value_attr


def test_read_tag_initial_value_bool_array_bit_packing():
    # Regression test for a real bug found while verifying export_routine()
    # against a real Studio 5000 import: BOOL *array* values were read one
    # raw byte per element (naive per-element offset), but Rockwell
    # bit-packs BOOL arrays 32 bits per 4-byte DWORD. A real 256-element
    # BOOL array tag (BitFlags) decoded index [2] as 32 (a raw packed byte
    # value) instead of the correct 0/1 bit -- any non-zero "value" then
    # renders as BOOL True in the generated XML, silently corrupting every
    # BOOL array tag's exported initial value project-wide.
    #
    # Build a synthetic data-table blob: 40 logical bits spanning two
    # packed DWORDs, with only bit 2 of the first DWORD and bit 5 of the
    # second DWORD set.
    n_elements = 40
    value_blob = bytearray(8)
    struct.pack_into("<I", value_blob, 0, 1 << 2)
    struct.pack_into("<I", value_blob, 4, 1 << 5)
    blob = _build_dti_record(bytes(value_blob))

    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE comps (object_id INTEGER, record BLOB)")
    db.execute("INSERT INTO comps VALUES (1, ?)", (blob,))
    cur = db.cursor()

    values = _read_tag_initial_value(cur, 1, "BOOL", n_elements)

    assert len(values) == n_elements
    expected = [0] * n_elements
    expected[2] = 1
    expected[32 + 5] = 1
    assert values == expected


def test_read_tag_initial_value_uses_structural_offset_not_fixed_constant():
    # Regression test for a major bug: the value blob's start was assumed
    # to be a fixed absolute offset (0x1A2, +2 for arrays), but this was
    # disproven by a real Studio 5000 screenshot of a populated tag
    # (Trim_Decision) whose real values only decoded correctly using the
    # record's own *computed* offset (see _tag_value_blob_offset), which
    # varies by a couple of bytes depending on the record's own
    # extended_records lengths -- not on whether the tag is a scalar or an
    # array, and not on which UDT type is involved.
    #
    # Build two synthetic records whose "attr 0x1" boilerplate blob differs
    # in length (as real ACD records from different projects do), and
    # confirm the same logical value decodes correctly from each despite
    # sitting at a different absolute byte offset.
    for attr1_len in (286, 288):
        blob = _build_dti_record(struct.pack("<i", 42), attr1_len=attr1_len)
        db = sqlite3.connect(":memory:")
        db.execute("CREATE TABLE comps (object_id INTEGER, record BLOB)")
        db.execute("INSERT INTO comps VALUES (1, ?)", (blob,))
        cur = db.cursor()

        value = _read_tag_initial_value(cur, 1, "DINT", 1)

        assert value == 42


def test_read_tag_initial_value_array_uses_structural_offset():
    # A genuine one-element array (Dimensions="1") must decode via the same
    # structurally-computed offset as any other array -- n_elements alone
    # can't distinguish scalar vs array, only is_array can (see the
    # identical distinction for collapsing to a scalar return value).
    blob = _build_dti_record(struct.pack("<i", 42))

    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE comps (object_id INTEGER, record BLOB)")
    db.execute("INSERT INTO comps VALUES (1, ?)", (blob,))
    cur = db.cursor()

    value = _read_tag_initial_value(cur, 1, "DINT", 1, is_array=True)

    assert value == [42]


def test_l5k_real_literal_nan_and_infinity_do_not_crash():
    # A real production project was found with several uninitialized REAL
    # tags decoding to NaN/Infinity, which crashed this function entirely
    # (str.split("e") on Python's bare "nan"/"inf" formatting, with no "e"
    # to split on). Verified against that same project's own Studio 5000
    # L5X export: NaN -> "1.#QNAN000e+000", +Infinity -> "1.#INF0000e+000"
    # (the classic MSVC CRT special-value convention, left-padded with
    # zeros into the normal 8-digit mantissa slot).
    assert _l5k_real_literal(float("nan")) == "1.#QNAN000e+000"
    assert _l5k_real_literal(float("inf")) == "1.#INF0000e+000"
    assert _l5k_real_literal(float("-inf")) == "-1.#INF0000e+000"


def test_decorated_real_literal_scalar_nan():
    # Verified against the real project referenced above: a scalar tag's
    # Decorated NaN value is the bare label "1.#QNAN" (no padding/exponent,
    # unlike the L5K form).
    assert _decorated_real_literal(float("nan"), in_array=False) == "1.#QNAN"


def test_decorated_real_literal_array_infinity_matches_real_quirk():
    # Verified against the real project referenced above: an array
    # Element's Decorated value for +Infinity is the truncated "1.$" --
    # a real, reproducible quirk in Studio 5000's own array Decorated-value
    # exporter (distinct from the scalar case above).
    assert _decorated_real_literal(float("inf"), in_array=True) == "1.$"


def test_resolve_bit_target_prefers_declaration_order_fallback():
    # Regression test for a real, previously-unresolved bug (a downstream
    # agent hit it live): a real UDT ("LugWrk") had 4 BIT members whose own
    # 0x6c value (596) matched no known member's 0x60 at all, leaving
    # Target unresolved entirely -- Studio 5000's Import Routine then
    # rejected the exported L5X ("Required property 'Target' was missing").
    # fallback_target (the most-recent preceding hidden member in
    # declaration order) must be preferred when available, since it was
    # confirmed correct against a real Studio 5000 export in every case
    # found, including ones where the offset60_to_name lookups below would
    # return a wrong-but-non-None name instead.
    offset60_to_name = {640: "SomeOtherPlainField"}  # coincidental collision
    assert (
        _resolve_bit_target(596, 640, offset60_to_name, "ZZZZZZZZZZLugWrk9")
        == "ZZZZZZZZZZLugWrk9"
    )


def test_resolve_bit_target_falls_back_to_target_key_lookup():
    # When no hidden member precedes (fallback_target is None), a valid
    # 0x6c-based offset60_to_name lookup is used (the TIMER/COUNTER-style
    # built-in overlay case).
    offset60_to_name = {12: "Control"}
    assert _resolve_bit_target(12, 999, offset60_to_name, None) == "Control"


def test_resolve_bit_target_falls_back_to_own_offset_lookup():
    # When fallback_target is None AND the 0x6c lookup fails (0x6c is the
    # sentinel 0xFFFFFFFF), fall back to this member's own 0x60 as the
    # lookup key.
    offset60_to_name = {8: "Backing"}
    assert _resolve_bit_target(0xFFFFFFFF, 8, offset60_to_name, None) == "Backing"


def test_resolve_bit_target_returns_none_when_nothing_resolves():
    assert _resolve_bit_target(0xFFFFFFFF, 999, {}, None) is None


def test_member_to_xml_bit_member_includes_target_and_bit_number():
    member = Member(
        "ActvtnArea", "ActvtnArea", "BIT", 0, "Decimal", False,
        "ZZZZZZZZZZLugWrk9", 0, "Read/Write",
    )
    xml = member.to_xml()
    assert 'Target="ZZZZZZZZZZLugWrk9"' in xml
    assert 'BitNumber="0"' in xml


def test_member_to_xml_plain_bool_array_omits_bit_number():
    # Regression test for a real bug found alongside the fix above: a
    # BOOL[32] array member ("Ons" in the same real UDT) was emitting a
    # spurious BitNumber="0" not present in Studio 5000's own export --
    # bit_number is set for every BOOL member internally (a data-table
    # decode hint, see the Member.bit_number field docstring) but must only
    # be rendered as an XML attribute for a genuine BIT pseudo-member.
    member = Member("Ons", "Ons", "BOOL", 32, "Decimal", False, None, 0, "Read/Write")
    xml = member.to_xml()
    assert "BitNumber" not in xml
    assert "Target" not in xml


def test_decorated_real_literal_finite_uses_short_form():
    # Regression test for a real precision bug: a naive "%.6g" truncates
    # any value needing more than 6 significant digits to round-trip to
    # the same float32 bit pattern -- found via a real Studio 5000 "Tag
    # Name Collision / Data Compare" dialog showing several REAL members
    # (LugMn, Frequency, RPM, etc.) each differing from ours only in
    # digit count despite the underlying decoded bytes being correct. The
    # value below (a real float32 bit pattern) needs 7 significant digits
    # to round-trip -- "%.6g" silently produces "0.404762", which does NOT
    # round-trip to the same float32 bits (verified: struct.pack("<f",
    # 0.404762) != struct.pack("<f", 0.4047619)).
    assert _decorated_real_literal(0.4047619, in_array=False) == "0.4047619"


def _member(name, data_type, byte_offset=0, dimension=0):
    return Member(
        name, name, data_type, dimension, "Decimal", False, None, None,
        "Read/Write", _byte_offset=byte_offset,
    )


def test_decode_single_udt_element_bool_array_member_bit_packing():
    # Regression test for a real bug: a UDT member that's a BOOL array
    # (e.g. Encoder's "Ons", BOOL[32]) was decoded one raw byte per element
    # (elem_size=1 from _get_type_size("BOOL", ...)) instead of extracting
    # each element's bit from its shared, bit-packed 4-byte DWORD -- the
    # same class of bug already fixed for a top-level primitive BOOL-array
    # *tag* in _read_tag_initial_value, but never applied to this
    # UDT-member decode path. Found via a real Studio 5000 "Tag Name
    # Collision / Data Compare" dialog: EncTrm.Ons[5] decoded as 1 instead
    # of the real 0 -- only one of 32 elements differed, since the wrong
    # per-byte read coincidentally matches the true packed bit for most
    # positions.
    #
    # Build a blob with only bit 5 and bit 20 set in the packed DWORD.
    blob = bytearray(4)
    struct.pack_into("<I", blob, 0, (1 << 5) | (1 << 20))
    outer_dt = DataType(
        "Outer", "Outer", "NoFamily", "User",
        [_member("Ons", "BOOL", byte_offset=0, dimension=32)],
    )
    data_types_map = {"OUTER": outer_dt}

    result = _decode_single_udt_element(bytes(blob), 0, outer_dt, data_types_map, 0)

    expected = [0] * 32
    expected[5] = 1
    expected[20] = 1
    assert result["Ons"] == expected


def test_decode_single_udt_element_two_real_levels_of_struct_nesting():
    # Regression test for a real bug found via a real Studio 5000 import
    # rejection ("Data type mismatch"): the depth counter was incremented
    # TWICE per real struct-nesting level (once in _decode_single_udt_element
    # calling _decode_scalar_member(depth+1), again inside _decode_scalar_member
    # calling _decode_single_udt_element(depth+1)), silently halving the
    # usable nesting depth from the documented 3 levels to effectively 1. A
    # real UDT only 2 real levels deep (LugWrk -> Lug -> LugErrorCode) had
    # its innermost member ("ErrorCd") silently decode to {} well within the
    # intended limit -- which renders as a bare "[]" in the L5K literal,
    # a shape Studio 5000 rejects on import.
    c_dt = DataType("C", "C", "NoFamily", "User", [_member("d", "DINT")])
    b_dt = DataType("B", "B", "NoFamily", "User", [_member("c", "C")])
    a_dt = DataType("A", "A", "NoFamily", "User", [_member("b", "B")])
    data_types_map = {"A": a_dt, "B": b_dt, "C": c_dt}

    blob = struct.pack("<i", 42)
    result = _decode_single_udt_element(blob, 0, a_dt, data_types_map, 0)

    assert result == {"b": {"c": {"d": 42}}}


def test_decode_single_udt_element_still_truncates_beyond_max_depth():
    # The depth-limit safety net itself must still work after the fix above
    # -- 4 real levels of struct nesting beyond the top-level element must
    # still truncate the innermost level to {} (max_depth=3 means depths
    # 0/1/2/3 succeed, depth 4 is dropped).
    e_dt = DataType("E", "E", "NoFamily", "User", [_member("f", "DINT")])
    d_dt = DataType("D", "D", "NoFamily", "User", [_member("e", "E")])
    c_dt = DataType("C", "C", "NoFamily", "User", [_member("d", "D")])
    b_dt = DataType("B", "B", "NoFamily", "User", [_member("c", "C")])
    a_dt = DataType("A", "A", "NoFamily", "User", [_member("b", "B")])
    data_types_map = {"A": a_dt, "B": b_dt, "C": c_dt, "D": d_dt, "E": e_dt}

    blob = struct.pack("<i", 42)
    result = _decode_single_udt_element(blob, 0, a_dt, data_types_map, 0)

    assert result == {"b": {"c": {"d": {"e": {}}}}}


def test_get_type_size_does_not_add_dead_member_bytes():
    # _get_type_size() must NOT add dt._dead_member_bytes -- an earlier
    # version of this function did, on the untested assumption that it
    # would also apply to array-element striding the same way it applies
    # to a scalar struct member's trailing siblings. Verified wrong against
    # a real 200-element array of the exact UDT this was found on: the true
    # per-element stride matched the plain max(offset+size) computation
    # with NO dead-byte addition. _apply_dead_member_byte_corrections()
    # handles the scalar-sibling case separately and correctly.
    inner_dt = DataType(
        "Inner", "Inner", "NoFamily", "User",
        [_member("a", "DINT", byte_offset=0)],  # size: 4 bytes
        _dead_member_bytes=2,
    )
    data_types_map = {"INNER": inner_dt}
    assert _get_type_size("INNER", data_types_map) == 4


def test_apply_dead_member_byte_corrections_is_a_noop():
    # Regression test for a real, disproven theory: a scalar struct-typed
    # member ("b", typed "Inner") whose nested DataType has dead/deleted
    # bytes used to shift every member declared AFTER it in the outer
    # struct, on the theory that a deleted member's old byte range keeps
    # occupying space in an already-allocated tag's data table. A real
    # Studio 5000 screenshot of a populated tag with exactly this shape
    # (Trim_Decision: LugWrk.BfrLug -> Lug, which has a deleted member)
    # proved this wrong -- the real values only decode correctly using
    # each member's own *raw*, uncorrected stored byte_offset (the +2 the
    # tag's real data needed came entirely from _tag_value_blob_offset()'s
    # own, per-tag structural offset, not from any member-level shift).
    # This function is now a no-op; member offsets must be left exactly as
    # DataTypeBuilder stored them, dead bytes or not.
    inner_dt = DataType(
        "Inner", "Inner", "NoFamily", "User",
        [_member("a", "DINT", byte_offset=0)],
        _dead_member_bytes=2,
    )
    outer_dt = DataType(
        "Outer", "Outer", "NoFamily", "User",
        [
            _member("b", "Inner", byte_offset=0),
            _member("c", "INT", byte_offset=4),
            _member("d", "INT", byte_offset=6),
        ],
    )
    data_types_map = {"INNER": inner_dt, "OUTER": outer_dt}

    _apply_dead_member_byte_corrections(data_types_map)

    b, c, d = outer_dt.members
    assert b._byte_offset == 0
    assert c._byte_offset == 4  # unchanged -- no correction applied
    assert d._byte_offset == 6  # unchanged -- no correction applied


def test_apply_dead_member_byte_corrections_noop_when_no_dead_bytes():
    inner_dt = DataType(
        "Inner", "Inner", "NoFamily", "User", [_member("a", "DINT", byte_offset=0)],
    )
    outer_dt = DataType(
        "Outer", "Outer", "NoFamily", "User",
        [_member("b", "Inner", byte_offset=0), _member("c", "INT", byte_offset=4)],
    )
    data_types_map = {"INNER": inner_dt, "OUTER": outer_dt}

    _apply_dead_member_byte_corrections(data_types_map)

    b, c = outer_dt.members
    assert b._byte_offset == 0
    assert c._byte_offset == 4


def test_decode_string_family_value_uses_latin1_never_replacement_char():
    # Regression test for a real bug: decoding raw STRING bytes as utf-8
    # (with errors="replace") inserted U+FFFD for any byte sequence that
    # wasn't valid UTF-8 -- found via a real array tag whose STRING member
    # held uninitialized/garbage data. latin-1 is a 1:1 byte<->codepoint
    # mapping that can never fail, so U+FFFD must never appear.
    blob = struct.pack("<i", 4) + bytes([0xC7, 0x65, 0x02, 0x01]) + b"\x00" * 82
    result = _decode_string_family_value(blob, 0, "STRING", {})
    assert result["LEN"] == 4
    assert "�" not in result["DATA"]
    assert result["DATA"] == "\xc7\x65\x02\x01"


def test_l5k_string_padded_escapes_non_ascii_bytes():
    # Regression test for a real Studio 5000 import rejection ("Only ASCII
    # characters are supported") on a tag's <Data Format="L5K"> element:
    # a non-ASCII character (originating from a byte that isn't valid
    # UTF-8, previously mis-decoded as U+FFFD -- see the decode test above)
    # must be $XX-hex-escaped the same way control characters already are,
    # not embedded raw.
    result = _l5k_string_padded("\xc7\x65", capacity=4)
    assert result == "'$C7e$00$00'"
    assert all(ord(c) <= 0x7E for c in result)


def test_l5k_string_padded_still_escapes_control_chars():
    result = _l5k_string_padded("\x00\x1b", capacity=2)
    assert result == "'$00$1B'"


def _build_st_line_record(seq: int, text: str) -> bytes:
    """Build a synthetic Nameless.Dat ST source-line record: a 24-byte
    header (record_type u32 at offset 4, seq u32 at offset 20) followed by
    the line text in fffeff-encoded UTF-16 (short form, text under 255
    UTF-16 code units)."""
    header = bytearray(24)
    struct.pack_into("<I", header, 4, 0x01000002)
    struct.pack_into("<I", header, 20, seq)
    text_bytes = text.encode("utf-16-le")
    return bytes(header) + bytes([0xFF, 0xFE, 0xFF, len(text)]) + text_bytes


def test_st_routine_lines_resolves_nested_hexid_placeholders():
    # Regression test for a real, previously-separate fix (merged in from
    # branch fix/st-hexid-resolution): a resolved comp name can itself still
    # be an unresolved &hexid: placeholder -- a composite/derived
    # module-address reference stored that way in the comps table -- which
    # a single-pass resolve would leave untouched. Neither local fixture nor
    # the one real project this was verified against happens to exercise
    # this specific nesting, so it needs its own synthetic coverage.
    #
    # id_a's own comps entry is itself an unresolved @id_b@ placeholder
    # (not yet a real name); id_b resolves to the real module name. A
    # correct fixed-point resolve turns "&<id_a>:5:I.Ch2Data;" into
    # "N2:5:I.Ch2Data;" over two passes.
    id_a = 0xAAAA0001
    id_b = 0xBBBB0002
    routine_oid = 1000

    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE nameless (object_id INTEGER, parent_id INTEGER, record BLOB)")
    db.execute("CREATE TABLE comps (object_id INTEGER, comp_name TEXT)")
    db.execute(
        "INSERT INTO nameless VALUES (?, ?, ?)",
        (2000, routine_oid, _build_st_line_record(0, f"X := &{id_a:08x}:5:I.Ch2Data;")),
    )
    db.execute("INSERT INTO comps VALUES (?, ?)", (id_a, f"@{id_b:08x}@"))
    db.execute("INSERT INTO comps VALUES (?, ?)", (id_b, "N2"))
    cur = db.cursor()

    lines = _st_routine_lines(cur, routine_oid)

    assert lines == [(0, "X := N2:5:I.Ch2Data;")]


def _fld(name, data_type):
    return SimpleNamespace(name=name, data_type=data_type)


def test_fbd_bool_field_by_index_counts_only_bool_fields():
    # Regression test for the UNIT_STATUS FBD bit-resolution gap: real
    # Studio 5000 ground truth for a real project (RefProjA_V33_R17_4.ACD)
    # showed a compiled FBD feed's bit index N corresponds to the Nth
    # (0-based) BOOL-typed field in declaration order, NOT the field's own
    # position among ALL fields -- verified against a real AOI (AOI_VALVE)
    # with 38 parameters, only some of which are BOOL, where every one of 5
    # real bit-index/name pairs (11->Opening, 17->Closing, 19->OpenLS,
    # 20->CloseLS, 27->Mismatch) only lines up when non-BOOL fields
    # (DINT/INT/FBD_TIMER) are excluded from the count first.
    fields = [
        _fld("EnableIn", "BOOL"),  # 0
        _fld("STATE", "DINT"),  # not counted
        _fld("Opening", "BOOL"),  # 1
        _fld("TOC", "DINT"),  # not counted
        _fld("Closing", "BOOL"),  # 2
        _fld("Timer", "FBD_TIMER"),  # not counted
        _fld("OpenLS", "BOOL"),  # 3
    ]
    assert _fbd_bool_field_by_index(fields, 0) == "EnableIn"
    assert _fbd_bool_field_by_index(fields, 1) == "Opening"
    assert _fbd_bool_field_by_index(fields, 2) == "Closing"
    assert _fbd_bool_field_by_index(fields, 3) == "OpenLS"
    assert _fbd_bool_field_by_index(fields, 4) is None  # out of range


def test_fbd_make_bit_resolver_resolves_aoi_instance_tag():
    # End-to-end (resolver + _fbd_resolve_source) regression for the general
    # mechanism: any AOI-instance-typed tag's compiled bit-packed feed
    # resolves through the tag's own DataType (an AOI name here) to that
    # AOI's own Nth BOOL parameter -- not hardcoded to any one tag/AOI name.
    aoi = SimpleNamespace(
        parameters=[
            _fld("EnableIn", "BOOL"),
            _fld("STATE", "DINT"),
            _fld("OpenLS", "BOOL"),
            _fld("CloseLS", "BOOL"),
        ]
    )
    resolver = _fbd_make_bit_resolver({"TANK16_SUP": "AOI_VALVE"}, {"AOI_VALVE": aoi}, {})
    assert resolver("TANK16_SUP.__BitHost00", 2) == "TANK16_SUP.CloseLS"
    assert resolver("TANK16_SUP.__BitHost00", 0) == "TANK16_SUP.EnableIn"
    # Unknown tag / no matching AOI or DataType -> caller falls back to the
    # raw bit-index form rather than guessing.
    assert resolver("UNKNOWN_TAG.__BitHost00", 0) is None


def test_fbd_resolve_source_uses_bit_resolver_when_available():
    iref_feeds = {"__lHEX": "TANK16_SUP.__BitHost00"}
    aoi = SimpleNamespace(parameters=[_fld("OpenLS", "BOOL"), _fld("CloseLS", "BOOL")])
    resolver = _fbd_make_bit_resolver({"TANK16_SUP": "AOI_VALVE"}, {"AOI_VALVE": aoi}, {})
    assert _fbd_resolve_source("__lHEX.1", iref_feeds, resolver) == "TANK16_SUP.CloseLS"
    # No resolver (or resolution fails) -> falls back to the raw, still-
    # traceable bit-index form rather than raising or guessing.
    assert _fbd_resolve_source("__lHEX.1", iref_feeds, None) == "TANK16_SUP.__BitHost00.1"
    assert _fbd_resolve_source("__lHEX.99", iref_feeds, resolver) == "TANK16_SUP.__BitHost00.99"


def _fffeff_bytes(s):
    return bytes([0xFF, 0xFE, 0xFF, len(s)]) + s.encode("utf-16-le")


def _build_fbd_meta_record(rtype, parent_id, self_oid, flag, seq, extra=b""):
    rec = bytearray(24) + bytearray(extra)
    struct.pack_into("<I", rec, 0, len(rec) - 4)
    struct.pack_into("<I", rec, 4, rtype)
    struct.pack_into("<I", rec, 8, parent_id)
    struct.pack_into("<I", rec, 12, self_oid)
    struct.pack_into("<I", rec, 16, flag)
    struct.pack_into("<I", rec, 20, seq)
    return bytes(rec)


def test_fbd_decode_sheets_two_sheets_with_cross_sheet_connector_and_feedback():
    # Regression test for the multi-sheet FBD layout mechanism (verified
    # against a real 2-sheet project, FBDLevelControlSimulation.ACD): sheet
    # membership and named OCon/ICon connector pairing live in a nameless
    # tree wholly separate from the compiled ladder-equivalent network,
    # hanging off shadow_oid's own nameless parent_id. Neither local
    # fixture nor the main RefProjA project (0 multi-sheet routines) exercises
    # this, so it needs its own synthetic coverage.
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE nameless (object_id INTEGER, parent_id INTEGER, record BLOB)")
    rows = []

    SHADOW_OID, SHADOW_PARENT = 9000, 100
    rows.append((SHADOW_OID, SHADOW_PARENT, b"\x00" * 8))

    # Sheet 1: "Sheet1Desc" -- elements {TagA, TagC, connector->Conn1},
    # wires {TagA -> Conn1 (plain), TagA -> TagC (feedback)}. The feedback
    # wire deliberately does NOT touch the connector, since a connector
    # element never resolves to a real operand name (oid_to_operand only
    # covers tagref elements) -- feedback_pairs is only ever keyed by two
    # real operand names.
    rows.append((200, SHADOW_PARENT, _build_fbd_meta_record(0x01000002, SHADOW_PARENT, 200, 0x10003, 0, _fffeff_bytes("Sheet1Desc"))))
    rows.append((210, 200, _build_fbd_meta_record(0x01000000, 200, 210, 0, 0)))  # elements container
    rows.append((211, 210, _build_fbd_meta_record(0x01000002, 210, 211, 0x20002, 1, _fffeff_bytes("TagA"))))
    conn_rec = bytearray(_build_fbd_meta_record(0x01000000, 210, 212, 0x10010, 2, b"\x00" * 12))
    struct.pack_into("<I", conn_rec, 32, 213)  # points at the shared name node
    rows.append((212, 210, bytes(conn_rec)))
    rows.append((214, 210, _build_fbd_meta_record(0x01000002, 210, 214, 0x20002, 4, _fffeff_bytes("TagC"))))
    rows.append((220, 200, _build_fbd_meta_record(0x01000000, 200, 220, 0, 0)))  # wires container
    wire_rec = bytearray(_build_fbd_meta_record(0x01000000, 220, 221, 0x70011, 3, b"\x00" * 20))  # plain Wire
    struct.pack_into("<I", wire_rec, 24, 211)  # from TagA
    struct.pack_into("<I", wire_rec, 32, 212)  # to the OCon
    rows.append((221, 220, bytes(wire_rec)))
    wire_rec3 = bytearray(_build_fbd_meta_record(0x01000000, 220, 222, 0x70012, 5, b"\x00" * 20))  # 0x12 = FeedbackWire
    struct.pack_into("<I", wire_rec3, 24, 211)  # from TagA
    struct.pack_into("<I", wire_rec3, 32, 214)  # to TagC
    rows.append((222, 220, bytes(wire_rec3)))

    # Sheet 2: "Sheet2Desc" -- elements {TagB, connector->Conn1}, wires {Conn1 -> TagB}
    rows.append((300, SHADOW_PARENT, _build_fbd_meta_record(0x01000002, SHADOW_PARENT, 300, 0x10003, 10, _fffeff_bytes("Sheet2Desc"))))
    rows.append((310, 300, _build_fbd_meta_record(0x01000000, 300, 310, 0, 0)))
    rows.append((311, 310, _build_fbd_meta_record(0x01000002, 310, 311, 0x20002, 1, _fffeff_bytes("TagB"))))
    conn_rec2 = bytearray(_build_fbd_meta_record(0x01000000, 310, 312, 0x10010, 2, b"\x00" * 12))
    struct.pack_into("<I", conn_rec2, 32, 213)  # same shared name node as sheet 1's connector
    rows.append((312, 310, bytes(conn_rec2)))
    rows.append((320, 300, _build_fbd_meta_record(0x01000000, 300, 320, 0, 0)))
    wire_rec2 = bytearray(_build_fbd_meta_record(0x01000000, 320, 321, 0x70011, 3, b"\x00" * 20))  # plain Wire
    struct.pack_into("<I", wire_rec2, 24, 312)  # from the ICon
    struct.pack_into("<I", wire_rec2, 32, 311)  # to TagB
    rows.append((321, 320, bytes(wire_rec2)))

    # The connector's own shared name node ("Conn1"), reachable via a
    # separate branch (record_type 0x01000000, so it's never mistaken for
    # a sheet-description candidate itself) -- not nested under either
    # sheet's own elements container, matching how real data keeps it
    # under a wholly different part of the tree.
    rows.append((400, SHADOW_PARENT, _build_fbd_meta_record(0x01000000, SHADOW_PARENT, 400, 0, 0)))
    rows.append((213, 400, _build_fbd_meta_record(0x01000002, 400, 213, 0, 0, _fffeff_bytes("Conn1"))))

    db.executemany("INSERT INTO nameless VALUES (?, ?, ?)", rows)
    cur = db.cursor()

    result = _fbd_decode_sheets(cur, SHADOW_OID)
    assert result is not None
    sheets, operand_to_sheet, connector_feed, feedback_pairs = result

    assert sheets == [
        {"number": 1, "description": "Sheet1Desc"},
        {"number": 2, "description": "Sheet2Desc"},
    ]
    assert operand_to_sheet == {"TagA": 1, "TagC": 1, "TagB": 2}
    assert connector_feed == {
        "Conn1": {
            "feeder_operand": "TagA",
            "feeder_sheet": 1,
            "consumer_operand": "TagB",
            "consumer_sheet": 2,
        }
    }
    assert feedback_pairs == {("TagA", "TagC")}


def test_render_fbd_content_multi_sheet_splits_cross_sheet_wire_via_oconicon():
    # Regression test for _render_fbd_content's sheet_layout-aware
    # rendering: a wire whose source and destination operands live on
    # different sheets must render as an OCon (on the source's sheet) and
    # an ICon (on the destination's sheet) sharing one Name, each
    # producing its own same-sheet <Wire>, rather than one direct
    # cross-sheet wire -- verified against real ground truth (a real
    # cross-sheet link compiles to one flat wire with zero trace of the
    # sheet boundary at all, so this decision comes entirely from
    # sheet_layout, not from the block/wire graph itself).
    blocks = {
        "BLK1": {"type": "FOO", "wires_in": {}, "extra_args": []},
        "BLK2": {"type": "BAR", "wires_in": {"BLK2.In": "BLK1.Out"}, "extra_args": []},
    }
    sheet_layout = (
        [{"number": 1, "description": "Sheet1"}, {"number": 2, "description": "Sheet2"}],
        {"BLK1": 1, "BLK2": 2},
        {"XLINK": {"feeder_operand": "BLK1", "feeder_sheet": 1, "consumer_operand": "BLK2", "consumer_sheet": 2}},
        set(),
    )

    xml = _render_fbd_content(blocks, {}, [], sheet_layout=sheet_layout)

    assert xml.count('<Sheet Number="1">') == 1
    assert xml.count('<Sheet Number="2">') == 1
    assert '<OCon' in xml and 'Name="XLINK"' in xml
    assert '<ICon' in xml and xml.count('Name="XLINK"') == 2
    # No direct BLK1->BLK2 wire; instead BLK1.Out feeds the OCon on sheet 1
    # and the ICon feeds BLK2.In on sheet 2.
    sheet1_xml = xml.split('<Sheet Number="1">')[1].split("</Sheet>")[0]
    sheet2_xml = xml.split('<Sheet Number="2">')[1].split("</Sheet>")[0]
    assert 'FromParam="Out"' in sheet1_xml and "ToParam=" not in sheet1_xml.split("<Wire")[1]
    assert 'ToParam="In"' in sheet2_xml and "FromParam=" not in sheet2_xml.split("<Wire")[1]


def test_render_fbd_content_uses_default_visible_pins_for_known_block_types():
    # Regression test for a real bug found via an actual PLC-Studio load:
    # VisiblePins is a fixed per-instruction-TYPE default in real Studio
    # 5000 (confirmed identical across every real instance of a type,
    # project-wide, in two independent ground-truth projects), NOT the set
    # of pins this decode happens to observe wired -- the wired-only
    # approach silently truncated VisiblePins to just the pins with an
    # incoming wire, so a block's own OUTPUT pin (e.g. DEDT's "Out", never
    # a wire *destination*) was dropped entirely. A real <Wire
    # FromParam="Out"> then referenced a pin absent from that block's own
    # VisiblePins list -- a self-inconsistency severe enough that
    # PLC-Studio's actual FBD renderer fell back to its generic "not yet
    # supported" placeholder for the whole routine rather than rendering
    # something merely incomplete. Neither local fixture nor the original
    # RefProjA verification ever compared VisiblePins content (only block/wire
    # *sets*), which is how this went undetected through "27/28"/"28/28
    # exact" claims.
    blocks = {
        "DEDT_01": {"type": "DEDT", "wires_in": {"DEDT_01.In": "SomeTag"}, "extra_args": ["DEDT_01array"]},
        "UNKNOWN_01": {"type": "NEWTYPE", "wires_in": {"UNKNOWN_01.Foo": "SomeTag"}, "extra_args": []},
    }
    xml = _render_fbd_content(blocks, {}, [])

    dedt_xml = xml[xml.index('<Block Type="DEDT"') : xml.index("</Block>") + len("</Block>")]
    assert 'VisiblePins="In Out"' in dedt_xml
    # DEDT's own extra positional arg renders as a real <Array
    # Name="StorageArray"> child (verified: DEDT(DEDT_01,DEDT_01array)
    # compiles this from its second argument) -- scoped narrowly to DEDT,
    # since a different built-in type's own extra arg (PIDE's own trailing
    # literal "0") does NOT render as anything in real Studio output at
    # all; treating every extra_args entry as an Array child generically
    # was tried and found wrong.
    assert '<Array Name="StorageArray" Operand="DEDT_01array"/>' in dedt_xml

    # A block type with no ground-truth-backed default falls back to the
    # (still real, just possibly incomplete) set of pins actually observed
    # wired -- not a guess, and not silently empty.
    unknown_xml = xml[xml.index('<Block Type="NEWTYPE"') :]
    assert 'VisiblePins="Foo"' in unknown_xml
    assert "<Array" not in unknown_xml
