// Port of acd/l5x/elements.py's module-level XML/value-rendering helpers
// (everything from _escape_xml_attr through _build_comments_xml, i.e. lines
// 1-1585 of the Python file) plus the base L5xElement/Member/DataType/Tag
// classes. See ../CLAUDE.md for status/verification notes.
//
// This is a direct, function-for-function transliteration -- Python already
// has the correct (hard-won, extensively verified) logic; nothing here is
// re-derived from scratch. Comments are trimmed from the Python originals
// but the byte-level reasoning is preserved where it materially affects the
// code (kept minimal; see ../../CLAUDE.md and acd/l5x/elements.py itself for
// the full historical reasoning behind each rule).

const { RxGeneric } = require("../generated/RxGeneric");
const { KaitaiStream } = require("kaitai-struct");

// ---------------------------------------------------------------------------
// XML text helpers
// ---------------------------------------------------------------------------

const XML_ILLEGAL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/g;

function htmlEscape(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function escapeXmlAttr(value) {
  let text = XML_ILLEGAL_RE[Symbol.replace](String(value), "");
  text = htmlEscape(text);
  return text.replace(/\t/g, "&#x9;").replace(/\r/g, "&#xD;").replace(/\n/g, "&#xA;");
}

function multilineXmlText(raw) {
  return raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function sanitizeXmlText(text) {
  // XML 1.0 allows only #x9, #xA, #xD, #x20-#xD7FF, #xE000-#xFFFD.
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (ch === "\t" || ch === "\n" || ch === "\r" || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd)) {
      out += ch;
    } else {
      out += `&#x${cp.toString(16).toUpperCase().padStart(4, "0")};`;
    }
  }
  return out;
}

