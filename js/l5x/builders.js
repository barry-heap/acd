// Port of acd/l5x/elements.py's *Builder classes (Python lines ~2431 on).
// Each Builder here is a plain function taking (db, objectId, ...) instead
// of a dataclass instance, since JS has no cursor-attached-to-self
// convention to mirror -- db is a sql.js Database throughout.

const { KaitaiStream } = require("kaitai-struct");
const { RxGeneric } = require("../generated/RxGeneric");
const { queryAll, queryOne } = require("./sqlutil");
const { Member, DataType } = require("./render");

function radixEnum(i) {
  switch (i) {
    case 0:
      return "NullType";
    case 1:
      return "General";
    case 2:
      return "Binary";
    case 3:
      return "Octal";
    case 4:
      return "Decimal";
    case 5:
      return "Hex";
    case 6:
      return "Exponential";
    case 7:
      return "Float";
    case 8:
      return "ASCII";
    case 9:
      return "Unicode";
    case 10:
      return "Date/Time";
    case 11:
      return "Date/Time (ns)";
    case 12:
      return "UseTypeStyle";
    default:
      return "General";
  }
}

function externalAccessEnum(i) {
  const dflt = "Read/Write";
  if (i === 0) return dflt;
  if (i === 2) return "Read Only";
  if (i === 3) return "None";
  return dflt;
}

function resolveBitTarget(targetKey, val60, offset60ToName, fallbackTarget) {
  if (fallbackTarget !== null && fallbackTarget !== undefined) return fallbackTarget;
  if (targetKey !== 0xffffffff) {
    const name = offset60ToName.get(targetKey);
    if (name !== undefined) return name;
  }
  const name = offset60ToName.get(val60);
  return name !== undefined ? name : null;
}

