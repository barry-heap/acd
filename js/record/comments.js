// Port of acd/record/comments.py's CommentsRecord.parse().
//
// Turns one Dat.Record (identifier 0xFAFA) into the 10-field tuple stored in
// the `comments` SQL table: [seq_number, sub_record_length, object_id,
// record_string, record_type, parent, tag_reference, rung_content,
// member_ref, scope_id], or null if the record isn't a recognized shape.
//
// This is deliberately a direct byte-offset port (bypassing the Kaitai-
// generated FafaComents dispatch, which only covers a subset of the real
// record_type values) -- see CLAUDE.md's "Comment / description resolution"
// section in the Python repo for the full reverse-engineered layout this
// mirrors. Every offset below was cross-checked against
// acd/generated/comments/fafa_coments.py and acd/record/comments.py.

const { KaitaiStream } = require("kaitai-struct");

function asciiDecode(bytes) {
  // Mirrors Python's bytes.decode("ascii", errors="replace").
  let out = "";
  for (const b of bytes) out += b > 0x7f ? "�" : String.fromCharCode(b);
  return out;
}

function utf8Decode(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// Mirrors Kaitai's generated `.decode(u"UTF-8")` (no errors= param, i.e.
// strict -- raises on invalid bytes) for AsciiRecord/Utf16Record/
// ControllerRecord's own record_string field (acd/generated/comments/
// fafa_coments.py) -- despite the "Ascii" name, the real generated parser
// decodes these as UTF-8, confirmed via a real project's tag description
// containing an en-dash (U+2013), which Python renders correctly but the
// previous ascii-with-replace JS decode mangled into replacement
// characters. Throws on invalid UTF-8 so the caller's outer try/catch can
// return null the same way Python's strict decode raising would.
function utf8DecodeStrict(bytes) {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function readCodeUnitsUntilZero(dv, start) {
  // Returns { codeUnits, bytesConsumed } where bytesConsumed includes the
  // terminating zero code unit (2 bytes), mirroring StrzUtf16's code_units.
  const codeUnits = [];
  let pos = start;
  while (pos + 1 < dv.byteLength) {
    const cu = dv.getUint16(pos, true);
    pos += 2;
    if (cu === 0) break;
    codeUnits.push(cu);
  }
  return { codeUnits, bytesConsumed: pos - start };
}

function indexOfZero(bytes, start) {
  for (let i = start; i < bytes.length; i++) if (bytes[i] === 0) return i;
  return -1;
}

function parseUdiBody(body) {
  // Type-12 (UDI) record body: [0:8] unknown, [8:12] some_id, [12:16] flags,
  // [16:] UTF-16LE null-terminated UDI-type string, null padding, then a
  // null-terminated ASCII text string.
  if (body.length < 20) return null;
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const { codeUnits, bytesConsumed } = readCodeUnitsUntilZero(dv, 16);
  const udiType = String.fromCharCode(...codeUnits);
  let pos = 16 + bytesConsumed;
  while (pos < body.length && body[pos] === 0) pos++;
  const textEnd = indexOfZero(body, pos);
  if (textEnd <= pos) return null;
  const text = utf8Decode(body.subarray(pos, textEnd));
  return { udiType, text };
}

function parseCommentsRecord(datRecord) {
  if (datRecord.identifier !== 0xfafa) return null;
  try {
    const rawFull = datRecord.record.recordBuffer;
    const dvFull = new DataView(rawFull.buffer, rawFull.byteOffset, rawFull.byteLength);
    const scopeId = rawFull.length >= 18 ? dvFull.getUint16(16, true) : 0;

    const recordLength = dvFull.getUint32(0, true);
    const seqNumber = dvFull.getUint16(4, true);
    const recordType = dvFull.getUint16(6, true);
    const subRecordLength = dvFull.getUint16(8, true);
    const parent = dvFull.getUint32(10, true);
    const body = rawFull.subarray(14, 14 + (recordLength - 10));
    const dvBody = new DataView(body.buffer, body.byteOffset, body.byteLength);

    if (recordType === 12) {
      const parsed = parseUdiBody(body);
      if (parsed === null || parsed.udiType !== "UDI_HISTORY") return null;
      return [
        seqNumber,
        subRecordLength,
        1,
        parsed.text,
        recordType,
        parent,
        "__REVISION_NOTE__",
        0,
        0,
        scopeId,
      ];
    }

    if (recordType === 16 || recordType === 17) {
      const objId = dvBody.getUint32(6, true);
      const rest = body.subarray(16);
      let tagRefEnd = -1;
      for (let i = 0; i + 1 < rest.length; i += 2) {
        if (rest[i] === 0 && rest[i + 1] === 0) {
          tagRefEnd = i;
          break;
        }
      }
      let tagRef = "";
      let recordString = "";
      if (tagRefEnd > 0) {
        tagRef = KaitaiStream.bytesToStr(rest.subarray(0, tagRefEnd), "UTF-16LE");
        let descStart = tagRefEnd + 2;
        while (descStart < rest.length && rest[descStart] === 0) descStart++;
        const descEnd = indexOfZero(rest, descStart);
        recordString = descEnd > descStart ? asciiDecode(rest.subarray(descStart, descEnd)) : "";
      }
      return [seqNumber, subRecordLength, objId, recordString, recordType, parent, tagRef, 0, 0, scopeId];
    }

    const RAW_TEXT_TYPES = new Set([5, 6, 7, 8, 11, 15, 19, 21, 24, 29, 30, 37, 39]);
    if (RAW_TEXT_TYPES.has(recordType)) {
      const objId = dvBody.getUint32(8, true);
      let tagRef = "";
      let recordString = "";
      const { codeUnits, bytesConsumed } = readCodeUnitsUntilZero(dvBody, 16);
      if (codeUnits.length > 0) {
        tagRef = String.fromCharCode(...codeUnits);
        let pos = 16 + bytesConsumed;
        while (pos < body.length && body[pos] === 0) pos++;
        const textEnd = indexOfZero(body, pos);
        if (textEnd > pos) recordString = asciiDecode(body.subarray(pos, textEnd));
      }
      return [seqNumber, subRecordLength, objId, recordString, recordType, parent, tagRef, 0, 0, scopeId];
    }

    // Generic fallthrough: mirrors FafaComents' Kaitai dispatch on
    // header.record_type -> AsciiRecord (1,2) / Utf16Record (3,4,13,14) /
    // ControllerRecord (23,25). Any other record_type there yields raw bytes
    // with no .object_id, which Python's own code lets raise -> caught by the
    // outer except -> None. We replicate that by returning null directly.
    let objectId;
    let recordString;
    let tagRef;
    let rungContent = 0;
    let memberRef = 0;

    if (recordType === 3 || recordType === 4 || recordType === 13 || recordType === 14) {
      // Utf16Record(len_unknown_3=12): unknown_1(8) + object_id(u4) +
      // unknown_2(4) + len_record(u2) + tag_reference(StrzUtf16) + unknown_3(12)
      // + record_string(null-terminated ascii).
      objectId = dvBody.getUint32(8, true);
      const tagRefStart = 18;
      const { codeUnits, bytesConsumed } = readCodeUnitsUntilZero(dvBody, tagRefStart);
      tagRef = String.fromCharCode(...codeUnits);
      const stringsStart = tagRefStart + bytesConsumed + 12;
      const textEnd = indexOfZero(body, stringsStart);
      recordString = textEnd > stringsStart ? utf8DecodeStrict(body.subarray(stringsStart, textEnd)) : "";
    } else if (recordType === 1 || recordType === 2) {
      // AsciiRecord: unknown_1(13) + object_id(u4) + unknown_2(13) + record_string.
      objectId = dvBody.getUint32(13, true);
      tagRef = "";
      const textEnd = indexOfZero(body, 30);
      recordString = textEnd > 30 ? utf8DecodeStrict(body.subarray(30, textEnd)) : "";
      if (body.length >= 8) rungContent = dvBody.getUint32(4, true);
      if (body.length >= 4) memberRef = dvBody.getUint32(0, true);
    } else if (recordType === 23 || recordType === 25) {
      // ControllerRecord: unknown_1(8) + object_id(u4) + unknown_2(4) +
      // tag_reference(StrzUtf16) + unknown_3(12) + record_string.
      objectId = dvBody.getUint32(8, true);
      tagRef = "";
      const tagRefStart = 16;
      const { bytesConsumed } = readCodeUnitsUntilZero(dvBody, tagRefStart);
      const stringsStart = tagRefStart + bytesConsumed + 12;
      const textEnd = indexOfZero(body, stringsStart);
      recordString = textEnd > stringsStart ? utf8DecodeStrict(body.subarray(stringsStart, textEnd)) : "";
    } else {
      return null;
    }

    return [seqNumber, subRecordLength, objectId, recordString, recordType, parent, tagRef, rungContent, memberRef, scopeId];
  } catch (e) {
    return null;
  }
}

module.exports = { parseCommentsRecord };