function toXmlAttrName(attr) {
  // Mirrors Python's attr.title().replace("_", "") for lowercase snake_case input.
  return attr
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

// ---------------------------------------------------------------------------
// Generic L5xElement base class (mirrors Python's reflection-based to_xml())
// ---------------------------------------------------------------------------

const LIST_SECTION_NAMES = {
  tags: "Tags",
  localTags: "LocalTags",
  parameters: "Parameters",
  dataTypes: "DataTypes",
  members: "Members",
  modules: "Modules",
  programs: "Programs",
  routines: "Routines",
  aois: "AddOnInstructionDefinitions",
  tasks: "Tasks",
  scheduledPrograms: "ScheduledPrograms",
};

class L5xElement {
  toXml() {
    const attributeList = [];
    const childList = [];
    for (const attribute of Object.keys(this)) {
      if (attribute[0] === "_") continue;
      let attributeValue = this[attribute];
      if (attributeValue === null || attributeValue === undefined) continue;
      if (attributeValue instanceof L5xElement) {
        childList.push(attributeValue.toXml());
      } else if (Array.isArray(attributeValue)) {
        if (attribute in LIST_SECTION_NAMES) {
          const sectionName = LIST_SECTION_NAMES[attribute];
          const newChildList = [];
          for (const element of attributeValue) {
            if (element instanceof L5xElement) {
              if (element._l5xExclude) continue;
              newChildList.push(element.toXml());
            } else {
              newChildList.push(`<${element}/>`);
            }
          }
          childList.push(`<${sectionName}>${newChildList.join("")}</${sectionName}>`);
        }
      } else {
        let attrName = attribute;
        if (attrName === "cls") attrName = "class";
        if (typeof attributeValue === "boolean") attributeValue = String(attributeValue);
        const overrides = this._xmlAttrOverrides || {};
        const xmlAttrName = overrides[attribute] || toXmlAttrName(attrName);
        attributeList.push(`${xmlAttrName}="${escapeXmlAttr(attributeValue)}"`);
      }
    }
    const exportName = this._exportName || this.constructor.name;
    return `<${exportName} ${attributeList.join(" ")}>${childList.join("")}</${exportName}>`;
  }
}

// ---------------------------------------------------------------------------
// Member / DataType
// ---------------------------------------------------------------------------

const PRIMITIVE_RADIX = {
  SINT: "Decimal",
  INT: "Decimal",
  DINT: "Decimal",
  LINT: "Decimal",
  USINT: "Decimal",
  UINT: "Decimal",
  UDINT: "Decimal",
  ULINT: "Decimal",
  REAL: "Float",
  LREAL: "Float",
};

class Member extends L5xElement {
  constructor(name, dataType, dimension, radix, hidden, target, bitNumber, externalAccess, opts = {}) {
    super();
    this.name = name;
    this.dataType = dataType;
    this.dimension = dimension;
    this.radix = radix;
    this.hidden = hidden;
    this.target = target;
    this.bitNumber = bitNumber;
    this.externalAccess = externalAccess;
    this._byteOffset = opts.byteOffset || 0;
    this._description = opts.description ?? null;
    this._exportName = "Member";
  }

  get description() {
    if (this._description === null) return null;
    return this._description
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .join(" ")
      .trim();
  }

  toXml() {
    let base = super.toXml();
    if (this.dataType !== "BIT" && this.bitNumber !== null && this.bitNumber !== undefined) {
      base = base.replace(/\s*BitNumber="[^"]*"/, "");
    }
    if (!this._description) return base;
    const desc = multilineXmlText(this._description);
    const descXml = `<Description>\n<![CDATA[${desc}]]>\n</Description>`;
    const idx = base.indexOf(">");
    return base.slice(0, idx + 1) + descXml + base.slice(idx + 1);
  }
}

function newMember(name, dataType, dimension = 0, radix = null, description = null) {
  if (radix === null) {
    radix = PRIMITIVE_RADIX[dataType.toUpperCase()] || "NullType";
  }
  return new Member(name, dataType, dimension, radix, false, null, null, "Read/Write", { description });
}

class DataType extends L5xElement {
  constructor(name, family, cls, members, opts = {}) {
    super();
    this.name = name;
    this.family = family;
    this.cls = cls;
    this.members = members;
    this._description = opts.description ?? null;
    this._deadMemberBytes = opts.deadMemberBytes || 0;
    this._exportName = "DataType";
  }

  get _l5xExclude() {
    return this.cls === "ProductDefined" || this.name.includes(":");
  }

  toXml() {
    const base = super.toXml();
    if (!this._description) return base;
    const desc = multilineXmlText(this._description);
    const descXml = `<Description>\n<![CDATA[${desc}]]>\n</Description>`;
    const idx = base.indexOf(">");
    return base.slice(0, idx + 1) + descXml + base.slice(idx + 1);
  }
}

// ---------------------------------------------------------------------------
// L5K / Decorated value rendering
// ---------------------------------------------------------------------------

const PRIMITIVE_L5K_ZERO = {
  BOOL: "0",
  SINT: "0",
  INT: "0",
  DINT: "0",
  LINT: "0",
  USINT: "0",
  UINT: "0",
  UDINT: "0",
  ULINT: "0",
  REAL: "0.00000000e+000",
  LREAL: "0.00000000e+000",
};

function l5kPrimLiteral(dtUpper, val) {
  if (dtUpper === "BOOL" || dtUpper === "BIT") return `2#${val ? 1 : 0}`;
  if (dtUpper === "REAL" || dtUpper === "LREAL") return l5kRealLiteral(val);
  return String(Math.trunc(val));
}

function l5kArrayLiteral(dtBase, values) {
  return "[" + values.map((v) => l5kPrimLiteral(dtBase, v)).join(",") + "]";
}

function l5kUdtLiteral(dtName, values, dataTypesMap) {
  if (Array.isArray(values)) {
    return "[" + values.map((v) => l5kUdtLiteral(dtName, v, dataTypesMap)).join(",") + "]";
  }

  if (isStringFamilyType(dtName, dataTypesMap)) {
    const length = values.LEN ?? 0;
    const text = values.DATA ?? "";
    const cap = stringFamilyCapacity(dtName, dataTypesMap);
    return `[${length},${l5kStringPadded(text, cap)}]`;
  }

  const dtObj = dataTypesMap.get(dtName.toUpperCase());
  if (dtObj === undefined) return "[]";

  const parts = [];
  for (const member of dtObj.members) {
    if (member.dataType === "BIT") continue;
    const val = values[member.name];
    if (val === undefined || val === null) continue;
    const mdt = member.dataType;
    if ((typeof val === "object" && !Array.isArray(val)) || (Array.isArray(val) && val.length && typeof val[0] === "object")) {
      parts.push(l5kUdtLiteral(mdt, val, dataTypesMap));
    } else if (Array.isArray(val)) {
      parts.push(l5kArrayLiteral(mdt.toUpperCase(), val));
    } else {
      parts.push(l5kPrimLiteral(mdt.toUpperCase(), val));
    }
  }
  return "[" + parts.join(",") + "]";
}

function l5kRealLiteral(value) {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    const label = Number.isNaN(value) ? "#QNAN" : "#INF";
    const sign = 1 / value < 0 || value < 0 ? "-" : "";
    return `${sign}1.${label.padEnd(8, "0")}e+000`;
  }
  if (value === 0) return "0.00000000e+000";
  // toExponential(8) mirrors Python's f"{value:.8e}" exactly (mantissa
  // includes the sign, e.g. "-5.00000000e-1").
  const formatted = value.toExponential(8);
  const [mantissa, expPart] = formatted.split("e");
  const sign = expPart[0];
  const expDigits = expPart.slice(1).padStart(3, "0");
  return `${mantissa}e${sign}${expDigits}`;
}