function dv(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function decodeMemberName(rec) {
  let s = KaitaiStream.bytesToStr(rec, "UTF-16LE");
  const nullIdx = s.indexOf("\0");
  if (nullIdx >= 0) s = s.slice(0, nullIdx);
  return s.trim();
}

// record: the DataType's own extended_record bytes describing this member
// (NOT the member's own comps row -- that's fetched separately below, for
// description resolution only). See acd/l5x/elements.py's MemberBuilder for
// the two-different-"record"-sources explanation this mirrors.
function buildMember(db, objectId, record, offset60ToName, fallbackTarget) {
  const row = queryOne(db, "SELECT comp_name, object_id, parent_id, record FROM comps WHERE object_id=?", [objectId]);
  const name = row[0];
  const rawComps = row[3];
  // Mirrors Python's (effectively unguarded) RxGeneric.from_bytes call --
  // if this throws, it propagates to the caller (DataTypeBuilder's own
  // per-member try/catch), matching the real behavior of the Python source
  // (whose try/except around a *second*, redundant call is dead code, since
  // an unguarded identical call precedes it).
  const r = new RxGeneric(new KaitaiStream(rawComps));

  const d = dv(record);
  let dimension = d.getUint32(0x5c, true);
  let radix = radixEnum(d.getUint32(0x54, true));
  const dataTypeId = d.getUint32(0x58, true);
  const hidden = Boolean(d.getUint32(0x70, true));
  const externalAccess = externalAccessEnum(d.getUint32(0x74, true));

  const dtRow = queryOne(db, "SELECT comp_name FROM comps WHERE object_id=?", [dataTypeId]);
  let dataType = dtRow[0];

  let target = null;
  let bitNumber = null;
  if (dataType === "BOOL") {
    const targetKey = d.getUint32(0x6c, true);
    const val68 = d.getUint32(0x68, true);
    if (targetKey === 0xffffffff && val68 === 0x800) {
      bitNumber = d.getUint32(0x64, true);
    } else {
      dataType = "BIT";
      dimension = 0;
      bitNumber = d.getUint32(0x64, true);
      const val60 = d.getUint32(0x60, true);
      target = resolveBitTarget(targetKey, val60, offset60ToName, fallbackTarget);
    }
  }

  let description = null;
  if (rawComps.length >= 18) {
    const memberRef = dv(rawComps).getUint32(14, true);
    if (memberRef) {
      const descRow = queryOne(
        db,
        "SELECT record_string FROM comments WHERE parent=? AND member_ref=? LIMIT 1",
        [r.commentId * 0x10000 + r.cipType, memberRef],
      );
      if (descRow && descRow[0]) description = descRow[0];
    }
  }

  const byteOffset = d.getUint32(0x60, true);
  return new Member(name, dataType, dimension, radix, hidden, target, bitNumber, externalAccess, {
    byteOffset,
    description,
  });
}

function buildDataType(db, objectId) {
  const row = queryOne(db, "SELECT comp_name, object_id, parent_id, record FROM comps WHERE object_id=?", [objectId]);
  const name = row[0];

  let r;
  try {
    r = new RxGeneric(new KaitaiStream(row[3]));
  } catch (e) {
    return new DataType(name, "NoFamily", "User", []);
  }

  const extendedRecords = new Map();
  for (const er of r.extendedRecords) extendedRecords.set(er.attributeId, er.value);

  const stringFamilyInt = dv(extendedRecords.get(0x6c)).getUint32(0, true);
  const stringFamily = stringFamilyInt === 1 ? "StringFamily" : "NoFamily";

  const builtIn = dv(extendedRecords.get(0x67)).getUint32(0, true);
  const moduleDefined = dv(extendedRecords.get(0x69)).getUint32(0, true);

  let classType = "User";
  if (moduleDefined > 0) classType = "IO";
  if (builtIn & 0x03) classType = "ProductDefined";

  const memberResults = queryAll(db, "SELECT comp_name, object_id, parent_id, record FROM comps WHERE parent_id=?", [objectId]);
  const children = [];
  let deadMemberBytes = 0;

  if (memberResults.length === 1) {
    const memberCollectionId = memberResults[0][1];

    const childrenResults = queryAll(
      db,
      "SELECT comp_name, object_id, parent_id, seq_number, record FROM comps WHERE parent_id=? ORDER BY seq_number",
      [memberCollectionId],
    );

    const nameToChild = new Map();
    for (const child of childrenResults) nameToChild.set(child[0], child);

    const memberKeys = [...extendedRecords.keys()].filter((k) => k >= 0x6e).sort((a, b) => a - b);

    const offset60ToName = new Map();
    for (const key of memberKeys) {
      const rec = extendedRecords.get(key);
      const memberName = decodeMemberName(rec);
      const child = nameToChild.get(memberName);
      if (child === undefined) continue;
      if (rec.length >= 0x70) {
        const d = dv(rec);
        const targetKey2 = d.getUint32(0x6c, true);
        const val682 = d.getUint32(0x68, true);
        if (targetKey2 === 0xffffffff && val682 === 0x800) {
          offset60ToName.set(d.getUint32(0x60, true), child[0]);
        }
      }
    }

    let lastHiddenBacking = null;
    for (const key of memberKeys) {
      const rec = extendedRecords.get(key);
      const memberName = decodeMemberName(rec);
      const child = nameToChild.get(memberName);
      if (child === undefined) continue;
      if (rec.length >= 0x74) {
        const isHidden = Boolean(dv(rec).getUint32(0x70, true));
        if (isHidden) lastHiddenBacking = child[0];
      }
      try {
        children.push(buildMember(db, child[1], rec, offset60ToName, lastHiddenBacking));
        nameToChild.delete(memberName);
      } catch (e) {
        // Matches Python's bare except: pass in this loop.
      }
    }

    if (nameToChild.size > 0) {
      console.warn(
        `DataType ${JSON.stringify(name)}: ${nameToChild.size} deleted member(s) with no type descriptor found (${JSON.stringify(
          [...nameToChild.keys()].sort(),
        )}) -- diagnostic only, no byte-offset correction is applied for this.`,
      );
    }
    deadMemberBytes = nameToChild.size * 2;
  }

  let description = null;
  const descRow = queryOne(db, "SELECT record_string FROM comments WHERE parent=? AND member_ref=0 LIMIT 1", [
    r.commentId * 0x10000 + r.cipType,
  ]);
  if (descRow && descRow[0]) description = descRow[0];

  return new DataType(name, stringFamily, classType, children, { description, deadMemberBytes });
}

// No-op, kept only for parity with Python's _apply_dead_member_byte_corrections
// (which is also a documented no-op -- see acd/l5x/elements.py for why the
// theory it originally implemented was disproven).
function applyDeadMemberByteCorrections(allDataTypesMap) {}

module.exports = {
  radixEnum,
  externalAccessEnum,
  resolveBitTarget,
  buildMember,
  buildDataType,
  applyDeadMemberByteCorrections,
};
