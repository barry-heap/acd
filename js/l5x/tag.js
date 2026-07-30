// Port of acd/l5x/elements.py's Tag class (lines 1587-1891 of the Python file).
const {
  L5xElement,
  multilineXmlText,
  sanitizeXmlText,
  isStringFamilyType,
  stringFamilyCapacity,
  l5kStringPadded,
  stringLiteralCdata,
  l5kUdtLiteral,
  udtScalarToXml,
  udtArrayToXml,
  l5kArrayLiteral,
  decoratedRealLiteral,
  l5kRealLiteral,
  PRIMITIVE_RADIX,
  PRIMITIVE_L5K_ZERO,
  PRIM,
  SKIP_DECORATED,
  generateDecorated,
  buildCommentsXml,
  isFloatType,
  isGenuineFloat,
} = require("./render");

class Tag extends L5xElement {
  constructor(name, tagType, dataType, radix, externalAccess, constant, dimensions, opts = {}) {
    super();
    this.name = name;
    this.tagType = tagType;
    this.dataType = dataType;
    this.radix = radix;
    this.externalAccess = externalAccess;
    this.constant = constant;
    this.dimensions = dimensions;
    this.target = opts.target ?? null;
    this._dataTableInstance = opts.dataTableInstance || 0;
    this._comments = opts.comments || []; // [ [ref, text], ... ]
    this._initialValue = opts.initialValue ?? null;
    this._dataTypesMap = opts.dataTypesMap || new Map();
    this._exportName = "Tag";
    if (this.tagType === "Alias") {
      this._xmlAttrOverrides = { tag_type: "TagType", target: "AliasFor" };
    }
  }

  get description() {
    const raw = this._comments.find(([p]) => p === "");
    if (raw === undefined) return null;
    return raw[1]
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .join(" ")
      .trim();
  }

  get _l5xExclude() {
    const n = this.name;
    return (
      !n ||
      !(/[A-Za-z]/.test(n[0]) || n[0] === "_") ||
      n.includes(":") ||
      n.startsWith("__l0") ||
      n.startsWith("__CLONE")
    );
  }