function shortestFloat32Repr(value) {
  const targetBuf = new ArrayBuffer(4);
  new DataView(targetBuf).setFloat32(0, value, true);
  const targetBits = new Uint8Array(targetBuf).join(",");
  for (let decimals = 0; decimals < 15; decimals++) {
    const candidate = value.toFixed(decimals);
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, parseFloat(candidate), true);
    if (new Uint8Array(buf).join(",") === targetBits) return candidate;
  }
  return value.toPrecision(6);
}

function decoratedRealLiteral(value, inArray) {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    if (inArray) return 1 / value < 0 || value < 0 ? "-1.$" : "1.$";
    const label = Number.isNaN(value) ? "#QNAN" : "#INF";
    const sign = 1 / value < 0 || value < 0 ? "-" : "";
    return `${sign}1.${label}`;
  }
  let formatted = shortestFloat32Repr(value);
  if (!formatted.includes(".") && !formatted.includes("e") && !formatted.includes("E")) {
    formatted += ".0";
  }
  return formatted;
}

const PRIMITIVE_DECORATED_ZERO = {
  BOOL: "0",
  BIT: "0",
  SINT: "0",
  INT: "0",
  DINT: "0",
  LINT: "0",
  USINT: "0",
  UINT: "0",
  UDINT: "0",
  ULINT: "0",
  REAL: "0.0",
  LREAL: "0.0",
};

const BUILTIN_STRUCT_MEMBERS = {
  TIMER: [
    ["PRE", "DINT"],
    ["ACC", "DINT"],
    ["EN", "BOOL"],
    ["TT", "BOOL"],
    ["DN", "BOOL"],
  ],
  COUNTER: [
    ["PRE", "DINT"],
    ["ACC", "DINT"],
    ["CU", "BOOL"],
    ["CD", "BOOL"],
    ["DN", "BOOL"],
    ["OV", "BOOL"],
    ["UN", "BOOL"],
  ],
  CONTROL: [
    ["LEN", "DINT"],
    ["POS", "DINT"],
    ["EN", "BOOL"],
    ["EU", "BOOL"],
    ["DN", "BOOL"],
    ["EM", "BOOL"],
    ["ER", "BOOL"],
    ["UL", "BOOL"],
    ["IN", "BOOL"],
    ["FD", "BOOL"],
  ],
};

const SKIP_DECORATED = new Set(["ALARM_DIGITAL", "MESSAGE", "AXIS_SERVO", "PID_ENHANCED", "AXIS_CIP_DRIVE", "MOTION_GROUP"]);

function memberDecoratedXml(memberName, memberDt, memberDim, dataTypesMap) {
  if (memberDim > 0) return arrayMemberXml(memberName, memberDt, memberDim, dataTypesMap);
  if (memberDt === "BOOL" || memberDt === "BIT") {
    return `<DataValueMember Name="${memberName}" DataType="BOOL" Value="0"/>`;
  }
  const radix = PRIMITIVE_RADIX[memberDt];
  const zero = PRIMITIVE_DECORATED_ZERO[memberDt];
  if (radix !== undefined && zero !== undefined) {
    return `<DataValueMember Name="${memberName}" DataType="${memberDt}" Radix="${radix}" Value="${zero}"/>`;
  }
  const inner = structMembersXml(memberDt, dataTypesMap);
  if (inner === null) return "";
  return `<StructureMember Name="${memberName}" DataType="${memberDt}">${inner}</StructureMember>`;
}

function arrayMemberXml(memberName, memberDt, dim, dataTypesMap) {
  const radix = PRIMITIVE_RADIX[memberDt];
  const zero = PRIMITIVE_DECORATED_ZERO[memberDt];
  const isBool = memberDt === "BOOL" || memberDt === "BIT";

  if (isBool) {
    let elems = "";
    for (let i = 0; i < dim; i++) elems += `<Element Index="[${i}]" Value="0"/>`;
    return `<ArrayMember Name="${memberName}" DataType="BOOL" Dimensions="${dim}" Radix="Decimal">${elems}</ArrayMember>`;
  }
  if (radix !== undefined && zero !== undefined) {
    let elems = "";
    for (let i = 0; i < dim; i++) elems += `<Element Index="[${i}]" Value="${zero}"/>`;
    return `<ArrayMember Name="${memberName}" DataType="${memberDt}" Dimensions="${dim}" Radix="${radix}">${elems}</ArrayMember>`;
  }
  const inner = structMembersXml(memberDt, dataTypesMap);
  if (inner === null) return "";
  const structXml = `<Structure DataType="${memberDt}">${inner}</Structure>`;
  let elems = "";
  for (let i = 0; i < dim; i++) elems += `<Element Index="[${i}]">${structXml}</Element>`;
  return `<ArrayMember Name="${memberName}" DataType="${memberDt}" Dimensions="${dim}">${elems}</ArrayMember>`;
}

