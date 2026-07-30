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
const { Parameter, LocalTag, Routine, AOI, Program, Task, EventInfo, ScheduledProgram, Controller, RSLogix5000Content } = require("./elements");
const { decodeUdtInitialValue } = require("./render");
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

function aoiTagUsageFlags(ext01) {
  return ext01.length > 0x20e ? ext01[0x20e] : 0;
}

function aoiTagDataType(db, rawRec) {
  if (rawRec.length < 0x2e) return "";
  const dtOid = dv(rawRec).getUint32(0x2a, true);
  const row = queryOne(db, "SELECT comp_name FROM comps WHERE object_id=?", [dtOid]);
  return row ? row[0] : "";
}

function buildParameter(db, objectId) {
  const row = queryOne(db, "SELECT comp_name, record FROM comps WHERE object_id=?", [objectId]);
  const name = row[0];
  const rawRec = row[1];

  const dataType = aoiTagDataType(db, rawRec);

  let dimensions = null;
  if (rawRec.length >= 0x1e) {
    const dimVal = dv(rawRec).getUint32(0x1a, true);
    if (dimVal) dimensions = String(dimVal);
  }

  let r;
  let exts;
  try {
    r = new RxGeneric(new KaitaiStream(rawRec));
    exts = new Map();
    for (const er of r.extendedRecords) exts.set(er.attributeId, er.value);
  } catch (e) {
    return new Parameter(name, "Base", dataType, "Input", null, "false", "false", "Read/Write", null, dimensions);
  }

  const ext01 = exts.get(0x01) || new Uint8Array(0);
  const flags = aoiTagUsageFlags(ext01);

  const usageBits = flags & 0x0c;
  let usage;
  if (usageBits === 0x04) usage = "Input";
  else if (usageBits === 0x08) usage = "Output";
  else usage = "InOut";

  const required = flags & 0x20 ? "true" : "false";
  const visible = flags & 0x40 ? "true" : "false";

  let externalAccess;
  let constant;
  if (usage === "InOut") {
    externalAccess = null;
    constant = dataType === "MESSAGE" ? null : "false";
  } else if (ext01.length > 0x21f) {
    const eaVal = dv(ext01).getUint16(0x21e, true);
    externalAccess = externalAccessEnum(eaVal);
    constant = null;
  } else {
    externalAccess = "Read/Write";
    constant = null;
  }

  let radix;
  if (!dataType || ext01.length <= 0x20f) {
    radix = null;
  } else {
    const radixIdx = ext01[0x20f] >> 4;
    radix = radixIdx !== 0 ? radixEnum(radixIdx) : null;
  }

  let description = null;
  if (rawRec.length >= 18) {
    const memberRef = dv(rawRec).getUint32(14, true);
    if (memberRef) {
      const descRow = queryOne(db, "SELECT record_string FROM comments WHERE parent=? AND member_ref=? LIMIT 1", [
        r.commentId * 0x10000 + r.cipType,
        memberRef,
      ]);
      if (descRow && descRow[0]) description = descRow[0];
    }
  }

  return new Parameter(name, "Base", dataType, usage, radix, required, visible, externalAccess, constant, dimensions, {
    description,
  });
}

function buildLocalTag(db, objectId) {
  const row = queryOne(db, "SELECT comp_name, record FROM comps WHERE object_id=?", [objectId]);
  const name = row[0];
  const rawRec = row[1];

  const dataType = aoiTagDataType(db, rawRec);

  let dimensions = null;
  if (rawRec.length >= 0x1e) {
    const dimVal = dv(rawRec).getUint32(0x1a, true);
    if (dimVal) dimensions = String(dimVal);
  }

  let r;
  let exts;
  try {
    r = new RxGeneric(new KaitaiStream(rawRec));
    exts = new Map();
    for (const er of r.extendedRecords) exts.set(er.attributeId, er.value);
  } catch (e) {
    return new LocalTag(name, dataType, dimensions, null, "Read/Write");
  }

  const ext01 = exts.get(0x01) || new Uint8Array(0);
  let externalAccess;
  if (ext01.length > 0x21f) {
    const eaVal = dv(ext01).getUint16(0x21e, true);
    externalAccess = externalAccessEnum(eaVal);
  } else {
    externalAccess = "Read/Write";
  }

  let radix;
  if (ext01.length > 0x20f) {
    const radixIdx = ext01[0x20f] >> 4;
    radix = radixIdx !== 0 ? radixEnum(radixIdx) : null;
  } else {
    radix = null;
  }

  let description = null;
  if (rawRec.length >= 18) {
    const memberRef = dv(rawRec).getUint32(14, true);
    if (memberRef) {
      const descRow = queryOne(db, "SELECT record_string FROM comments WHERE parent=? AND member_ref=? LIMIT 1", [
        r.commentId * 0x10000 + r.cipType,
        memberRef,
      ]);
      if (descRow && descRow[0]) description = descRow[0];
    }
  }

  return new LocalTag(name, dataType, dimensions, radix, externalAccess, { description });
}

function routineTypeEnum(idx) {
  switch (idx) {
    case 0:
      return "TypeLess";
    case 1:
      return "RLL";
    case 2:
      return "FBD";
    case 3:
      return "SFC";
    case 4:
      return "ST";
    case 5:
      return "External";
    case 6:
      return "Encrypted";
    default:
      return "Typeless";
  }
}

