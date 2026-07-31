// Port of acd/l5x/elements.py's remaining L5xElement subclasses (Python
// lines ~1894-2430): LocalTag, Parameter, Module, Routine, AOI, Program,
// ScheduledProgram, EventInfo, Task, Controller, RSLogix5000Content.
const { PORT_STRUCTURES } = require("./port_structures");
const { L5xElement, multilineXmlText, escapeXmlAttr } = require("./render");

class LocalTag extends L5xElement {
  constructor(name, dataType, dimensions, radix, externalAccess, opts = {}) {
    super();
    this.name = name;
    this.dataType = dataType;
    this.dimensions = dimensions;
    this.radix = radix;
    this.externalAccess = externalAccess;
    this._description = opts.description ?? null;
    this._exportName = "LocalTag";
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
    const base = super.toXml();
    if (!this._description) return base;
    const desc = multilineXmlText(this._description);
    const descXml = `<Description>\n<![CDATA[${desc}]]>\n</Description>`;
    const idx = base.indexOf(">");
    return base.slice(0, idx + 1) + descXml + base.slice(idx + 1);
  }
}

class Parameter extends L5xElement {
  constructor(name, tagType, dataType, usage, radix, required, visible, externalAccess, constant, dimensions, opts = {}) {
    super();
    this.name = name;
    this.tagType = tagType;
    this.dataType = dataType;
    this.usage = usage;
    this.radix = radix;
    this.required = required;
    this.visible = visible;
    this.externalAccess = externalAccess;
    this.constant = constant;
    this.dimensions = dimensions;
    this._description = opts.description ?? null;
    this._exportName = "Parameter";
  }