function structMembersXml(dtName, dataTypesMap) {
  if (SKIP_DECORATED.has(dtName)) return null;

  if (isStringFamilyType(dtName, dataTypesMap)) {
    return (
      '<DataValueMember Name="LEN" DataType="DINT" Radix="Decimal" Value="0"/>' +
      `<DataValueMember Name="DATA" DataType="${dtName}" Radix="ASCII">${stringLiteralCdata("")}</DataValueMember>`
    );
  }

  const builtinMembers = BUILTIN_STRUCT_MEMBERS[dtName];
  if (builtinMembers !== undefined) {
    const parts = [];
    for (const [mname, mdt] of builtinMembers) {
      const radix = PRIMITIVE_RADIX[mdt];
      const zero = PRIMITIVE_DECORATED_ZERO[mdt];
      if (radix !== undefined && zero !== undefined) {
        parts.push(`<DataValueMember Name="${mname}" DataType="${mdt}" Radix="${radix}" Value="${zero}"/>`);
      } else {
        parts.push(`<DataValueMember Name="${mname}" DataType="${mdt}" Value="0"/>`);
      }
    }
    return parts.join("");
  }

  const dtObj = dataTypesMap.get(dtName);
  if (dtObj === undefined) return null;

  const parts = [];
  for (const member of dtObj.members) {
    if (member.hidden) continue;
    const mdt = member.dataType.toUpperCase();
    const fragment = memberDecoratedXml(member.name, mdt, member.dimension, dataTypesMap);
    if (fragment) parts.push(fragment);
  }
  return parts.join("");
}

function generateDecorated(dtBase, dimensions, dataTypesMap, tagName = "", comments = null) {
  if (SKIP_DECORATED.has(dtBase)) return "";

  const dtObjForName = dataTypesMap.get(dtBase);
  const displayName = dtObjForName !== undefined ? dtObjForName.name : dtBase;

  let body;
  if (dimensions === null || dimensions === undefined) {
    const inner = structMembersXml(dtBase, dataTypesMap);
    if (inner === null) return "";
    body = `<Structure DataType="${displayName}">${inner}</Structure>`;
  } else {
    const dimParts = dimensions
      .split(",")
      .filter((d) => /^\d+$/.test(d.trim()))
      .map((d) => parseInt(d, 10));
    if (!dimParts.length) return "";

    const dimStr = dimParts.join(",");
    const radix = PRIMITIVE_RADIX[dtBase];
    const zero = PRIMITIVE_DECORATED_ZERO[dtBase];
    const isBool = dtBase === "BOOL" || dtBase === "BIT";

    const buildElems = (valueFn) => {
      const parts = [];
      const rec = (idxParts, remaining) => {
        if (!remaining.length) {
          parts.push(valueFn(idxParts));
          return;
        }
        for (let i = 0; i < remaining[0]; i++) rec([...idxParts, i], remaining.slice(1));
      };
      rec([], dimParts);
      return parts.join("");
    };

    if (isBool) {
      const elems = buildElems((idx) => `<Element Index="[${idx.join(",")}]" Value="0"/>`);
      body = `<Array DataType="BOOL" Dimensions="${dimStr}" Radix="Decimal">${elems}</Array>`;
    } else if (radix !== undefined && zero !== undefined) {
      const elems = buildElems((idx) => `<Element Index="[${idx.join(",")}]" Value="${zero}"/>`);
      body = `<Array DataType="${dtBase}" Dimensions="${dimStr}" Radix="${radix}">${elems}</Array>`;
    } else {
      const inner = structMembersXml(dtBase, dataTypesMap);
      if (inner === null) return "";
      const structXml = `<Structure DataType="${displayName}">${inner}</Structure>`;
      const elems = buildElems((idx) => `<Element Index="[${idx.join(",")}]">${structXml}</Element>`);
      body = `<Array DataType="${displayName}" Dimensions="${dimStr}">${elems}</Array>`;
    }
  }

  return `<Data Format="Decorated">\n${body}\n</Data>`;
}

function decoratedBinaryLiteral(value, bitWidth) {
  const mask = (1n << BigInt(bitWidth)) - 1n;
  const bits = (BigInt.asUintN(bitWidth, BigInt(value)) & mask).toString(2).padStart(bitWidth, "0");
  const groups = [];
  for (let i = 0; i < bits.length; i += 4) groups.push(bits.slice(i, i + 4));
  return "2#" + groups.join("_");
}

// JS numbers have no int/float distinction at runtime (unlike Python, where
// struct.unpack("<f"/"<d", ...) always yields a `float`-typed value even for
// a whole number like 1.0) -- every REAL/LREAL-vs-integer formatting choice
// below must key off the *declared* data type, never `Number.isInteger(val)`.
// A real bug here (fixed after a synthetic UDT round-trip test caught it):
// a REAL member decoded to exactly 1.0 was misrendered as the bare integer
// "1" instead of "1.0", since 1.0 and 1 are the identical JS number.
function isFloatType(dtUpper) {
  return dtUpper === "REAL" || dtUpper === "LREAL";
}