function parseFffeff(data, offset) {
  if (offset + 4 > data.length || !(data[offset] === 0xff && data[offset + 1] === 0xfe && data[offset + 2] === 0xff)) {
    return ["", offset];
  }
  let length = data[offset + 3];
  offset += 4;
  if (length === 0xff) {
    if (offset + 2 > data.length) return ["", offset];
    length = dv(data).getUint16(offset, true);
    offset += 2;
  }
  const s = KaitaiStream.bytesToStr(data.subarray(offset, offset + length * 2), "UTF-16LE");
  return [s, offset + length * 2];
}

const ST_LINE_RECORD_TYPE = 0x01000002;

function stRoutineLines(db, routineObjectId) {
  const lines = [];
  let frontier = [routineObjectId];
  for (let depth = 0; depth < 6; depth++) {
    if (!frontier.length) break;
    const qmarks = frontier.map(() => "?").join(",");
    const rows = queryAll(db, `SELECT object_id, record FROM nameless WHERE parent_id IN (${qmarks})`, frontier);
    frontier = [];
    for (const [oid, rec] of rows) {
      frontier.push(oid);
      if (rec.length < 24) continue;
      if (dv(rec).getUint32(4, true) !== ST_LINE_RECORD_TYPE) continue;
      const seq = dv(rec).getUint32(20, true);
      if (seq === 0xffffffff) continue;
      const [text] = parseFffeff(rec, 24);
      lines.push([seq, text]);
    }
  }
  if (!lines.length) return [];
  lines.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  let texts = lines.map(([, text]) => text);

  const allHex = new Set();
  for (const t of texts) {
    for (const m of t.matchAll(/@([0-9a-fA-F]{1,8})@/g)) allHex.add(m[1]);
  }
  if (allHex.size) {
    const idToName = new Map();
    for (const hexId of allHex) {
      const row = queryOne(db, "SELECT comp_name FROM comps WHERE object_id=?", [parseInt(hexId, 16)]);
      if (row && row[0]) idToName.set(hexId, row[0]);
    }
    if (idToName.size) {
      texts = texts.map((line) => line.replace(/@([0-9a-fA-F]{1,8})@/g, (m, hex) => idToName.get(hex) || m));
    }
  }
  return texts;
}

function lookupObjectDescription(db, r, record) {
  try {
    const ownScopeId = record.length >= 18 ? dv(record).getUint16(16, true) : 0;
    const commentParent = r.commentId * 0x10000 + r.cipType;
    const rows = queryAll(db, "SELECT record_string FROM comments WHERE parent=? AND scope_id=? AND record_type=1", [
      commentParent,
      ownScopeId,
    ]);
    const candidates = rows.map((row) => row[0]).filter(Boolean);
    if (candidates.length) return candidates.reduce((a, b) => (b.length > a.length ? b : a));
  } catch (e) {
    // matches Python's bare except: pass
  }
  return null;
}

function buildRoutine(db, objectId) {
  const results = queryAll(db, "SELECT comp_name, object_id, parent_id, record FROM comps WHERE object_id=?", [objectId]);

  let r;
  try {
    r = new RxGeneric(new KaitaiStream(results[0][3]));
  } catch (e) {
    return null;
  }

  const record = results[0][3];
  const name = results[0][0];
  const routineType = routineTypeEnum(dv(r.recordBuffer).getUint16(0x30, true));
  if (routineType === "TypeLess") return null;

  const rowsRaw = queryAll(
    db,
    "SELECT rm.object_id, r.rung FROM region_map rm LEFT JOIN rungs r ON r.object_id = rm.object_id " +
      "WHERE rm.parent_id=? ORDER BY rm.unknown",
    [objectId],
  );
  const rows = rowsRaw.filter((row) => row[1] !== null);
  const rungIds = rows.map((row) => row[0]);
  let rungs = rows.map((row) => row[1]);

  const allHex = new Set();
  for (const rung of rungs) {
    if (!rung) continue;
    for (const m of rung.matchAll(/&([0-9a-f]{8}):/g)) allHex.add(m[1]);
  }
  if (allHex.size) {
    const idToName = new Map();
    for (const hexId of allHex) {
      const row2 = queryOne(db, "SELECT comp_name FROM comps WHERE object_id=?", [parseInt(hexId, 16)]);
      if (row2) idToName.set(hexId, row2[0]);
    }
    if (idToName.size) {
      rungs = rungs.map((rung) =>
        rung ? rung.replace(/&([0-9a-f]{8}):/g, (m, hex) => (idToName.has(hex) ? idToName.get(hex) + ":" : m)) : rung,
      );
    }
  }

  const rungComments = new Map();
  let description = null;
  try {
    const ownScopeId = record.length >= 18 ? dv(record).getUint16(16, true) : 0;
    const commentParent = r.commentId * 0x10000 + r.cipType;
    const commentRows = queryAll(db, "SELECT record_string, rung_content FROM comments WHERE parent=? AND scope_id=? AND record_type=1", [
      commentParent,
      ownScopeId,
    ]);
    const descCandidates = [];
    const rungContentRows = [];
    for (const [recStr, rungContent] of commentRows) {
      if (rungContent) {
        rungContentRows.push([rungContent, recStr]);
      } else if (recStr) {
        descCandidates.push(recStr);
      }
    }
    if (descCandidates.length) description = descCandidates.reduce((a, b) => (b.length > a.length ? b : a));

    if (rungContentRows.length) {
      const rungIdToIndex = new Map(rungIds.map((oid, i) => [oid, i]));
      for (const [rungContent, recStr] of rungContentRows) {
        if (!recStr) continue;
        const fragment = rungContent >>> 16;
        let rungIndex = null;
        const idxUids = queryAll(db, "SELECT rung_object_id FROM regnlink_idx WHERE routine_id=? AND fragment=?", [
          objectId,
          fragment,
        ]).map((row) => row[0]);
        if (idxUids.length) {
          for (const uid of idxUids) {
            rungIndex = rungIdToIndex.has(uid) ? rungIdToIndex.get(uid) : null;
            if (rungIndex !== null) break;
          }
        } else {
          const row3 = queryOne(db, "SELECT rung_object_id FROM regnlink WHERE routine_id=? AND fragment=?", [
            objectId,
            fragment,
          ]);
          if (row3 !== null) rungIndex = rungIdToIndex.has(row3[0]) ? rungIdToIndex.get(row3[0]) : null;
        }
        if (rungIndex !== null && rungIndex !== undefined && !rungComments.has(rungIndex)) {
          rungComments.set(rungIndex, recStr);
        }
      }
    }
  } catch (e) {
    // matches Python's bare except: pass
  }

  let stLines = [];
  if (routineType === "ST") stLines = stRoutineLines(db, objectId);

  return new Routine(name, routineType, rungs, { rungIds, rungComments, description, stLines });
}

