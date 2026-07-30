// Port of acd/l5x/elements.py's *Builder classes (Python lines ~2431 on).
// Each Builder here is a plain function taking (db, objectId, ...) instead
// of a dataclass instance, since JS has no cursor-attached-to-self
// convention to mirror -- db is a sql.js Database throughout.

const { KaitaiStream } = require("kaitai-struct");
const { RxGeneric } = require("../generated/RxGeneric");
const { queryAll, queryOne } = require("./sqlutil");
const { Member, DataType } = require("./render");
const { Module } = require("./elements");
const { CATALOG_NUMBERS } = require("./catalog_numbers");
const { Tag } = require("./tag");
const { readTagInitialValue, countArrayElements, SKIP_DECORATED } = require("./render");

const CONNECTION_TYPE_BY_CODE = new Map([
  [5, "Input"],
  [6, "Output"],
  [7, "DiagnosticInput"],
  [23, "MotionSync"],
  [48, "StandardDataDriven"],
]);

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

// latin-1 is a lossless 1:1 byte<->codepoint mapping, so decoding a whole raw
// record this way and then doing plain string search/regex on it is
// equivalent to Python's raw-bytes `needle in raw` / `re.search(rb"...")`
// checks, as long as the needle itself is pure ASCII (always true below).
function latin1Decode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function ipFromDataCollection(db, icpSlot) {
  const needle = `Type="ICP" Addr="${icpSlot}"`;
  const row = queryOne(db, "SELECT object_id FROM comps WHERE comp_name='RxDataCollection' LIMIT 1");
  if (!row) return "";
  const collOid = row[0];
  const rows = queryAll(db, "SELECT record FROM comps WHERE parent_id=?", [collOid]);
  for (const [raw] of rows) {
    const text = latin1Decode(raw);
    if (!text.includes(needle)) continue;
    const m = /Type="EN" Addr="([^"]+)"/.exec(text);
    return m ? m[1] : "";
  }
  return "";
}

function extractCommAndPublic(raw) {
  const xmlStart = raw.indexOf(0x3c); // '<'
  if (xmlStart < 0) return [null, ""];
  const xmlText = latin1Decode(raw.subarray(xmlStart));
  let commMethod = null;
  const cfM = /<CF>(\d+)<\/CF>/.exec(xmlText);
  if (cfM) commMethod = cfM[1];
  let pubContent = "";
  const pubStart = xmlText.indexOf("<public>");
  if (pubStart >= 0) {
    const afterPub = xmlText.slice(pubStart + "<public>".length);
    const endTagM = /<\/pub/.exec(afterPub);
    if (endTagM) {
      pubContent = afterPub.slice(0, endTagM.index);
    } else {
      pubContent = afterPub.replace(/[\x00 \r\n]+$/, "");
    }
  }
  return [commMethod, pubContent];
}

function commsFromDataCollection(db, icpSlot, ipAddress = "") {
  const row = queryOne(db, "SELECT object_id FROM comps WHERE comp_name='RxDataCollection' LIMIT 1");
  if (!row) return [null, ""];
  const collOid = row[0];
  const allRecs = queryAll(db, "SELECT record FROM comps WHERE parent_id=?", [collOid]).map((r) => r[0]);

  if (icpSlot) {
    const needle = `Type="ICP" Addr="${icpSlot}"`;
    for (const raw of allRecs) {
      if (latin1Decode(raw).includes(needle)) {
        const result = extractCommAndPublic(raw);
        if (result[0] !== null || result[1]) return result;
      }
    }
  }

  if (ipAddress) {
    const ipNeedle = `Addr="${ipAddress}"`;
    for (const raw of allRecs) {
      if (latin1Decode(raw).includes(ipNeedle)) {
        const result = extractCommAndPublic(raw);
        if (result[0] !== null || result[1]) return result;
      }
    }
  }

  return [null, ""];
}