  get _l5xExclude() {
    const n = this.name;
    return !n || !(/[A-Za-z]/.test(n[0]) || n[0] === "_");
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

class Module extends L5xElement {
  constructor(name, catalogNumber, vendor, productType, productCode, major, minor, parentModule, parentModPortId, inhibited, majorFault, opts = {}) {
    super();
    this.name = name;
    this.catalogNumber = catalogNumber;
    this.vendor = vendor;
    this.productType = productType;
    this.productCode = productCode;
    this.major = major;
    this.minor = minor;
    this.parentModule = parentModule;
    this.parentModPortId = parentModPortId;
    this.inhibited = inhibited;
    this.majorFault = majorFault;
    this._ekeyState = opts.ekeyState ?? "CompatibleModule";
    this._slot = opts.slot ?? 0;
    this._ipAddress = opts.ipAddress ?? "";
    this._backplaneSlot = opts.backplaneSlot ?? null;
    this._chassisSize = opts.chassisSize ?? null;
    this._portChildCounts = opts.portChildCounts || new Map();
    this._description = opts.description ?? "";
    this._commMethod = opts.commMethod ?? null;
    this._connections = opts.connections || []; // [[name, rpiStr, connType], ...]
    this._extendedProperties = opts.extendedProperties ?? "";
    this._exportName = "Module";
  }

  toXml() {
    const nameAttr = this.name === "?" ? "" : `Name="${this.name}" `;
    const attrs =
      `${nameAttr}` +
      `CatalogNumber="${this.catalogNumber}" ` +
      `Vendor="${this.vendor}" ` +
      `ProductType="${this.productType}" ` +
      `ProductCode="${this.productCode}" ` +
      `Major="${this.major}" ` +
      `Minor="${this.minor}" ` +
      `ParentModule="${this.parentModule}" ` +
      `ParentModPortId="${this.parentModPortId}" ` +
      `Inhibited="${this.inhibited}" ` +
      `MajorFault="${this.majorFault}"`;

    let descXml = "";
    if (this._description) {
      const desc = multilineXmlText(this._description);
      descXml = `<Description>\n<![CDATA[${desc}]]>\n</Description>`;
    }

    const ekey = `<EKey State="${this._ekeyState}"/>`;
    const ports = this._buildPortsXml();

    let commXml = "";
    if (this._commMethod !== null) {
      const connParts = [];
      for (const [connName, rpiStr, connType] of this._connections) {
        const safeName = escapeXmlAttr(connName);
        let tagStubs;
        if (connType === "Output") {
          tagStubs = '<OutputTag ExternalAccess="Read/Write"><Comments/></OutputTag>';
        } else {
          tagStubs =
            '<InputTag ExternalAccess="Read Only"><Comments/></InputTag>' +
            '<OutputTag ExternalAccess="Read/Write"><Comments/></OutputTag>';
        }
        connParts.push(
          `<Connection Name="${safeName}" RPI="${rpiStr}" Type="${connType}"` +
            ` EventID="0" ProgrammaticallySendEventTrigger="false" Unicast="false">` +
            `${tagStubs}</Connection>`,
        );
      }
      const joined = connParts.join("");
      const connectionsXml = joined ? `<Connections>${joined}</Connections>` : "<Connections/>";
      commXml = `<Communications CommMethod="${this._commMethod}">${connectionsXml}</Communications>`;
    }

    let extXml = "";
    if (this._extendedProperties) {
      extXml = `<ExtendedProperties><public>${this._extendedProperties}</public></ExtendedProperties>`;
    }

    return `<Module ${attrs}>${descXml}${ekey}${ports}${commXml}${extXml}</Module>`;
  }

  _buildPortsXml() {
    const key = `${this.vendor},${this.productType},${this.productCode}`;
    const portDefs = PORT_STRUCTURES.get(key);
    if (portDefs === undefined) return "<Ports/>";

    const isRoot = this.majorFault === "true";
    const portParts = [];

    for (const pd of portDefs) {
      let upstreamStr;
      if (isRoot) {
        upstreamStr = "false";
      } else if (pd.upstreamFixed) {
        upstreamStr = pd.upstreamPort ? "true" : "false";
      } else {
        upstreamStr = pd.portId === this.parentModPortId ? "true" : "false";
      }

      let addrAttr;
      if (pd.addressMode === "omit") {
        addrAttr = "";
      } else if (pd.addressMode === "slot") {
        if (upstreamStr === "false" && this._backplaneSlot !== null) {
          addrAttr = ` Address="${this._backplaneSlot}"`;
        } else {
          addrAttr = ` Address="${this._slot !== 0xffffffff ? this._slot : 0}"`;
        }
      } else if (pd.addressMode === "zero") {
        addrAttr = ' Address="0"';
      } else {
        addrAttr = ` Address="${this._ipAddress}"`;
      }

      const isUpstream = upstreamStr === "true";
      const busXml = this._busXml(pd, isUpstream);

      if (busXml) {
        portParts.push(`<Port Id="${pd.portId}"${addrAttr} Type="${pd.portType}" Upstream="${upstreamStr}">\n${busXml}\n</Port>\n`);
      } else {
        portParts.push(`<Port Id="${pd.portId}"${addrAttr} Type="${pd.portType}" Upstream="${upstreamStr}"/>\n`);
      }
    }

    return `<Ports>\n${portParts.join("")}</Ports>\n`;
  }

  _busXml(pd, isUpstream) {
    if (isUpstream) return "";
    const mode = pd.busMode;
    if (mode === "none") return "";
    if (mode === "always") return "<Bus/>";
    if (mode.startsWith("fixed:")) {
      if (this._chassisSize !== null) return `<Bus Size="${this._chassisSize}"/>`;
      const size = mode.split(":")[1];
      return `<Bus Size="${size}"/>`;
    }
    if (mode === "children_or_none") {
      let childCount = this._portChildCounts.get(pd.portId) || 0;
      if (this._chassisSize !== null) childCount = Math.max(childCount, this._chassisSize);
      if (childCount === 0) return "";
      return `<Bus Size="${childCount}"/>`;
    }
    let childCount = this._portChildCounts.get(pd.portId) || 0;
    if (this._chassisSize !== null) childCount = Math.max(childCount, this._chassisSize);
    return `<Bus Size="${childCount}"/>`;
  }
}

// Return the name of the Nth (0-based, in declaration order) BOOL-typed
// field of a DataType's `members` or an AOI's `parameters` array -- the
// resolution mechanism for fbdResolveSource's bit-packed pseudo-tag case
// (see that function's comment). Only a real declared BOOL field counts --
// a UDT's own hidden bit-overlay backing field (typically DINT/SINT) and
// its BIT-type pseudo-members are both a different dataType value and so
// are correctly skipped by this same filter. Verified against a real
// project (RefProjA_V33_R17_4.ACD): an AOI-instance tag's compiled FBD
// feed's bit index N is the Nth BOOL-typed Parameter of that AOI, counting
// only BOOL fields -- e.g. AOI_VALVE's bit 19/20/27/11/17 are its
// OpenLS/CloseLS/Mismatch/Opening/Closing parameters respectively, only
// once non-BOOL parameters (DINT/INT/FBD_TIMER) are excluded from the count.
function fbdBoolFieldByIndex(fields, bitIndex) {
  const boolFields = fields.filter((f) => f.dataType === "BOOL");
  return bitIndex >= 0 && bitIndex < boolFields.length ? boolFields[bitIndex].name : null;
}

// Build a (memberChain, bitIndex) -> friendlyName resolver for
// fbdResolveSource, closing over one routine's own name resolution scope
// (tagDtype: tag name -> DataType/AOI name, already merged controller+
// program or controller+AOI per caller). memberChain is the "Tag.
// BackingField" text fbdResolveSource already has in hand (the backing
// field's own name is informational only -- not used, since the
// resolution mechanism is purely positional, see fbdBoolFieldByIndex).
function fbdMakeBitResolver(tagDtype, aoiByName, dataTypesMap) {
  return function resolve(memberChain, bitIndex) {
    const lastDot = memberChain.lastIndexOf(".");
    if (lastDot < 0) return null;
    const tagName = memberChain.slice(0, lastDot);
    const dtype = tagDtype.get(tagName);
    if (!dtype) return null;
    const aoi = aoiByName.get(dtype);
    let fields = aoi ? aoi.parameters : null;
    if (!fields) {
      const dt = dataTypesMap.get(dtype.toUpperCase());
      fields = dt ? dt.members : null;
    }
    if (!fields) return null;
    const name = fbdBoolFieldByIndex(fields, bitIndex);
    return name !== null ? `${tagName}.${name}` : null;
  };
}

// Resolve one FBD wire's source expression back to its real tag. A
// pseudo-tag can be referenced with a trailing numeric bit-index (e.g.
// "__l2621AF94E947AB0D.19") when several boolean IRefs are packed into one
// word-sized feed -- the base pseudo-tag resolves via irefFeeds same as any
// other; the bit INDEX is then further resolved to its real friendly field
// name via bitResolver (see fbdMakeBitResolver), if one is supplied and the
// resolution succeeds -- otherwise left as "RealTag.__BitHost00.19",
// traceable back to a real tag and a real bit position, just not the
// friendly name. See CLAUDE.md's "FBD" section for the full explanation.
function fbdResolveSource(src, irefFeeds, bitResolver) {
  if (irefFeeds.has(src)) return irefFeeds.get(src);
  if (src.includes(".")) {
    const dotIdx = src.indexOf(".");
    const base = src.slice(0, dotIdx);
    const suffix = src.slice(dotIdx + 1);
    if (irefFeeds.has(base)) {
      const resolvedBase = irefFeeds.get(base);
      if (bitResolver && /^\d+$/.test(suffix)) {
        const friendly = bitResolver(resolvedBase, parseInt(suffix, 10));
        if (friendly !== null) return friendly;
      }
      return `${resolvedBase}.${suffix}`;
    }
  }
  return src;
}

// Flatten every block's own wiresIn into [source, "Op.Pin"] pairs,
// resolving pseudo-tags back to their real feeder source.
function fbdResolveWires(blocks, irefFeeds, bitResolver) {
  const resolved = [];
  for (const info of blocks.values()) {
    for (const [dst, src] of info.wiresIn) {
      resolved.push([fbdResolveSource(src, irefFeeds, bitResolver), dst]);
    }
  }
  return resolved;
}

// Split a wire endpoint into [operand, pin]. A dot alone doesn't mean
// "block pin" -- an IRef/ORef's own Operand can legitimately be a
// tag.member reference (e.g. "TANK16_RET.CloseLS"), which must stay intact.
// Only split at the LAST dot, and only when the part before it is a name
// already known to be a block operand; otherwise the whole string is the
// operand with no pin at all.
function fbdSplitPinRef(ref, blocks) {
  const lastDot = ref.lastIndexOf(".");
  if (lastDot >= 0) {
    const op = ref.slice(0, lastDot);
    const pin = ref.slice(lastDot + 1);
    if (blocks.has(op)) return [op, pin];
  }
  return [ref, null];
}

// Render a decoded FBD block/wire graph as <FBDContent><Sheet>... XML. IDs
// are assigned deterministically (sorted by operand/tag name within each
// element kind) since Studio's own arbitrary numbering isn't recoverable;
// X/Y positions are a simple synthetic grid, not Studio's own layout --
// exact sheet layout fidelity and Studio's own element IDs are explicitly
// out of scope (see CLAUDE.md's "FBD" section). VisiblePins lists only the
// pins this decode actually observed wired, plus (for an AOI instance) its
// own InOut parameter names.
//
// A block whose own mnemonic matches a real project AOI's name (looked up
// in aoiInoutOrder, keyed upper-case) is an AOI instance, not a built-in
// FBD instruction -- rendered as <AddOnInstruction Name="..."> with
// <InOutParameter Name="..." Argument="..."/> children, a completely
// different L5X shape from a built-in instruction's plain <Block>/<Wire>
// pin wiring.
// VisiblePins is a fixed default set PER BUILT-IN INSTRUCTION TYPE, baked
// into Studio 5000 itself -- NOT the set of pins actually wired in this
// specific instance, which earlier rounds assumed. Confirmed by extracting
// every real <Block Type="..." VisiblePins="..."> from two independent
// ground-truth projects: 12 of the 13 built-in types seen have an
// IDENTICAL VisiblePins string across every real instance of that type
// project-wide. ALMA is the one exception (varies with which alarm limits
// that specific instance has enabled) and is deliberately left out,
// falling back to the observed-wired behavior below -- a real, open gap,
// not silently guessed at. See CLAUDE.md's "FBD" section for the full
// story of how this was found (a real PLC-Studio load treating the whole
// routine as unrecognized, not just rendering it wrong).
const FBD_BLOCK_DEFAULT_VISIBLE_PINS = new Map([
  ["ADD", "SourceA SourceB Dest"],
  ["BNOT", "In Out"],
  [
    "D2SD",
    "ProgCommand State0Perm State1Perm FB0 FB1 HandFB ProgProgReq ProgOperReq " +
      "ProgOverrideReq ProgHandReq Out Device0State Device1State CommandStatus FaultAlarm " +
      "ModeAlarm ProgOper Override Hand",
  ],
  ["DEDT", "In Out"],
  ["GRT", "SourceA SourceB Dest"],
  ["HLL", "In Out HighAlarm LowAlarm"],
  ["LDLG", "In Out"],
  ["MUL", "SourceA Dest"],
  [
    "PIDE",
    "PV SPProg SPCascade RatioProg CVProg FF HandFB ProgProgReq ProgOperReq ProgCasRatReq " +
      "ProgAutoReq ProgManualReq ProgOverrideReq ProgHandReq CVEU SP PVHHAlarm PVHAlarm PVLAlarm " +
      "PVLLAlarm PVROCPosAlarm PVROCNegAlarm DevHHAlarm DevHAlarm DevLAlarm DevLLAlarm ProgOper " +
      "CasRat Auto Manual Override Hand",
  ],
  ["RLIM", "In IncRate DecRate ByPass Out"],
  ["SCL", "In InRawMax InRawMin InEUMax InEUMin Limiting Out MaxAlarm MinAlarm"],
  ["SUB", "SourceA SourceB Dest"],
  ["TONR", "TimerEnable PRE Reset ACC DN"],
]);

// sheetLayout, when given, is the {sheets, operandToSheet, connectorFeed,
// feedbackPairs} object from fbdDecodeSheets() (js/l5x/builders.js) -- see
// that function's comment and CLAUDE.md's "Multi-sheet FBD" section for
// the full mechanism. When undefined/null (or a routine's layout metadata
// couldn't be found), everything renders onto a single <Sheet Number="1">
// with no description, identical to this function's original single-
// sheet-only behavior -- the multi-sheet code path below reduces to
// exactly that when there is only one sheet and no operand is assigned to
// any other, so there is deliberately only one implementation of the
// element/wire rendering logic, not two parallel ones.
function renderFbdContent(blocks, irefFeeds, orefWrites, aoiInoutOrder, bitResolver, sheetLayout) {
  aoiInoutOrder = aoiInoutOrder || new Map();
  const wires = fbdResolveWires(blocks, irefFeeds, bitResolver);

  const blockPinsSeen = new Map();
  for (const [, dst] of wires) {
    const [op, pin] = fbdSplitPinRef(dst, blocks);
    if (pin === null) continue;
    if (!blockPinsSeen.has(op)) blockPinsSeen.set(op, []);
    if (!blockPinsSeen.get(op).includes(pin)) blockPinsSeen.get(op).push(pin);
  }

  const orefDsts = new Set(orefWrites.map(([, dst]) => dst));
  const allWireEndpoints = [
    ...wires.map(([src]) => src),
    ...wires.map(([, dst]) => dst),
    ...orefWrites.map(([src]) => src),
    ...orefWrites.map(([, dst]) => dst),
  ];
  const irefOperands = [
    ...new Set(
      allWireEndpoints
        .map((ref) => fbdSplitPinRef(ref, blocks)[0])
        .filter((op) => !blocks.has(op) && !orefDsts.has(op)),
    ),
  ].sort();
  const orefOperands = [...orefDsts].sort();
  const blockOperands = [...blocks.keys()].sort();

  const sheetsMeta = sheetLayout ? sheetLayout.sheets : [{ number: 1, description: null }];
  const operandToSheet = sheetLayout ? sheetLayout.operandToSheet : new Map();
  const connectorFeed = sheetLayout ? sheetLayout.connectorFeed : new Map();
  const feedbackPairs = sheetLayout ? sheetLayout.feedbackPairs : new Set();
  const defaultSheet = sheetsMeta[0].number;
  const sheetOf = (op) => (operandToSheet.has(op) ? operandToSheet.get(op) : defaultSheet);

  const idMap = new Map();
  let nextId = 0;
  for (const op of [...irefOperands, ...orefOperands, ...blockOperands]) {
    idMap.set(op, nextId);
    nextId += 1;
  }

  // Each named connector needs two DIFFERENT rendered elements (an OCon on
  // its feeder's sheet, an ICon on its consumer's sheet) sharing one Name
  // but each its own ID -- keyed internally as "__conn__<name>__<role>" so
  // it can never collide with a real operand name.
  const connectorInstances = []; // [key, name, role, sheetNumber]
  for (const [name, feed] of connectorFeed) {
    const feederSheet = feed.feederSheet;
    const consumerSheet = feed.consumerSheet;
    if (feederSheet === undefined || consumerSheet === undefined) {
      console.warn(`renderFbdContent: connector ${JSON.stringify(name)} missing its feeder or consumer side; skipping`);
      continue;
    }
    for (const [role, sheetNumber] of [["OCon", feederSheet], ["ICon", consumerSheet]]) {
      const key = `__conn__${name}__${role}`;
      idMap.set(key, nextId);
      nextId += 1;
      connectorInstances.push([key, name, role, sheetNumber]);
    }
  }

  const connectorFor = (srcOp, dstOp) => {
    for (const [name, feed] of connectorFeed) {
      if (feed.feederOperand === srcOp && feed.consumerOperand === dstOp) return name;
    }
    console.warn(`renderFbdContent: no connector found linking sheet-crossing ${JSON.stringify(srcOp)} -> ${JSON.stringify(dstOp)}; dropping wire`);
    return null;
  };

  // Classify every wire/oref-write as same-sheet (one ordinary <Wire>/
  // <FeedbackWire>) or cross-sheet (needs an OCon/ICon pair instead) --
  // the compiled network itself has no notion of "sheet" at all, so this
  // decision comes entirely from operandToSheet.
  const perSheetWiresXml = new Map(sheetsMeta.map((s) => [s.number, []]));
  for (const [src, dst] of wires) {
    const [dstOp, dstPin] = fbdSplitPinRef(dst, blocks);
    const toId = idMap.has(dstOp) ? idMap.get(dstOp) : null;
    if (toId === null || dstPin === null) {
      console.warn(`renderFbdContent: could not resolve block-input wire destination ${JSON.stringify(dst)}; dropping wire`);
      continue;
    }
    const [srcOp, srcPin] = fbdSplitPinRef(src, blocks);
    const fromId = idMap.has(srcOp) ? idMap.get(srcOp) : null;
    if (fromId === null) continue;
    const fromParamXml = srcPin ? ` FromParam="${escapeXmlAttr(srcPin)}"` : "";
    const srcSheet = sheetOf(srcOp);
    const dstSheet = sheetOf(dstOp);
    const wireTag = feedbackPairs.has(`${srcOp} ${dstOp}`) ? "FeedbackWire" : "Wire";
    if (srcSheet === dstSheet) {
      perSheetWiresXml.get(srcSheet).push(`<${wireTag} FromID="${fromId}"${fromParamXml} ToID="${toId}" ToParam="${escapeXmlAttr(dstPin)}"/>`);
      continue;
    }
    const name = connectorFor(srcOp, dstOp);
    if (name === null) continue;
    const oconId = idMap.get(`__conn__${name}__OCon`);
    const iconId = idMap.get(`__conn__${name}__ICon`);
    if (oconId === undefined || iconId === undefined) continue;
    perSheetWiresXml.get(srcSheet).push(`<${wireTag} FromID="${fromId}"${fromParamXml} ToID="${oconId}"/>`);
    perSheetWiresXml.get(dstSheet).push(`<${wireTag} FromID="${iconId}" ToID="${toId}" ToParam="${escapeXmlAttr(dstPin)}"/>`);
  }
  for (const [src, dst] of orefWrites) {
    const toId = idMap.has(dst) ? idMap.get(dst) : null;
    if (toId === null) continue;
    const [srcOp, srcPin] = fbdSplitPinRef(src, blocks);
    const fromId = idMap.has(srcOp) ? idMap.get(srcOp) : null;
    if (fromId === null) continue;
    const fromParamXml = srcPin ? ` FromParam="${escapeXmlAttr(srcPin)}"` : "";
    const srcSheet = sheetOf(srcOp);
    const dstSheet = sheetOf(dst);
    const wireTag = feedbackPairs.has(`${srcOp} ${dst}`) ? "FeedbackWire" : "Wire";
    if (srcSheet === dstSheet) {
      perSheetWiresXml.get(srcSheet).push(`<${wireTag} FromID="${fromId}"${fromParamXml} ToID="${toId}"/>`);
      continue;
    }
    const name = connectorFor(srcOp, dst);
    if (name === null) continue;
    const oconId = idMap.get(`__conn__${name}__OCon`);
    const iconId = idMap.get(`__conn__${name}__ICon`);
    if (oconId === undefined || iconId === undefined) continue;
    perSheetWiresXml.get(srcSheet).push(`<${wireTag} FromID="${fromId}"${fromParamXml} ToID="${oconId}"/>`);
    perSheetWiresXml.get(dstSheet).push(`<${wireTag} FromID="${iconId}" ToID="${toId}"/>`);
  }

  const sheetsXml = [];
  for (const sheetMeta of sheetsMeta) {
    const sheetNumber = sheetMeta.number;
    const elementsXml = [];
    let x = 100;
    for (const op of irefOperands) {
      if (sheetOf(op) !== sheetNumber) continue;
      elementsXml.push(`<IRef ID="${idMap.get(op)}" X="${x}" Y="100" Operand="${escapeXmlAttr(op)}" HideDesc="false"/>`);
      x += 120;
    }
    x = 100;
    for (const op of orefOperands) {
      if (sheetOf(op) !== sheetNumber) continue;
      elementsXml.push(`<ORef ID="${idMap.get(op)}" X="${x}" Y="700" Operand="${escapeXmlAttr(op)}" HideDesc="false"/>`);
      x += 120;
    }
    x = 100;
    for (const [key, name, role, connSheet] of connectorInstances) {
      if (connSheet !== sheetNumber) continue;
      const tagName = role === "OCon" ? "OCon" : "ICon";
      elementsXml.push(`<${tagName} ID="${idMap.get(key)}" X="${x}" Y="${role === "OCon" ? 280 : 140}" Name="${escapeXmlAttr(name)}"/>`);
      x += 120;
    }
    x = 100;
    for (const op of blockOperands) {
      if (sheetOf(op) !== sheetNumber) continue;
      const info = blocks.get(op);
      const inoutNames = aoiInoutOrder.get(info.type.toUpperCase());
      if (inoutNames !== undefined) {
        const extraArgs = info.extraArgs || [];
        const inoutXml = inoutNames
          .map((pname, i) => (i < extraArgs.length ? [pname, extraArgs[i]] : null))
          .filter(Boolean)
          .map(([pname, arg]) => `<InOutParameter Name="${escapeXmlAttr(pname)}" Argument="${escapeXmlAttr(arg)}"/>`)
          .join("");
        const visiblePins = [...(blockPinsSeen.get(op) || []), ...inoutNames].join(" ");
        elementsXml.push(
          `<AddOnInstruction Name="${escapeXmlAttr(info.type)}" ID="${idMap.get(op)}" X="${x}" Y="400" ` +
            `Operand="${escapeXmlAttr(op)}" VisiblePins="${escapeXmlAttr(visiblePins)}">${inoutXml}</AddOnInstruction>`,
        );
      } else {
        const defaultPins = FBD_BLOCK_DEFAULT_VISIBLE_PINS.get(info.type.toUpperCase());
        const visiblePins = defaultPins !== undefined ? defaultPins : (blockPinsSeen.get(op) || []).join(" ");
        // A built-in instruction's compiled call can carry an extra
        // positional argument beyond its own operand, but its meaning is
        // NOT generic across types (confirmed: DEDT's extra arg is a real
        // tag reference rendering as a genuine <Array Name="StorageArray">
        // child; PIDE's own extra arg is a bare literal that renders as
        // nothing at all in real Studio output) -- scoped narrowly to DEDT
        // until a real ground-truth example shows another type needs it.
        const extraArgs = info.extraArgs || [];
        const arrayXml =
          extraArgs.length && info.type.toUpperCase() === "DEDT"
            ? `<Array Name="StorageArray" Operand="${escapeXmlAttr(extraArgs[0])}"/>`
            : "";
        const openTag =
          `<Block Type="${escapeXmlAttr(info.type)}" ID="${idMap.get(op)}" X="${x}" Y="400" ` +
          `Operand="${escapeXmlAttr(op)}" VisiblePins="${escapeXmlAttr(visiblePins)}" HideDesc="false"`;
        elementsXml.push(arrayXml ? `${openTag}>${arrayXml}</Block>` : `${openTag}/>`);
      }
      x += 200;
    }

    let descXml = "";
    if (sheetMeta.description) {
      descXml = `<Description>\n<![CDATA[${sheetMeta.description}]]>\n</Description>`;
    }
    const body = elementsXml.join("") + perSheetWiresXml.get(sheetNumber).join("");
    sheetsXml.push(`<Sheet Number="${sheetNumber}">${descXml}${body}</Sheet>`);
  }

  return `<FBDContent SheetSize="Letter - 8.5 x 11 in" SheetOrientation="Landscape">${sheetsXml.join("")}</FBDContent>`;
}

class Routine extends L5xElement {
  constructor(name, type, rungs, opts = {}) {
    super();
    this.name = name;
    this.type = type;
    this.rungs = rungs;
    this._rungIds = opts.rungIds || [];
    this._rungComments = opts.rungComments || new Map();
    this._description = opts.description ?? null;
    this._stLines = opts.stLines || [];
    this._fbdNetwork = opts.fbdNetwork || null;
    this._aoiInoutOrder = opts.aoiInoutOrder || new Map();
    this._fbdBitResolver = opts.fbdBitResolver || null;
    this._fbdSheetLayout = opts.fbdSheetLayout || null;
  }

  toXml() {
    let descXml = "";
    if (this._description) {
      const desc = multilineXmlText(this._description);
      descXml = `<Description>\n<![CDATA[${desc}]]>\n</Description>`;
    }

    let content = "";
    if (this.type === "RLL" && this.rungs.length) {
      const rungXmls = [];
      this.rungs.forEach((rungText, i) => {
        const text = (rungText || "").trim();
        if (!text) return;
        let commentXml = "";
        if (this._rungComments.has(i)) {
          const commentText = this._rungComments.get(i).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
          commentXml = `<Comment><![CDATA[${commentText}]]></Comment>`;
        }
        rungXmls.push(`<Rung Number="${i}" Type="N">${commentXml}<Text><![CDATA[${text}]]></Text></Rung>`);
      });
      if (rungXmls.length) content = `<RLLContent>${rungXmls.join("")}</RLLContent>`;
    } else if (this.type === "ST" && this._stLines.length) {
      // Each pair's own local per-group number (already computed by
      // stRoutineLines()/stLineLocalNumbers() in builders.js) is rendered
      // verbatim, NOT re-enumerated here -- see those functions for why it
      // can legitimately repeat within one routine.
      const lineXmls = this._stLines.map(([number, text]) => `<Line Number="${number}"><![CDATA[${text}]]></Line>`);
      content = `<STContent>${lineXmls.join("")}</STContent>`;
    } else if (this.type === "FBD" && this._fbdNetwork) {
      const { blocks, irefFeeds, orefWrites } = this._fbdNetwork;
      if (blocks.size || orefWrites.length) {
        content = renderFbdContent(blocks, irefFeeds, orefWrites, this._aoiInoutOrder, this._fbdBitResolver, this._fbdSheetLayout);
      }
    }
    return `<Routine Name="${escapeXmlAttr(this.name)}" Type="${this.type}">${descXml}${content}</Routine>`;
  }
}

class AOI extends L5xElement {
  constructor(
    name,
    revision,
    revisionExtension,
    vendor,
    executePrescan,
    executePostscan,
    executeEnableInFalse,
    createdDate,
    createdBy,
    editedDate,
    editedBy,
    softwareRevision,
    parameters,
    localTags,
    routines,
    opts = {},
  ) {
    super();
    this.name = name;
    this.revision = revision;
    this.revisionExtension = revisionExtension;
    this.vendor = vendor;
    this.executePrescan = executePrescan;
    this.executePostscan = executePostscan;
    this.executeEnableInFalse = executeEnableInFalse;
    this.createdDate = createdDate;
    this.createdBy = createdBy;
    this.editedDate = editedDate;
    this.editedBy = editedBy;
    this.softwareRevision = softwareRevision;
    this.parameters = parameters;
    this.localTags = localTags;
    this.routines = routines;
    this._description = opts.description ?? null;
    this._revisionNote = opts.revisionNote ?? "";
    this._exportName = "AddOnInstructionDefinition";
  }

  toXml() {
    const base = super.toXml();
    const idx = base.indexOf(">");
    let inject = "";
    if (this._description) {
      const desc = multilineXmlText(this._description);
      inject += `<Description>\n<![CDATA[${desc}]]>\n</Description>`;
    }
    if (this._revisionNote) {
      const note = multilineXmlText(this._revisionNote);
      inject += `<RevisionNote>\n<![CDATA[${note}]]>\n</RevisionNote>`;
    }
    return base.slice(0, idx + 1) + inject + base.slice(idx + 1);
  }
}

class Program extends L5xElement {
  constructor(
    name,
    testEdits,
    mainRoutineName,
    faultRoutineName,
    disabled,
    synchronizeRedundancyDataAfterExecution,
    useAsFolder,
    tags,
    routines,
    opts = {},
  ) {
    super();
    this.name = name;
    this.testEdits = testEdits;
    this.mainRoutineName = mainRoutineName;
    this.faultRoutineName = faultRoutineName;
    this.disabled = disabled;
    this.synchronizeRedundancyDataAfterExecution = synchronizeRedundancyDataAfterExecution;
    this.useAsFolder = useAsFolder;
    this.tags = tags;
    this.routines = routines;
    this._description = opts.description ?? null;
  }

  toXml() {
    const base = super.toXml();
    if (!this._description) return base;
    const idx = base.indexOf(">");
    const desc = multilineXmlText(this._description);
    const inject = `<Description>\n<![CDATA[${desc}]]>\n</Description>`;
    return base.slice(0, idx + 1) + inject + base.slice(idx + 1);
  }
}

class ScheduledProgram extends L5xElement {
  constructor(name) {
    super();
    this.name = name;
    this._exportName = "ScheduledProgram";
  }
}

class EventInfo extends L5xElement {
  constructor(eventTrigger, enableTimeout) {
    super();
    this.eventTrigger = eventTrigger;
    this.enableTimeout = enableTimeout;
    this._exportName = "EventInfo";
  }
}

class Task extends L5xElement {
  constructor(name, type, rate, priority, watchdog, disableUpdateOutputs, inhibitTask, eventInfo, scheduledPrograms) {
    super();
    this.name = name;
    this.type = type;
    this.rate = rate;
    this.priority = priority;
    this.watchdog = watchdog;
    this.disableUpdateOutputs = disableUpdateOutputs;
    this.inhibitTask = inhibitTask;
    this.eventInfo = eventInfo;
    this.scheduledPrograms = scheduledPrograms;
  }
}

class Controller extends L5xElement {
  constructor(fields, opts = {}) {
    super();
    Object.assign(this, fields);
    this._redundancyEnabled = opts.redundancyEnabled || false;
    this._description = opts.description ?? null;
    this._xmlAttrOverrides = {
      sfcExecutionControl: "SFCExecutionControl",
      sfcRestartPosition: "SFCRestartPosition",
      sfcLastScan: "SFCLastScan",
      projectSn: "ProjectSN",
      canUseRpiFromProducer: "CanUseRPIFromProducer",
    };
    this._ioTags = this.tags.filter((t) => t.name.includes(":"));
    this._aliasTags = this.tags.filter((t) => t.tagType === "Alias");
  }

  get ioTags() {
    return this._ioTags;
  }

  get aliasTags() {
    return this._aliasTags;
  }

  toXml() {
    const base = super.toXml();
    const idx = base.indexOf(">");
    const openTag = base.slice(0, idx + 1);
    const inner = base.slice(idx + 1, -"</Controller>".length);
    let descXml = "";
    if (this._description) {
      const desc = multilineXmlText(this._description);
      descXml = `<Description>\n<![CDATA[${desc}]]>\n</Description>`;
    }
    const redundancyEnabledStr = this._redundancyEnabled ? "true" : "false";
    const redundancyInfo = `<RedundancyInfo Enabled="${redundancyEnabledStr}" KeepTestEditsOnSwitchOver="false"/>`;
    return (
      openTag +
      descXml +
      inner +
      redundancyInfo +
      '<Security Code="0" ChangesToDetect="16#ffff_ffff_ffff_ffff"/>' +
      "<SafetyInfo/>" +
      '<CST MasterID="0"/>' +
      '<WallClockTime LocalTimeAdjustment="0" TimeZone="0"/>' +
      "<Trends/>" +
      "<DataLogs/>" +
      '<TimeSynchronize Priority1="128" Priority2="128" PTPEnable="true"/>' +
      "</Controller>"
    );
  }
}

class RSLogix5000Content extends L5xElement {
  constructor(controller, schemaRevision, softwareRevision, targetName, targetType, containsContext, exportDate, exportOptions) {
    super();
    this.controller = controller;
    this.schemaRevision = schemaRevision;
    this.softwareRevision = softwareRevision;
    this.targetName = targetName;
    this.targetType = targetType;
    this.containsContext = containsContext;
    this.exportDate = exportDate;
    this.exportOptions = exportOptions;
    this._exportName = "RSLogix5000Content";
  }
}

module.exports = {
  LocalTag,
  Parameter,
  Module,
  Routine,
  fbdBoolFieldByIndex,
  fbdMakeBitResolver,
  fbdResolveSource,
  fbdResolveWires,
  fbdSplitPinRef,
  renderFbdContent,
  AOI,
  Program,
  ScheduledProgram,
  EventInfo,
  Task,
  Controller,
  RSLogix5000Content,
};
