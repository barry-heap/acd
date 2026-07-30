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
      const lineXmls = this._stLines.map((text, i) => `<Line Number="${i}"><![CDATA[${text}]]></Line>`);
      content = `<STContent>${lineXmls.join("")}</STContent>`;
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
  AOI,
  Program,
  ScheduledProgram,
  EventInfo,
  Task,
  Controller,
  RSLogix5000Content,
};