  toXml() {
    let base = super.toXml();

    if (this.dimensions) {
      base = base.replace(`Dimensions="${this.dimensions}"`, `Dimensions="${this.dimensions.replace(/,/g, " ")}"`);
    }

    if (this.tagType === "Alias" && this.dataType) {
      base = base.replace(new RegExp(`\\s*DataType="${this.dataType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), "");
    }

    // --- Description ---
    const candidates = this._comments.filter(([ref, text]) => (ref === "" || ref === ".") && text).map(([, t]) => t);
    let descRaw = candidates.length ? candidates.reduce((a, b) => (b.length > a.length ? b : a)) : null;
    if (descRaw !== null) descRaw = multilineXmlText(descRaw);
    const desc = descRaw ? sanitizeXmlText(descRaw) : null;
    const descXml = desc ? `<Description>\n<![CDATA[${desc}]]>\n</Description>` : "";

    // --- Data ---
    let dataXml = "";
    const isAlias = this.tagType === "Alias";

    if (!isAlias && this._initialValue !== null && this._initialValue !== undefined) {
      const dtBase = this.dataType ? this.dataType.split("[")[0].toUpperCase() : "";
      const iv = this._initialValue;

      if (!this.dimensions && typeof iv === "object" && !Array.isArray(iv) && isStringFamilyType(dtBase, this._dataTypesMap)) {
        const length = iv.LEN ?? 0;
        const text = iv.DATA ?? "";
        const cap = stringFamilyCapacity(dtBase, this._dataTypesMap);
        const l5kBody = `[${length},${l5kStringPadded(text, cap)}]`;
        dataXml =
          `<Data Format="L5K">\n<![CDATA[${l5kBody}]]>\n</Data>` +
          `<Data Format="String" Length="${length}">\n${stringLiteralCdata(text)}\n</Data>`;
      } else if (typeof iv === "object" && !Array.isArray(iv) && iv !== null) {
        const dtObj = this._dataTypesMap.get(dtBase.toUpperCase());
        const displayName = dtObj !== undefined ? dtObj.name : dtBase;
        const l5kUdtVal = l5kUdtLiteral(dtBase, iv, this._dataTypesMap);
        const body = `<Structure DataType="${displayName}">${udtScalarToXml(dtBase, iv, this._dataTypesMap)}</Structure>`;
        dataXml = `<Data Format="L5K">\n<![CDATA[${l5kUdtVal}]]>\n</Data>` + `<Data Format="Decorated">\n${body}\n</Data>`;
      } else if (Array.isArray(iv) && iv.length && typeof iv[0] === "object") {
        const dimStr = this.dimensions || "1";
        const body = udtArrayToXml(dtBase, iv, dimStr, this._dataTypesMap);
        if (body) {
          const l5kUdtVal = l5kUdtLiteral(dtBase, iv, this._dataTypesMap);
          dataXml = `<Data Format="L5K">\n<![CDATA[${l5kUdtVal}]]>\n</Data>` + `<Data Format="Decorated">\n${body}\n</Data>`;
        }
      } else if (PRIM[dtBase] !== undefined) {
        const radixAttr = PRIMITIVE_RADIX[dtBase] || "Decimal";

        if (Array.isArray(iv)) {
          const fmtElemVal = (val) => {
            if (dtBase === "BOOL" || dtBase === "BIT") return val ? "1" : "0";
            if (isGenuineFloat(dtBase, val)) return decoratedRealLiteral(val, true);
            return String(Math.trunc(val));
          };
          const elems = iv.map((v, i) => `<Element Index="[${i}]" Value="${fmtElemVal(v)}"/>`).join("");
          const dimStr = this.dimensions || "1";
          const l5kArrayVal = l5kArrayLiteral(dtBase, iv);
          dataXml =
            `<Data Format="L5K">\n<![CDATA[${l5kArrayVal}]]>\n</Data>` +
            `<Data Format="Decorated">\n` +
            `<Array DataType="${dtBase}" Dimensions="${dimStr}" Radix="${radixAttr}">${elems}</Array>\n` +
            `</Data>`;
        } else {
          let valStr;
          let l5kVal;
          if (dtBase === "BOOL" || dtBase === "BIT") {
            valStr = iv ? "1" : "0";
            l5kVal = valStr;
          } else if (isGenuineFloat(dtBase, iv)) {
            valStr = decoratedRealLiteral(iv, false);
            l5kVal = l5kRealLiteral(iv);
          } else {
            valStr = String(Math.trunc(iv));
            l5kVal = valStr;
          }
          dataXml =
            `<Data Format="L5K">\n<![CDATA[${l5kVal}]]>\n</Data>` +
            `<Data Format="Decorated">\n<DataValue DataType="${dtBase}" Radix="${radixAttr}" Value="${valStr}"/>\n</Data>`;
        }
      }
    }

    if (!dataXml && !isAlias) {
      const dtBase = this.dataType ? this.dataType.split("[")[0].toUpperCase() : "";
      const l5kZero = !this.dimensions ? PRIMITIVE_L5K_ZERO[dtBase] : undefined;
      if (l5kZero !== undefined) {
        const zeroRadix = PRIMITIVE_RADIX[dtBase] || "Decimal";
        dataXml =
          `<Data Format="L5K">\n<![CDATA[${l5kZero}]]>\n</Data>` +
          `<Data Format="Decorated">\n<DataValue DataType="${dtBase}" Radix="${zeroRadix}" Value="${l5kZero}"/>\n</Data>`;
      } else {
        dataXml = "";
      }

      if (!dataXml && !SKIP_DECORATED.has(dtBase) && dtBase !== "STRING") {
        const decorated = generateDecorated(dtBase, this.dimensions, this._dataTypesMap, this.name, this._comments);
        if (decorated) dataXml = decorated;
      }
    }

    const commentsXml = this._comments.length ? buildCommentsXml(this.name, this._comments) : "";

    if (!descXml && !commentsXml && !dataXml) return base;

    const idx = base.indexOf(">");
    return base.slice(0, idx + 1) + descXml + commentsXml + dataXml + base.slice(idx + 1);
  }
}

module.exports = { Tag };