function chassisSizeFromDataCollection(db) {
  const row = queryOne(db, "SELECT object_id FROM comps WHERE comp_name='RxDataCollection' LIMIT 1");
  if (!row) return null;
  const collOid = row[0];
  const rows = queryAll(db, "SELECT record FROM comps WHERE parent_id=?", [collOid]);
  const needle = 'Type="ICP" Addr="0"';
  for (const [raw] of rows) {
    const full = latin1Decode(raw);
    if (!full.includes(needle)) continue;
    const textStart = full.indexOf("<");
    if (textStart < 0) continue;
    const text = full.slice(textStart);
    const m = /<Bus\b[^>]*\bSize="(\d+)"/.exec(text);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function buildModule(db, objectId, modidToName) {
  const row = queryOne(db, "SELECT comp_name, object_id, record FROM comps WHERE object_id=?", [objectId]);
  const dbName = row[0];
  const rawRec = row[2];

  const name = dbName.startsWith("$") && dbName.endsWith("$") ? "?" : dbName;

  let r;
  try {
    r = new RxGeneric(new KaitaiStream(rawRec));
  } catch (e) {
    return new Module(name, "", 0, 0, 0, 0, 0, "Local", 1, "false", "false");
  }

  if (r.cipType !== 0x69) {
    return new Module(name, "", 0, 0, 0, 0, 0, "Local", 1, "false", "false");
  }

  const exts = new Map();
  for (const er of r.extendedRecords) exts.set(er.attributeId, er.value);
  const e1 = exts.get(0x001) || new Uint8Array(0);
  if (e1.length < 0x30) {
    const majorFault = name === "Local" ? "true" : "false";
    return new Module(name, "", 0, 0, 0, 0, 0, "Local", 1, "false", majorFault);
  }

  const d1 = dv(e1);
  const vendor = d1.getUint16(0x02, true);
  const productType = d1.getUint16(0x04, true);
  const productCode = d1.getUint16(0x06, true);
  const major = e1[0x08] & 0x7f;
  const minor = e1[0x09];
  const parentModid = d1.getUint32(0x16, true);
  const parentPort = d1.getUint16(0x1a, true);
  const slot = d1.getUint32(0x1c, true);

  let effectiveProductType = productType;
  let effectiveProductCode = productCode;
  if (name === "?") {
    effectiveProductType = 0;
    effectiveProductCode = 28;
  }

  const parentName = modidToName.get(parentModid) || "Local";
  const majorFault = parentName === name ? "true" : "false";
  const ekeyState = e1[0] & 0x04 ? "Disabled" : "CompatibleModule";

  let ipAddress = "";
  if (e1.length > 0x32) {
    const ipLen = d1.getUint16(0x30, true);
    if (ipLen) {
      let end = 0x32 + ipLen;
      const slice = e1.subarray(0x32, end);
      let trimEnd = slice.length;
      while (trimEnd > 0 && slice[trimEnd - 1] === 0) trimEnd--;
      ipAddress = latin1Decode(slice.subarray(0, trimEnd));
    }
  }
  if (!ipAddress && slot) ipAddress = ipFromDataCollection(db, slot);

  let backplaneSlot = null;
  let chassisSize = null;
  const outRow = queryOne(
    db,
    "SELECT o.record FROM comps coll " +
      "JOIN comps o ON o.parent_id = coll.object_id AND o.comp_name = 'Output' " +
      "WHERE coll.parent_id = ? AND coll.comp_name = 'RxMapConnectionCollection'",
    [objectId],
  );
  if (outRow) {
    const outRec = outRow[0];
    if (outRec.length > 0x70) {
      const dOut = dv(outRec);
      backplaneSlot = dOut.getUint16(0x6e, true);
      chassisSize = dOut.getUint16(0x4e, true);
    }
  }

  if (chassisSize === null && slot === 0xffffffff) {
    chassisSize = chassisSizeFromDataCollection(db);
  }

  let description = "";
  const descRow = queryOne(db, "SELECT record_string FROM comments WHERE parent=? AND member_ref=0 LIMIT 1", [
    r.commentId * 0x10000 + r.cipType,
  ]);
  if (descRow) description = descRow[0] || "";

  let commMethod = null;
  const connections = [];
  let extendedProperties = "";
  if (slot || ipAddress) {
    [commMethod, extendedProperties] = commsFromDataCollection(db, slot, ipAddress);
  }

  const connRows = queryAll(
    db,
    "SELECT c2.comp_name, c2.record FROM comps c1 " +
      "JOIN comps c2 ON c2.parent_id = c1.object_id " +
      "WHERE c1.parent_id = ? AND c1.comp_name = 'RxMapConnectionCollection' " +
      "AND c2.comp_name NOT IN ('Output') " +
      "ORDER BY c2.seq_number",
    [objectId],
  );
  for (const [connName, connRec] of connRows) {
    let connType = null;
    let code = null;
    let rpiStr = "0";
    if (connRec.length >= 96) {
      const dConn = dv(connRec);
      code = dConn.getUint16(90, true);
      connType = CONNECTION_TYPE_BY_CODE.get(code) || null;
      rpiStr = String(dConn.getUint32(92, true));
    }
    if (connType === null) {
      const nameLower = connName.toLowerCase();
      connType = nameLower.includes("output") || nameLower === "config" ? "Output" : "Input";
      console.warn(
        `Unrecognized connection type code ${code} for connection '${connName}' on module ` +
          `'${name}' (record length ${connRec.length}) -- falling back to name heuristic, guessed ` +
          `'${connType}'. Please report this so the code can be added to CONNECTION_TYPE_BY_CODE.`,
      );
    }
    connections.push([connName, rpiStr, connType]);
  }

  return new Module(
    name,
    CATALOG_NUMBERS.get(`${vendor},${effectiveProductType},${effectiveProductCode}`) || "",
    vendor,
    effectiveProductType,
    effectiveProductCode,
    major,
    minor,
    parentName,
    parentPort,
    "false",
    majorFault,
    {
      ekeyState,
      slot,
      ipAddress,
      backplaneSlot,
      chassisSize,
      description,
      commMethod,
      connections,
      extendedProperties,
    },
  );
}

function buildHexOidMap(db) {
  const rows = queryAll(
    db,
    "SELECT m.comp_name, m.record FROM comps m " +
      "INNER JOIN comps c ON m.parent_id = c.object_id " +
      "WHERE c.comp_name = 'RxTypeMemberCollection'",
  );
  const hexOidMap = new Map();
  for (const [name, rec] of rows) {
    if (rec.length < 18) continue;
    const d = dv(rec);
    const high = d.getUint16(12, true);
    const low = d.getUint16(16, true);
    const oid = (high << 16) | low;
    const existing = hexOidMap.get(oid >>> 0);
    if (existing === undefined || name.length < existing.length) hexOidMap.set(oid >>> 0, name);
  }
  return hexOidMap;
}

function resolveTagNameFromOid(db, oid) {
  const row = queryOne(db, "SELECT comp_name, record FROM comps WHERE object_id=?", [oid]);
  if (!row) return null;
  const [compName, rec] = row;
  try {
    const r = new RxGeneric(new KaitaiStream(rec));
    for (const er of r.extendedRecords) {
      if (er.attributeId === 1) {
        const v = er.value;
        const nl = dv(v).getUint16(0, true);
        return KaitaiStream.bytesToStr(v.subarray(2, 2 + nl), "UTF-8");
      }
    }
  } catch (e) {
    // fall through
  }
  return compName;
}

function buildTag(db, objectId, hexOidMap = null) {
  const getCompsRecord = (oid) => {
    const row = queryOne(db, "SELECT record FROM comps WHERE object_id=?", [oid]);
    return row ? row[0] : undefined;
  };

  const results = queryAll(db, "SELECT comp_name, object_id, parent_id, record FROM comps WHERE object_id=?", [objectId]);
  const rawRec = results[0][3];

  let externalAccess;
  let constantFlag;
  if (rawRec.length > 0x279) {
    externalAccess = externalAccessEnum(rawRec[0x278]);
    constantFlag = Boolean(rawRec[0x279]);
  } else {
    externalAccess = "Read/Write";
    constantFlag = false;
  }

  let r;
  try {
    r = new RxGeneric(new KaitaiStream(rawRec));
  } catch (e) {
    return new Tag(results[0][0], "Base", "", null, externalAccess, constantFlag ? "true" : "false", null);
  }

  if (r.cipType !== 0x6b && r.cipType !== 0x68) {
    return new Tag(results[0][0], "Base", "", null, externalAccess, constantFlag ? "true" : "false", null);
  }

  let dataType;
  if (r.mainRecord.dataType === 0xffffffff) {
    dataType = "";
  } else {
    const dtRow = queryOne(db, "SELECT comp_name FROM comps WHERE object_id=?", [r.mainRecord.dataType]);
    dataType = dtRow[0];
  }

  const ownScopeId = rawRec.length >= 18 ? dv(rawRec).getUint16(16, true) : 0;
  let commentResults = queryAll(db, "SELECT tag_reference, record_string FROM comments WHERE parent=? AND scope_id=?", [
    r.commentId * 0x10000 + r.cipType,
    ownScopeId,
  ]);

  const extendedRecords = new Map();
  for (const er of r.extendedRecords) extendedRecords.set(er.attributeId, er.value);

  const rawRadix = r.mainRecord.radix;
  const radix = rawRadix !== 0 ? radixEnum(rawRadix) : null;

  const dimParts = [];
  if (r.mainRecord.dimension1 !== 0) dimParts.push(String(r.mainRecord.dimension1));
  if (r.mainRecord.dimension2 !== 0) dimParts.push(String(r.mainRecord.dimension2));
  if (r.mainRecord.dimension3 !== 0) dimParts.push(String(r.mainRecord.dimension3));
  const dimensions = dimParts.length ? dimParts.join(",") : null;
  const dti = r.mainRecord.dataTableInstance;
  const initialValue = readTagInitialValue(getCompsRecord, dti, dataType, countArrayElements(dimensions), dimensions !== null);

  let tagName = results[0][0];
  if (extendedRecords.has(0x01)) {
    const ext01 = extendedRecords.get(0x01);
    const nameLength = dv(ext01).getUint16(0, true);
    tagName = KaitaiStream.bytesToStr(ext01.subarray(2, nameLength + 2), "UTF-8");
  }

  let tagType = "Base";
  let target = null;

  let consumed = 82;
  for (const er of r.extendedRecords) consumed += 8 + er.value.length;
  const remaining = rawRec.subarray(consumed);
  if (remaining.length >= 8) {
    const dRem = dv(remaining);
    const extraAttrId = dRem.getUint32(0, true);
    if (extraAttrId === 0x65) {
      tagType = "Alias";
      const extraLen = dRem.getUint32(4, true);
      if (extraLen > 0 && 8 + extraLen <= remaining.length) {
        const pathBytes = remaining.subarray(8, 8 + extraLen);
        const pathText = KaitaiStream.bytesToStr(pathBytes, "UTF-16LE").replace(/\0+$/, "");
        const baseTarget = resolveTagNameFromOid(db, dti);
        if (baseTarget !== null) {
          target = baseTarget;
          const subpathParts = [];
          if (pathText.includes("@.")) {
            const parts = pathText.split("@.");
            for (const part of parts.slice(1)) {
              if (!part) continue;
              if (part.startsWith("@")) {
                const end = part.indexOf("@", 1);
                const hexOid = end >= 0 ? part.slice(1, end) : part.slice(1);
                const literal = end >= 0 ? part.slice(end + 1) : "";
                const oid = parseInt(hexOid, 16) || 0;
                if (oid) {
                  const memberName = resolveTagNameFromOid(db, oid);
                  if (memberName) subpathParts.push(memberName);
                }
                if (literal) subpathParts.push(literal);
              } else {
                subpathParts.push(part);
              }
            }
          } else if (pathText.includes("@")) {
            const end = pathText.indexOf("@", 1);
            if (end >= 0) {
              const rest = pathText.slice(end + 1);
              if (rest) subpathParts.push(rest);
            }
          }
          if (subpathParts.length) {
            let subpathStr = "";
            for (const sp of subpathParts) {
              if (sp.startsWith("[")) {
                subpathStr += sp;
              } else if (subpathStr) {
                subpathStr += "." + sp;
              } else {
                subpathStr = sp;
              }
            }
            target = subpathStr.startsWith("[") ? baseTarget + subpathStr : baseTarget + "." + subpathStr;
          }
        }
      }
    }
  }

  if (!tagName.includes(":")) {
    const map = hexOidMap !== null ? hexOidMap : buildHexOidMap(db);
    if (map.size) {
      commentResults = commentResults.map(([ref, text]) => {
        if (ref && ref.includes("!")) {
          const newRef = ref.replace(/!([0-9A-F]{8})/g, (m, hex) => {
            const hexVal = parseInt(hex, 16);
            const name = map.get(hexVal);
            return name !== undefined ? name : m;
          });
          return [newRef, text];
        }
        return [ref, text];
      });
    }
  }

  const normalized = [];
  for (const [ref, text] of commentResults) {
    if (!ref) {
      normalized.push([ref, text]);
    } else if (ref.startsWith(".!") || ref.startsWith("!")) {
      normalized.push([ref, text]);
    } else if (ref.endsWith("]")) {
      if (ref.includes("[") && !ref.startsWith("[")) {
        normalized.push([`${tagName}.${ref}`, text]);
      } else if (ref.startsWith("[")) {
        normalized.push([`${tagName}${ref}`, text]);
      } else {
        normalized.push([`${tagName}[${ref}`, text]);
      }
    } else if (/^\d+$/.test(ref)) {
      normalized.push([`${tagName}.${ref}`, text]);
    } else if (ref.includes("].")) {
      normalized.push([`${tagName}${ref}`, text]);
    } else if (ref.includes(".") && !ref.includes(":")) {
      const sep = ref.startsWith(".") ? "" : ".";
      if (dimensions !== null) {
        normalized.push([`${tagName}[0]${sep}${ref}`, text]);
      } else {
        normalized.push([`${tagName}${sep}${ref}`, text]);
      }
    } else {
      normalized.push([ref, text]);
    }
  }

  let constant;
  if (tagType === "Alias" || SKIP_DECORATED.has(dataType.toUpperCase())) {
    constant = null;
  } else {
    constant = constantFlag ? "true" : "false";
  }

  return new Tag(tagName, tagType, dataType, radix, externalAccess, constant, dimensions, {
    target,
    dataTableInstance: dti,
    comments: normalized,
    initialValue,
  });
}

module.exports = {
  radixEnum,
  externalAccessEnum,
  resolveBitTarget,
  buildMember,
  buildDataType,
  applyDeadMemberByteCorrections,
  buildModule,
  buildHexOidMap,
  resolveTagNameFromOid,
  buildTag,
};