// Combines isFloatType with the -0 out-of-bounds-fallback sentinel check
// (see decodeScalarMember/readTagInitialValue): Python's isinstance(val,
// float) is false for that fallback's plain int 0 even when the member's
// declared type is REAL/LREAL, so real-number Decorated formatting must be
// skipped for it specifically (renders bare "0", matching Python exactly).
function isGenuineFloat(dtUpper, val) {
  return isFloatType(dtUpper) && !Object.is(val, -0);
}

function udtScalarToXml(dtName, values, dataTypesMap) {
  if (isStringFamilyType(dtName, dataTypesMap)) {
    const length = values.LEN ?? 0;
    const text = values.DATA ?? "";
    return (
      `<DataValueMember Name="LEN" DataType="DINT" Radix="Decimal" Value="${length}"/>` +
      `<DataValueMember Name="DATA" DataType="${dtName}" Radix="ASCII">${stringLiteralCdata(text)}</DataValueMember>`
    );
  }

  const dtObj = dataTypesMap.get(dtName.toUpperCase());
  if (dtObj === undefined) return "";

  const parts = [];
  for (const member of dtObj.members) {
    if (member.hidden) continue;
    const mname = member.name;
    const mdt = member.dataType;
    const mdtUpper = mdt.toUpperCase();
    const val = values[mname];
    if (val === undefined || val === null) continue;

    if (typeof val === "object" && !Array.isArray(val)) {
      const inner = udtScalarToXml(mdt, val, dataTypesMap);
      if (inner) parts.push(`<StructureMember Name="${mname}" DataType="${mdt}">${inner}</StructureMember>`);
    } else if (Array.isArray(val) && val.length && typeof val[0] === "object") {
      const innerParts = val.map(
        (elem, i) => `<Element Index="[${i}]"><Structure DataType="${mdt}">${udtScalarToXml(mdt, elem, dataTypesMap)}</Structure></Element>`,
      );
      parts.push(`<ArrayMember Name="${mname}" DataType="${mdt}" Dimensions="${val.length}">${innerParts.join("")}</ArrayMember>`);
    } else if (Array.isArray(val)) {
      const radix = PRIMITIVE_RADIX[mdtUpper] || "Decimal";
      const fmtElem = (v) => (isGenuineFloat(mdtUpper, v) ? decoratedRealLiteral(v, true) : v);
      const elems = val.map((v, i) => `<Element Index="[${i}]" Value="${fmtElem(v)}"/>`).join("");
      parts.push(`<ArrayMember Name="${mname}" DataType="${mdt}" Dimensions="${val.length}" Radix="${radix}">${elems}</ArrayMember>`);
    } else if (mdtUpper === "BOOL" || mdtUpper === "BIT") {
      parts.push(`<DataValueMember Name="${mname}" DataType="BOOL" Value="${val ? "1" : "0"}"/>`);
    } else {
      const radix = member.radix && member.radix !== "NullType" ? member.radix : PRIMITIVE_RADIX[mdtUpper] || "Decimal";
      let memberVal;
      if (radix === "Binary" && !isFloatType(mdtUpper)) {
        const elemSize = (PRIM[mdtUpper] || { size: 4 }).size;
        memberVal = decoratedBinaryLiteral(val, elemSize * 8);
      } else if (isGenuineFloat(mdtUpper, val)) {
        memberVal = decoratedRealLiteral(val, false);
      } else {
        memberVal = val;
      }
      parts.push(`<DataValueMember Name="${mname}" DataType="${mdt}" Radix="${radix}" Value="${memberVal}"/>`);
    }
  }
  return parts.join("");
}

function udtArrayToXml(dtBase, values, dimStr, dataTypesMap) {
  const dtObjForName = dataTypesMap.get(dtBase.toUpperCase());
  const displayName = dtObjForName !== undefined ? dtObjForName.name : dtBase;
  const dimParts = dimStr
    .split(",")
    .filter((d) => /^\d+$/.test(d.trim()))
    .map((d) => parseInt(d, 10));

  if (dimParts.length > 1) {
    const weights = [];
    let acc = 1;
    for (const d of [...dimParts].reverse()) {
      weights.unshift(acc);
      acc *= d;
    }
    const elems = values.map((val, flatIdx) => {
      const idxParts = [];
      let remaining = flatIdx;
      for (const w of weights) {
        idxParts.push(Math.floor(remaining / w));
        remaining %= w;
      }
      const idx = "[" + idxParts.join(",") + "]";
      const struct = udtScalarToXml(dtBase, val, dataTypesMap);
      return `<Element Index="${idx}"><Structure DataType="${displayName}">${struct}</Structure></Element>`;
    });
    return `<Array DataType="${displayName}" Dimensions="${dimStr}">${elems.join("")}</Array>`;
  }

  const elems = values.map((val, i) => {
    const struct = udtScalarToXml(dtBase, val, dataTypesMap);
    return `<Element Index="[${i}]"><Structure DataType="${displayName}">${struct}</Structure></Element>`;
  });
  return `<Array DataType="${displayName}" Dimensions="${dimStr}">${elems.join("")}</Array>`;
}