function filetimeToIso(ft) {
  const ftBig = typeof ft === "bigint" ? ft : BigInt(ft);
  if (ftBig === 0n) return "";
  const microsSince1601 = ftBig / 10n;
  const EPOCH_DIFF_MICROS = 11644473600000000n;
  const unixMicros = microsSince1601 - EPOCH_DIFF_MICROS;
  const unixMillis = unixMicros / 1000n;
  const millisNum = Number(unixMillis);
  if (!Number.isFinite(millisNum)) return "";
  const date = new Date(millisNum);
  const year = date.getUTCFullYear();
  if (Number.isNaN(date.getTime()) || year < 1 || year > 9999) return "";
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${p(year, 4)}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())}.` +
    `${p(date.getUTCMilliseconds(), 3)}Z`
  );
}

function parseAoiNameless(data) {
  const result = {};
  let offset = 0x1a;
  for (let i = 0; i < 3; i++) {
    [, offset] = parseFffeff(data, offset);
  }
  offset += 8;
  offset += 2;

  [result.createdBy, offset] = parseFffeff(data, offset);
  [, offset] = parseFffeff(data, offset);
  offset += 4;
  [, offset] = parseFffeff(data, offset);

  result.createdDate = filetimeToIso(dv(data).getBigUint64(offset, true));
  offset += 8;

  [result.editedBy, offset] = parseFffeff(data, offset);
  [result.softwareRevision, offset] = parseFffeff(data, offset);
  offset += 4;

  let revExt;
  [revExt, offset] = parseFffeff(data, offset);
  result.revisionExtension = revExt || null;

  result.editedDate = filetimeToIso(dv(data).getBigUint64(data.length - 8, true));

  return result;
}

function buildAoi(db, objectId) {
  const results = queryAll(db, "SELECT comp_name, object_id, parent_id, record FROM comps WHERE object_id=?", [objectId]);
  const aoiRecord = results[0][3];
  const name = results[0][0];

  let rAoi = null;
  let revMajor = 1;
  let revMinor = 0;
  try {
    const r = new RxGeneric(new KaitaiStream(aoiRecord));
    rAoi = r;
    const exts = new Map();
    for (const e of r.extendedRecords) exts.set(e.attributeId, e.value);
    const e01 = exts.get(0x01) || new Uint8Array(0);
    revMajor = e01.length > 0x1b ? dv(e01).getUint16(0x1a, true) : 1;
    revMinor = e01.length > 0x1d ? dv(e01).getUint16(0x1c, true) : 0;
  } catch (e) {
    revMajor = 1;
    revMinor = 0;
  }
  const revision = `${revMajor}.${revMinor}`;

  const vlen = aoiRecord.length > 0xa8 ? dv(aoiRecord).getUint16(0xa6, true) : 0;
  const vendor = vlen > 0 ? KaitaiStream.bytesToStr(aoiRecord.subarray(0xa8, 0xa8 + vlen), "UTF-8") : null;

  const namelessRow = queryOne(db, "SELECT record FROM nameless WHERE parent_id=? ORDER BY LENGTH(record) DESC LIMIT 1", [
    objectId,
  ]);
  let meta;
  if (namelessRow && namelessRow[0].length > 50) {
    meta = parseAoiNameless(namelessRow[0]);
  } else {
    meta = { createdBy: "", createdDate: "", editedBy: "", editedDate: "", softwareRevision: "", revisionExtension: null };
  }

  const parameters = [];
  const localTags = [];
  const routines = [];

  const tagCollRow = queryOne(db, "SELECT object_id FROM comps WHERE parent_id=? AND comp_name='RxTagCollection'", [objectId]);
  if (tagCollRow) {
    const tagCollOid = tagCollRow[0];
    const childRows = queryAll(db, "SELECT object_id, record FROM comps WHERE parent_id=? AND record_type != 512 ORDER BY seq_number", [
      tagCollOid,
    ]);
    for (const [childOid, childRec] of childRows) {
      let isParam = false;
      try {
        const rChild = new RxGeneric(new KaitaiStream(childRec));
        const extsChild = new Map();
        for (const er of rChild.extendedRecords) extsChild.set(er.attributeId, er.value);
        const ext01 = extsChild.get(0x01) || new Uint8Array(0);
        const flags = aoiTagUsageFlags(ext01);
        isParam = Boolean(flags & 0x0c);
      } catch (e) {
        // matches Python's bare except: pass
      }

      if (isParam) {
        try {
          parameters.push(buildParameter(db, childOid));
        } catch (e) {
          // matches Python's bare except: pass
        }
      } else {
        try {
          localTags.push(buildLocalTag(db, childOid));
        } catch (e) {
          // matches Python's bare except: pass
        }
      }
    }
  }

  const routineCollRow = queryOne(db, "SELECT object_id FROM comps WHERE parent_id=? AND comp_name='RxRoutineCollection'", [
    objectId,
  ]);
  if (routineCollRow) {
    const routineCollOid = routineCollRow[0];
    const childOids = queryAll(db, "SELECT object_id FROM comps WHERE parent_id=?", [routineCollOid]).map((r) => r[0]);
    for (const childOid of childOids) {
      let routine;
      try {
        routine = buildRoutine(db, childOid);
      } catch (e) {
        routine = null;
      }
      if (routine !== null) routines.push(routine);
    }
  }

  let aoiDescription = null;
  let revisionNote = "";
  if (rAoi !== null) {
    const aoiCommentParent = rAoi.commentId * 0x10000 + rAoi.cipType;
    const descRow = queryOne(
      db,
      "SELECT record_string FROM comments WHERE parent=? AND member_ref=0 AND record_type=1 LIMIT 1",
      [aoiCommentParent],
    );
    if (descRow && descRow[0]) aoiDescription = descRow[0];
    try {
      const rnRow = queryOne(db, "SELECT record_string FROM comments WHERE parent=? AND tag_reference='__REVISION_NOTE__' LIMIT 1", [
        aoiCommentParent,
      ]);
      if (rnRow) revisionNote = rnRow[0] || "";
    } catch (e) {
      // matches Python's bare except: pass
    }
  }

  return new AOI(
    name,
    revision,
    meta.revisionExtension,
    vendor,
    "false",
    "false",
    "false",
    meta.createdDate,
    meta.createdBy,
    meta.editedDate,
    meta.editedBy,
    meta.softwareRevision,
    parameters,
    localTags,
    routines,
    { description: aoiDescription, revisionNote },
  );
}

function buildProgram(db, objectId, dataTypesMap = new Map(), redundancyEnabled = false, hexOidMap = null) {
  const results = queryAll(db, "SELECT comp_name, object_id, parent_id, record FROM comps WHERE object_id=?", [objectId]);

  const progRecord = results[0][3];
  const r = new RxGeneric(new KaitaiStream(progRecord));

  const name = results[0][0];

  const exts = new Map();
  for (const e of r.extendedRecords) exts.set(e.attributeId, e.value);
  let mainRoutineName = null;
  let faultRoutineName = null;
  if (exts.has(0x12d) && exts.get(0x12d).length >= 4) {
    const mainOid = dv(exts.get(0x12d)).getUint32(0, true);
    if (mainOid) {
      const row = queryOne(db, "SELECT comp_name FROM comps WHERE object_id=?", [mainOid]);
      mainRoutineName = row ? row[0] : null;
    }
  }
  if (exts.has(0x066) && exts.get(0x066).length >= 4) {
    const faultOid = dv(exts.get(0x066)).getUint32(0, true);
    if (faultOid) {
      const row = queryOne(db, "SELECT comp_name FROM comps WHERE object_id=?", [faultOid]);
      faultRoutineName = row ? row[0] : null;
    }
  }

  const ext01 = exts.get(0x01) || new Uint8Array(0);
  const disabledFlag = ext01.length >= 0x28 ? dv(ext01).getUint32(0x24, true) !== 0 : false;
  const disabled = disabledFlag ? "true" : "false";

  const collectionResults = queryAll(db, "SELECT comp_name, object_id, parent_id, record FROM comps WHERE parent_id=? AND comp_name='RxRoutineCollection'", [
    objectId,
  ]);

  const routines = [];
  if (collectionResults.length) {
    const collectionId = collectionResults[0][1];
    const routineResults = queryAll(db, "SELECT comp_name, object_id, parent_id, record FROM comps WHERE parent_id=?", [
      collectionId,
    ]);
    for (const child of routineResults) {
      const routine = buildRoutine(db, child[1]);
      if (routine !== null) routines.push(routine);
    }
  }

  const tagCollResults = queryAll(
    db,
    "SELECT comp_name, object_id, parent_id, record_type FROM comps WHERE parent_id=? AND comp_name='RxTagCollection'",
    [objectId],
  );
  if (tagCollResults.length > 1) throw new Error("Contains more than one program tag collection");

  const tags = [];
  if (tagCollResults.length) {
    const childResults = queryAll(
      db,
      "SELECT comp_name, object_id, parent_id, record_type FROM comps WHERE parent_id=? AND record_type != 264",
      [tagCollResults[0][1]],
    );
    for (const result of childResults) {
      const tag = buildTag(db, result[1], hexOidMap);
      tag._dataTypesMap = dataTypesMap;
      if ((tag._initialValue === null || tag._initialValue === undefined) && tag._dataTableInstance) {
        const n = countArrayElements(tag.dimensions);
        const getCompsRecord = (oid) => {
          const row = queryOne(db, "SELECT record FROM comps WHERE object_id=?", [oid]);
          return row ? row[0] : undefined;
        };
        const udtVal = decodeUdtInitialValue(getCompsRecord, tag._dataTableInstance, tag.dataType, n, dataTypesMap, tag.dimensions !== null);
        if (udtVal !== null && udtVal !== undefined) tag._initialValue = udtVal;
      }
      tags.push(tag);
    }
  }

  const syncRedundancy = redundancyEnabled ? "true" : null;

  const description = lookupObjectDescription(db, r, progRecord);

  return new Program(name, "false", mainRoutineName, faultRoutineName, disabled, syncRedundancy, "false", tags, routines, {
    description,
  });
}

const TASK_TYPE_MAP = new Map([
  [1, "EVENT"],
  [2, "PERIODIC"],
  [4, "CONTINUOUS"],
]);

function buildTask(db, objectId, commentIdToProgram) {
  const row = queryOne(db, "SELECT comp_name, record FROM comps WHERE object_id=?", [objectId]);
  const [name, record] = row;
  const d = dv(record);

  const rateUs = d.getUint32(0x106c, true);
  const typeVal = d.getUint16(0x10f6, true);
  const priority = d.getUint16(0x10f8, true);
  const watchdogUs = d.getUint32(0x110a, true);
  const disableUpdate = record[0x112e];

  const taskType = TASK_TYPE_MAP.get(typeVal) || "PERIODIC";
  const rateStr = taskType !== "CONTINUOUS" ? String(Math.floor(rateUs / 1000)) : null;

  const progCount = d.getUint16(0x5a, true);
  const scheduledPrograms = [];
  for (let i = 0; i < progCount; i++) {
    const offset = 0x5a + 2 + i * 4;
    if (offset + 4 > record.length) break;
    const cid = d.getUint32(offset, true);
    const progName = commentIdToProgram.get(cid);
    if (progName) scheduledPrograms.push(new ScheduledProgram(progName));
  }

  let eventInfo = null;
  if (taskType === "EVENT") eventInfo = new EventInfo("EVENT Instruction Only", "false");

  return new Task(
    name,
    taskType,
    rateStr,
    String(priority),
    String(Math.floor(watchdogUs / 1000)),
    disableUpdate ? "true" : "false",
    "false",
    eventInfo,
    scheduledPrograms,
  );
}

const WEEKDAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Mirrors Python's (datetime(1601,1,1) + timedelta(seconds=raw)).strftime("%a %b %d %H:%M:%S %Y")
// for a FILETIME-derived seconds-since-1601 value (raw may be fractional; only
// whole-second precision is shown, matching strftime's %S).
function filetimeSecondsToWeekdayString(rawSeconds) {
  const SECONDS_1601_TO_1970 = 11644473600;
  const unixSeconds = rawSeconds - SECONDS_1601_TO_1970;
  const date = new Date(unixSeconds * 1000);
  const p = (n) => String(n).padStart(2, "0");
  // getUTCDay(): 0=Sunday..6=Saturday; WEEKDAY_ABBR is Mon-first, so remap.
  const dayIdx = (date.getUTCDay() + 6) % 7;
  return (
    `${WEEKDAY_ABBR[dayIdx]} ${MONTH_ABBR[date.getUTCMonth()]} ${p(date.getUTCDate())} ` +
    `${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())} ${date.getUTCFullYear()}`
  );
}

function decodeUtf16TrimNul(extendedRecords, key) {
  const raw = extendedRecords.get(key);
  if (raw === undefined || raw.length < 2) return "";
  return KaitaiStream.bytesToStr(raw.subarray(0, raw.length - 2), "UTF-16LE");
}

function buildController(db) {
  const rootResults = queryAll(
    db,
    "SELECT comp_name, object_id, parent_id, record_type, record FROM comps WHERE parent_id=0 AND record_type=256",
  );
  if (rootResults.length !== 1) throw new Error("Does not contain exactly one root controller node");

  const rootRecord = rootResults[0][4];
  const r = new RxGeneric(new KaitaiStream(rootRecord));

  const controllerDescription = lookupObjectDescription(db, r, rootRecord);

  const extendedRecords = new Map();
  for (const er of r.extendedRecords) extendedRecords.set(er.attributeId, er.value);

  const sfcExecutionControl = decodeUtf16TrimNul(extendedRecords, 0x6f);
  const sfcRestartPosition = decodeUtf16TrimNul(extendedRecords, 0x70);
  const sfcLastScan = decodeUtf16TrimNul(extendedRecords, 0x71);

  let commPathPrefix = null;
  if (extendedRecords.has(0x06a)) {
    const cpStr = KaitaiStream.bytesToStr(extendedRecords.get(0x06a), "UTF-16LE").replace(/\0+$/, "");
    if (cpStr) commPathPrefix = cpStr;
  } else {
    let recOffset = 82;
    for (const er of r.extendedRecords) recOffset += 4 + 4 + er.value.length;
    const tail = rootRecord.subarray(recOffset);
    if (tail.length >= 8) {
      const dTail = dv(tail);
      const lastAttrId = dTail.getUint32(0, true);
      const lastLenValue = dTail.getUint32(4, true);
      if (lastAttrId === 0x06a && lastLenValue >= 4) {
        const actualLen = lastLenValue - 4;
        if (tail.length >= 8 + actualLen && actualLen > 0) {
          const cpVal = tail.subarray(8, 8 + actualLen);
          const cpStr = KaitaiStream.bytesToStr(cpVal, "UTF-16LE").replace(/\0+$/, "");
          if (cpStr) commPathPrefix = cpStr;
        }
      }
    }
  }

  let projectSn;
  if (extendedRecords.has(0x75)) {
    const snRaw = dv(extendedRecords.get(0x75))
      .getUint32(0, true)
      .toString(16)
      .padStart(8, "0");
    projectSn = `16#${snRaw.slice(0, 4)}_${snRaw.slice(4)}`;
  } else {
    projectSn = "Unknown";
  }

  const rawModifiedDate = Number(dv(extendedRecords.get(0x66)).getBigUint64(0, true)) / 10000000;
  const lastModifiedDate = filetimeSecondsToWeekdayString(rawModifiedDate);

  const rawCreatedDate = Number(dv(extendedRecords.get(0x65)).getBigUint64(0, true)) / 10000000;
  const projectCreationDate = filetimeSecondsToWeekdayString(rawCreatedDate);

  let majorFaultProgram = null;
  if (extendedRecords.has(0x068) && extendedRecords.get(0x068).length >= 4) {
    const mfpOid = dv(extendedRecords.get(0x068)).getUint32(0, true);
    if (mfpOid && mfpOid !== 0xffffffff) {
      const mfpRow = queryOne(db, "SELECT comp_name FROM comps WHERE object_id=?", [mfpOid]);
      majorFaultProgram = mfpRow ? mfpRow[0] : null;
    }
  }

  const ctrlExt001 = extendedRecords.get(0x001) || new Uint8Array(0);
  const redundancyEnabled = ctrlExt001.length > 0x0e ? Boolean(ctrlExt001[0x0e]) : false;

  const controllerObjectId = rootResults[0][1];
  const controllerName = rootResults[0][0];

  const dtCollResults = queryAll(
    db,
    "SELECT comp_name, object_id, parent_id, record_type FROM comps WHERE parent_id=? AND comp_name='RxDataTypeCollection'",
    [controllerObjectId],
  );
  if (dtCollResults.length > 1) throw new Error("Contains more than one controller data type collection");
  const dataTypeCollId = dtCollResults[0][1];
  const dtChildResults = queryAll(
    db,
    "SELECT comp_name, object_id, parent_id, record_type FROM comps WHERE parent_id=?",
    [dataTypeCollId],
  );

  const dataTypes = [];
  const allDataTypesMap = new Map();
  for (const result of dtChildResults) {
    const dt = buildDataType(db, result[1]);
    allDataTypesMap.set(dt.name.toUpperCase(), dt);
    if (dt.cls === "User") dataTypes.push(dt);
  }

  applyDeadMemberByteCorrections(allDataTypesMap);
  const dataTypesMap = allDataTypesMap;

  const tagCollResults = queryAll(
    db,
    "SELECT comp_name, object_id, parent_id, record_type FROM comps WHERE parent_id=? AND comp_name='RxTagCollection'",
    [controllerObjectId],
  );
  if (tagCollResults.length > 1) throw new Error("Contains more than one controller tag collection");
  const tagCollectionObjectId = tagCollResults[0][1];
  const tagChildResults = queryAll(
    db,
    "SELECT comp_name, object_id, parent_id, record_type FROM comps WHERE parent_id=? AND record_type != 264",
    [tagCollectionObjectId],
  );

  const hexOidMap = buildHexOidMap(db);

  const tags = [];
  for (const result of tagChildResults) {
    const tagObjectId = result[1];
    const tag = buildTag(db, tagObjectId, hexOidMap);
    tag._dataTypesMap = dataTypesMap;
    if ((tag._initialValue === null || tag._initialValue === undefined) && tag._dataTableInstance) {
      const n = countArrayElements(tag.dimensions);
      const getCompsRecord = (oid) => {
        const row = queryOne(db, "SELECT record FROM comps WHERE object_id=?", [oid]);
        return row ? row[0] : undefined;
      };
      const udtVal = decodeUdtInitialValue(getCompsRecord, tag._dataTableInstance, tag.dataType, n, dataTypesMap, tag.dimensions !== null);
      if (udtVal !== null && udtVal !== undefined) tag._initialValue = udtVal;
    }
    if (
      tag.dataType &&
      !tag.name.startsWith("$") &&
      !tag.name.startsWith("__l0") &&
      !tag.name.startsWith("__CLONE")
    ) {
      tags.push(tag);
    }
  }

  // Resolve comment paths to full Studio 5000 addresses for I/O tags.
  for (const tag of tags) {
    if (!tag.name.includes(":")) continue;
    if (!tag._comments.length) continue;
    const dt = dataTypesMap.get(tag.dataType.toUpperCase());
    let dataMember = null;
    if (dt) {
      for (const m of dt.members) {
        if ((m.bitNumber === null || m.bitNumber === undefined) && !["FAULT", "STATUS"].includes(m.name.toUpperCase())) {
          dataMember = m;
          break;
        }
      }
      if (dataMember === null) {
        for (const m of dt.members) {
          if (m.bitNumber === null || m.bitNumber === undefined) {
            dataMember = m;
            break;
          }
        }
      }
    }

    const resolved = [];
    for (const [path, text] of tag._comments) {
      if (!path) {
        resolved.push([path, text]);
      } else if (path.startsWith(".!")) {
        let arrayMember = null;
        if (dt) {
          for (const m of dt.members) {
            if ((m.bitNumber === null || m.bitNumber === undefined) && m.dimension > 0) {
              arrayMember = m;
              break;
            }
          }
        }
        const dm = arrayMember || dataMember;
        if (!dm) {
          resolved.push([path, text]);
          continue;
        }
        const inner = path.slice(2);
        if (inner.includes("[") && inner.includes(".") && inner.indexOf("[") < inner.lastIndexOf(".")) {
          const bracketIdx = inner.indexOf("[");
          const bracketPart = inner.slice(bracketIdx + 1);
          const dotIdx = bracketPart.lastIndexOf(".");
          let arrayIdx = bracketPart.slice(0, dotIdx);
          const bitPart = bracketPart.slice(dotIdx + 1);
          arrayIdx = arrayIdx.replace(/\]+$/, "");
          resolved.push([`${tag.name}.${dm.name}[${arrayIdx}].${bitPart}`, text]);
        } else if (inner.includes("[")) {
          const bracketIdx = inner.indexOf("[");
          let suffix = inner.slice(bracketIdx + 1);
          suffix = suffix.replace(/\]+$/, "");
          resolved.push([`${tag.name}.${dm.name}[${suffix}]`, text]);
        } else {
          resolved.push([path, text]);
        }
      } else if (path.startsWith("!")) {
        if (!dataMember) {
          resolved.push([path, text]);
          continue;
        }
        const rest = path.slice(1);
        if (rest.includes(".")) {
          const dotIdx = rest.indexOf(".");
          const suffix = rest.slice(dotIdx + 1);
          if (dataMember.dimension > 0) {
            resolved.push([`${tag.name}.${dataMember.name}[${suffix}]`, text]);
          } else {
            resolved.push([`${tag.name}.${dataMember.name}.${suffix}`, text]);
          }
        } else if (rest.includes("[")) {
          const bracketIdx = rest.indexOf("[");
          let suffix = rest.slice(bracketIdx + 1);
          suffix = suffix.replace(/\]+$/, "");
          resolved.push([`${tag.name}.${dataMember.name}[${suffix}]`, text]);
        } else {
          resolved.push([path, text]);
        }
      } else if (path.endsWith("]")) {
        resolved.push([`${tag.name}[${path}`, text]);
      } else if (/^\d+$/.test(path)) {
        resolved.push([`${tag.name}.${path}`, text]);
      } else {
        resolved.push([path, text]);
      }
    }
    tag._comments = resolved;
  }

  const progCollResults = queryAll(
    db,
    "SELECT comp_name, object_id, parent_id, record_type FROM comps WHERE parent_id=? AND comp_name='RxProgramCollection'",
    [controllerObjectId],
  );
  if (progCollResults.length > 1) throw new Error("Contains more than one controller program collection");
  const programCollectionObjectId = progCollResults[0][1];
  const progChildResults = queryAll(
    db,
    "SELECT comp_name, object_id, parent_id, record_type FROM comps WHERE parent_id=? AND record_type=256",
    [programCollectionObjectId],
  );
  const programs = [];
  for (const result of progChildResults) {
    programs.push(buildProgram(db, result[1], dataTypesMap, redundancyEnabled, hexOidMap));
  }

  const commentIdToProgram = new Map();
  for (const [pname, rec] of queryAll(db, "SELECT comp_name, record FROM comps WHERE parent_id=?", [programCollectionObjectId])) {
    commentIdToProgram.set(dv(rec).getUint16(0x0c, true), pname);
  }

  const taskCollRow = queryOne(db, "SELECT comp_name, object_id FROM comps WHERE parent_id=? AND comp_name='RxTaskCollection'", [
    controllerObjectId,
  ]);
  const tasks = [];
  if (taskCollRow) {
    const taskCollectionObjectId = taskCollRow[1];
    const taskResults = queryAll(db, "SELECT comp_name, object_id FROM comps WHERE parent_id=? AND record_type=256", [
      taskCollectionObjectId,
    ]);
    for (const taskResult of taskResults) {
      try {
        tasks.push(buildTask(db, taskResult[1], commentIdToProgram));
      } catch (e) {
        console.warn(`Skipping undecodable task ${JSON.stringify(taskResult[0])}: ${e}`);
      }
    }
  }

  const aoiCollResults = queryAll(
    db,
    "SELECT comp_name, object_id, parent_id, record_type FROM comps WHERE parent_id=? AND comp_name='RxUDIDefinitionCollection'",
    [controllerObjectId],
  );
  if (aoiCollResults.length > 1) throw new Error("Contains more than one AOI collection");
  const aois = [];
  if (aoiCollResults.length) {
    const aoiCollectionObjectId = aoiCollResults[0][1];
    const aoiChildResults = queryAll(
      db,
      "SELECT comp_name, object_id, parent_id, record_type FROM comps WHERE parent_id=? AND record_type=256",
      [aoiCollectionObjectId],
    );
    for (const result of aoiChildResults) {
      aois.push(buildAoi(db, result[1]));
    }
  }

  const aoiParamNames = new Map();
  for (const aoi of aois) {
    aoiParamNames.set(aoi.name.toUpperCase(), new Set(aoi.parameters.map((p) => p.name)));
  }
  if (aoiParamNames.size) {
    const stripAoiBindingComments = (tagList) => {
      for (const t of tagList) {
        if (!t.dataType || !t._comments.length) continue;
        const dt = allDataTypesMap.get(t.dataType.toUpperCase());
        if (!dt) continue;
        const memberTypes = new Map(dt.members.map((m) => [m.name, m.dataType]));
        const kept = [];
        for (const [ref, text] of t._comments) {
          if (ref.startsWith(t.name)) {
            const suffix = ref.slice(t.name.length);
            if (suffix.startsWith(".") && !suffix.slice(1).includes(".") && !suffix.includes("[")) {
              const mname = suffix.slice(1);
              const mtype = memberTypes.get(mname);
              if (mtype) {
                const paramNames = aoiParamNames.get(mtype.toUpperCase());
                if (paramNames && paramNames.has(text)) continue;
              }
            }
          }
          kept.push([ref, text]);
        }
        t._comments = kept;
      }
    };
    stripAoiBindingComments(tags);
    for (const p of programs) stripAoiBindingComments(p.tags);
  }

  const devCollRow = queryOne(db, "SELECT object_id FROM comps WHERE parent_id=? AND comp_name='RxMapDeviceCollection'", [
    controllerObjectId,
  ]);
  let modules = [];
  if (devCollRow) {
    const collOid = devCollRow[0];
    const modRows = queryAll(
      db,
      "SELECT comp_name, object_id, record FROM comps WHERE parent_id=? AND record_type=256 ORDER BY seq_number",
      [collOid],
    );

    const modidToName = new Map();
    for (const [dbName, modOid, modRec] of modRows) {
      const displayName = dbName.startsWith("$") && dbName.endsWith("$") ? "?" : dbName;
      try {
        const rMod = new RxGeneric(new KaitaiStream(modRec));
        if (rMod.cipType === 0x69) {
          const exts = new Map();
          for (const er of rMod.extendedRecords) exts.set(er.attributeId, er.value);
          const e1 = exts.get(0x001) || new Uint8Array(0);
          if (e1.length >= 0x30) {
            const modid = dv(e1).getUint32(0x2c, true);
            modidToName.set(modid, displayName);
          }
        }
      } catch (e) {
        // matches Python's bare except: pass
      }
    }

    modules = modRows.map(([, modOid]) => buildModule(db, modOid, modidToName));

    const childCounts = new Map();
    for (const m of modules) {
      const key = `${m.parentModule},${m.parentModPortId}`;
      childCounts.set(key, (childCounts.get(key) || 0) + 1);
    }
    for (const m of modules) {
      const portChildCounts = new Map();
      for (let portId = 1; portId < 20; portId++) {
        const key = `${m.name},${portId}`;
        if (childCounts.has(key)) portChildCounts.set(portId, childCounts.get(key));
      }
      m._portChildCounts = portChildCounts;
    }
  }

  const processorType = modules.find((m) => m.majorFault === "true" && m.catalogNumber)?.catalogNumber || null;

  const localModule = modules.find((m) => m.name === "Local") || modules.find((m) => m.majorFault === "true") || null;
  let majorRev;
  let minorRev;
  if (localModule !== null) {
    majorRev = String(localModule.major);
    minorRev = String(localModule.minor);
  } else {
    majorRev = "0";
    minorRev = "0";
  }

  let commPath = null;
  if (commPathPrefix !== null) {
    const ctrlModule = modules.find((m) => m.majorFault === "true");
    if (ctrlModule !== undefined) {
      commPath = commPathPrefix + String(ctrlModule._slot);
    }
  }

  return new Controller(
    {
      use: "Target",
      name: controllerName,
      processorType,
      majorRev,
      minorRev,
      majorFaultProgram,
      projectCreationDate,
      lastModifiedDate,
      sfcExecutionControl,
      sfcRestartPosition,
      sfcLastScan,
      commPath,
      projectSn,
      matchProjectToController: "false",
      canUseRpiFromProducer: "false",
      inhibitAutomaticFirmwareUpdate: "0",
      passThroughConfiguration: "EnabledWithAppend",
      downloadProjectDocumentationAndExtendedProperties: "true",
      downloadProjectCustomProperties: "true",
      reportMinorOverflow: "false",
      autoDiagsEnabled: "false",
      webServerEnabled: "false",
      dataTypes,
      modules,
      tags,
      programs,
      tasks,
      aois,
    },
    { redundancyEnabled, description: controllerDescription },
  );
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
  routineTypeEnum,
  parseFffeff,
  stRoutineLines,
  lookupObjectDescription,
  buildRoutine,
  buildParameter,
  buildLocalTag,
  buildTag,
  filetimeToIso,
  parseAoiNameless,
  buildAoi,
  buildProgram,
  buildTask,
  buildController,
};