const PRIM = {
  BOOL: { size: 1, get: (dv, off) => dv.getUint8(off) },
  SINT: { size: 1, get: (dv, off) => dv.getInt8(off) },
  INT: { size: 2, get: (dv, off) => dv.getInt16(off, true) },
  DINT: { size: 4, get: (dv, off) => dv.getInt32(off, true) },
  LINT: { size: 8, get: (dv, off) => Number(dv.getBigInt64(off, true)) },
  BYTE: { size: 1, get: (dv, off) => dv.getUint8(off) },
  WORD: { size: 2, get: (dv, off) => dv.getUint16(off, true) },
  DWORD: { size: 4, get: (dv, off) => dv.getUint32(off, true) },
  LWORD: { size: 8, get: (dv, off) => Number(dv.getBigUint64(off, true)) },
  REAL: { size: 4, get: (dv, off) => dv.getFloat32(off, true) },
  LREAL: { size: 8, get: (dv, off) => dv.getFloat64(off, true) },
};

const STRING_SIZE = 88;

function stringLiteralCdata(text) {
  if (!text) return "<![CDATA[]]>";
  const escaped = text.replace(/'/g, "''");
  const safe = sanitizeXmlText(escaped);
  return `<![CDATA['${safe}']]>`;
}

function l5kStringPadded(text, capacity) {
  // Use replacer FUNCTIONS, not replacement strings: JS's string-replacement
  // form treats "$'" as a special pattern ("text after the match"), which
  // would silently corrupt this into something else entirely -- caught by
  // testing against Python's _l5k_string_padded("it's", ...).
  let escaped = text.replace(/\$/g, () => "$$").replace(/'/g, () => "$'");
  let out = "";
  for (const ch of escaped) {
    const cp = ch.codePointAt(0);
    out += cp < 0x20 || cp === 0x7f || cp > 0x7e ? `$${cp.toString(16).toUpperCase().padStart(2, "0")}` : ch;
  }
  const pad = "$00".repeat(Math.max(capacity - text.length, 0));
  return `'${out}${pad}'`;
}

function isStringFamilyType(typeName, dataTypesMap) {
  const t = typeName.toUpperCase();
  if (t === "STRING") return true;
  const dt = dataTypesMap.get(t);
  return dt !== undefined && dt.family === "StringFamily";
}

function stringFamilyCapacity(typeName, dataTypesMap) {
  const t = typeName.toUpperCase();
  if (t === "STRING") return 82;
  const dt = dataTypesMap.get(t);
  if (dt !== undefined) {
    for (const m of dt.members) {
      if (m.name.toUpperCase() === "DATA") return m.dimension;
    }
  }
  return 82;
}

function getTypeSize(typeName, dataTypesMap) {
  const t = typeName.toUpperCase();
  const prim = PRIM[t];
  if (prim !== undefined) return prim.size;
  if (t === "STRING") return STRING_SIZE;
  const dt = dataTypesMap.get(t);
  if (dt === undefined) return 0;
  let maxEnd = 0;
  for (const m of dt.members) {
    if (m.dataType === "BIT") continue;
    let memberEnd;
    if (m.dataType.toUpperCase() === "BOOL" && m.dimension > 0) {
      memberEnd = m._byteOffset + Math.ceil((m.dimension + 31) / 32) * 4;
    } else {
      const elemSz = getTypeSize(m.dataType, dataTypesMap);
      if (elemSz === 0) continue;
      memberEnd = m._byteOffset + elemSz * Math.max(m.dimension, 1);
    }
    maxEnd = Math.max(maxEnd, memberEnd);
  }
  if (maxEnd === 0) return 0;
  return maxEnd + (maxEnd % 2);
}

function tagValueBlobOffset(rawRec) {
  try {
    const r = new RxGeneric(new KaitaiStream(rawRec));
    let consumed = 82;
    for (const er of r.extendedRecords) consumed += 8 + er.value.length;
    return consumed + 8;
  } catch (e) {
    return 0x1a2;
  }
}

function readTagInitialValue(getCompsRecord, dataTableInstance, dataType, nElements, isArray = false) {
  const dtUpper = dataType ? dataType.toUpperCase() : "";
  const baseDt = dtUpper.replace(/\[.*\]/, "").trim();

  const prim = PRIM[baseDt];
  if (prim === undefined) return null;

  const rawRec = getCompsRecord(dataTableInstance);
  if (rawRec === undefined) return null;

  const dv = new DataView(rawRec.buffer, rawRec.byteOffset, rawRec.byteLength);
  const offset = tagValueBlobOffset(rawRec);

  if ((baseDt === "BOOL" || baseDt === "BIT") && nElements > 1) {
    const values = [];
    for (let i = 0; i < nElements; i++) {
      const dwordOff = offset + Math.floor(i / 32) * 4;
      if (dwordOff + 4 <= rawRec.length) {
        const dword = dv.getUint32(dwordOff, true);
        values.push((dword >>> i % 32) & 1);
      } else {
        values.push(0);
      }
    }
    return values;
  }

  const values = [];
  for (let i = 0; i < nElements; i++) {
    const byteOff = offset + i * prim.size;
    if (byteOff + prim.size <= rawRec.length) {
      values.push(prim.get(dv, byteOff));
    } else {
      // Mirrors Python's out-of-bounds fallback returning a plain int 0
      // (never a float), even for a REAL/LREAL element -- downstream
      // rendering must show bare "0", not "0.0", for this case specifically
      // (see the -0 sentinel note on decodeScalarMember below). Using -0
      // here (not +0) is an internal marker only; -0 === 0 everywhere else
      // (arithmetic, truthiness, JSON), so this is otherwise invisible.
      values.push(-0);
    }
  }

  if (nElements === 1 && !isArray) return values[0];
  return values;
}

function decodeUdtInitialValue(getCompsRecord, dataTableInstance, dataTypeName, nElements, dataTypesMap, isArray = false) {
  if (!dataTypeName) return null;
  if (nElements > 10000) return null;

  const baseDt = dataTypeName.replace(/\[.*\]/, "").trim();
  const dtObj = dataTypesMap.get(baseDt.toUpperCase());
  if (dtObj === undefined) return null;

  const rawRec = getCompsRecord(dataTableInstance);
  if (rawRec === undefined) return null;

  const structSize = getTypeSize(baseDt.toUpperCase(), dataTypesMap);
  if (structSize === 0) return null;

  const offset = tagValueBlobOffset(rawRec);

  const results = [];
  for (let elemIdx = 0; elemIdx < nElements; elemIdx++) {
    const base = offset + elemIdx * structSize;
    results.push(decodeSingleUdtElement(rawRec, base, dtObj, dataTypesMap, 0));
  }

  if (nElements === 1 && !isArray) return results[0];
  return results;
}

function decodeStringFamilyValue(blob, offset, typeName, dataTypesMap) {
  const cap = stringFamilyCapacity(typeName, dataTypesMap);
  if (offset + 4 > blob.length) return { LEN: 0, DATA: "" };
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  let length = dv.getInt32(offset, true);
  length = Math.max(0, Math.min(length, cap));
  let text = "";
  if (offset + 4 + length <= blob.length) {
    const raw = blob.subarray(offset + 4, offset + 4 + length);
    text = KaitaiStream.bytesToStr(raw, "latin1");
  }
  return { LEN: length, DATA: text };
}

function decodeSingleUdtElement(blob, baseOffset, dataType, dataTypesMap, depth, maxDepth = 3) {
  if (depth > maxDepth) return {};

  if (dataType.family === "StringFamily") {
    return decodeStringFamilyValue(blob, baseOffset, dataType.name, dataTypesMap);
  }

  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const result = {};
  for (const member of dataType.members) {
    if (member.dataType === "BIT") continue;

    const mname = member.name;
    const mdt = member.dataType;
    const mdtUpper = mdt.toUpperCase();
    const off = baseOffset + member._byteOffset;
    const bn = mdtUpper === "BOOL" ? member.bitNumber : null;

    if (member.dimension > 0) {
      if (mdtUpper === "BOOL") {
        const arr = [];
        for (let i = 0; i < member.dimension; i++) {
          const dwordOff = off + Math.floor(i / 32) * 4;
          if (dwordOff + 4 <= blob.length) {
            const dword = dv.getUint32(dwordOff, true);
            arr.push((dword >>> i % 32) & 1);
          } else {
            arr.push(0);
          }
        }
        result[mname] = arr;
        continue;
      }
      const elemSize = getTypeSize(mdtUpper, dataTypesMap);
      if (elemSize === 0) continue;
      const arr = [];
      for (let i = 0; i < member.dimension; i++) {
        arr.push(decodeScalarMember(blob, off + i * elemSize, mdt, dataTypesMap, depth, bn));
      }
      result[mname] = arr;
    } else {
      result[mname] = decodeScalarMember(blob, off, mdt, dataTypesMap, depth, bn);
    }
  }

  // Mirrors Python's `isinstance(target_val, int)` guard exactly: a real,
  // built-in Rockwell structure (PID) has BIT-overlay flags (EN/CT/CL/...)
  // whose target is "SP", a REAL member -- not just the DINT "Control"
  // field TIMER/COUNTER overlay. JS has no int/float distinction at runtime
  // (typeof 0.0 === "number", same as typeof 0), so `typeof targetVal ===
  // "number"` would wrongly bit-extract a REAL's IEEE-754 bits and silently
  // add EN/CT/CL/... keys Python's dict never has for this tag. Instead,
  // look up the target member's own *declared* type: only a scalar integer
  // primitive (never REAL/LREAL, an array, or a struct) passes, matching
  // which decoded values are Python `int` vs `float`/`list`/`dict`.
  const memberByName = new Map(dataType.members.map((m) => [m.name, m]));
  for (const member of dataType.members) {
    if (member.dataType !== "BIT") continue;
    const targetMember = memberByName.get(member.target);
    const targetIsIntPrim =
      targetMember !== undefined &&
      targetMember.dimension === 0 &&
      PRIM[targetMember.dataType.toUpperCase()] !== undefined &&
      !isFloatType(targetMember.dataType.toUpperCase());
    if (!targetIsIntPrim) continue;
    const targetVal = result[member.target];
    if (typeof targetVal === "number" && member.bitNumber !== null && member.bitNumber !== undefined) {
      result[member.name] = (targetVal >> member.bitNumber) & 1;
    }
  }

  return result;
}

function decodeScalarMember(blob, offset, dataType, dataTypesMap, depth, bitNumber = null) {
  const mdtUpper = dataType.toUpperCase();
  const prim = PRIM[mdtUpper];
  if (prim !== undefined) {
    if (offset + prim.size <= blob.length) {
      const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
      let val = prim.get(dv, offset);
      if (bitNumber !== null && bitNumber !== undefined && mdtUpper === "BOOL") {
        val = (val >> bitNumber) & 1;
      }
      return val;
    }
    // -0 sentinel: mirrors Python's out-of-bounds fallback (`return 0`),
    // which is always a plain int regardless of dataType -- see the note on
    // the array fallback in readTagInitialValue above for why this matters
    // for REAL/LREAL members specifically.
    return -0;
  }

  if (isStringFamilyType(mdtUpper, dataTypesMap)) {
    return decodeStringFamilyValue(blob, offset, dataType, dataTypesMap);
  }

  const dtObj = dataTypesMap.get(mdtUpper);
  if (dtObj !== undefined && depth <= 3) {
    return decodeSingleUdtElement(blob, offset, dtObj, dataTypesMap, depth + 1);
  }

  return null;
}

function countArrayElements(dimensions) {
  if (!dimensions) return 1;
  try {
    const parts = dimensions
      .split(",")
      .filter((d) => /^\d+$/.test(d.trim()))
      .map((d) => parseInt(d, 10));
    let count = 1;
    for (const p of parts) count *= p;
    return Math.max(count, 1);
  } catch (e) {
    return 1;
  }
}

function buildCommentsXml(tagName, comments) {
  const parts = [];
  for (const [ref, text] of comments) {
    if (!ref || ref === "." || !text) continue;
    if (ref.startsWith(".!") || ref.startsWith("!")) continue;
    if (!ref.startsWith(tagName)) continue;
    const operand = ref.slice(tagName.length);
    if (!operand) continue;
    const safeText = sanitizeXmlText(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
    parts.push(`<Comment Operand="${operand.toUpperCase()}">\n<![CDATA[${safeText}]]>\n</Comment>\n`);
  }
  if (!parts.length) return "";
  return `<Comments>\n${parts.join("")}</Comments>\n`;
}

module.exports = {
  escapeXmlAttr,
  multilineXmlText,
  isFloatType,
  isGenuineFloat,
  sanitizeXmlText,
  toXmlAttrName,
  L5xElement,
  LIST_SECTION_NAMES,
  Member,
  newMember,
  DataType,
  PRIMITIVE_RADIX,
  PRIMITIVE_DECORATED_ZERO,
  PRIMITIVE_L5K_ZERO,
  BUILTIN_STRUCT_MEMBERS,
  SKIP_DECORATED,
  PRIM,
  STRING_SIZE,
  l5kPrimLiteral,
  l5kArrayLiteral,
  l5kUdtLiteral,
  l5kRealLiteral,
  shortestFloat32Repr,
  decoratedRealLiteral,
  memberDecoratedXml,
  arrayMemberXml,
  structMembersXml,
  generateDecorated,
  decoratedBinaryLiteral,
  udtScalarToXml,
  udtArrayToXml,
  stringLiteralCdata,
  l5kStringPadded,
  isStringFamilyType,
  stringFamilyCapacity,
  getTypeSize,
  tagValueBlobOffset,
  readTagInitialValue,
  decodeUdtInitialValue,
  decodeStringFamilyValue,
  decodeSingleUdtElement,
  decodeScalarMember,
  countArrayElements,
  buildCommentsXml,
};
