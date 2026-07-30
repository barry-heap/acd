// Port of acd/l5x/elements.py's ProjectBuilder (reads QuickInfo.XML for the
// RSLogix5000Content top-level attributes). QuickInfo.XML is UTF-16 encoded,
// with a small, well-known set of self-closing elements/attributes -- a
// plain regex extractor is used here rather than pulling in a full XML
// parser dependency (keeping this port dependency-light / single-file
// friendly), since the only elements needed never have nested content.
const { RSLogix5000Content } = require("./elements");

function getAttr(xmlText, tagName, attrName) {
  const tagMatch = new RegExp(`<${tagName}\\b([^>]*)>`).exec(xmlText);
  if (!tagMatch) return null;
  const attrMatch = new RegExp(`\\b${attrName}="([^"]*)"`).exec(tagMatch[1]);
  return attrMatch ? attrMatch[1] : null;
}

// quickInfoBytes: Uint8Array of QuickInfo.XML's raw (UTF-16LE, BOM-prefixed) bytes.
function buildProject(quickInfoBytes) {
  const xmlText = new TextDecoder("utf-16le").decode(quickInfoBytes);

  const targetName = getAttr(xmlText, "[A-Za-z_][\\w.-]*", "Name") || getAttr(xmlText, "LogixQuickInfo", "Name");

  const schemaMajor = getAttr(xmlText, "SchemaVersion", "Major");
  const schemaMinor = getAttr(xmlText, "SchemaVersion", "Minor");
  const schemaRevision = schemaMajor !== null && schemaMinor !== null ? `${schemaMajor}.${schemaMinor}` : "1.0";

  let softwareRevision;
  const swVersionString = getAttr(xmlText, "SWVersion", "String");
  if (swVersionString !== null) {
    const match = /v(\d+\.\d+)$/.exec(swVersionString.trim());
    if (match) {
      softwareRevision = match[1];
    } else {
      const devMajor = getAttr(xmlText, "DeviceIdentity", "MajorRevision");
      const devMinor = getAttr(xmlText, "DeviceIdentity", "MinorRevision");
      softwareRevision = devMajor !== null && devMinor !== null ? `${devMajor}.${devMinor}` : "33.01";
    }
  } else {
    const devMajor = getAttr(xmlText, "DeviceIdentity", "MajorRevision");
    const devMinor = getAttr(xmlText, "DeviceIdentity", "MinorRevision");
    softwareRevision = devMajor !== null && devMinor !== null ? `${devMajor}.${devMinor}` : "33.01";
  }

  const targetType = "Controller";
  const containsContext = "false";
  const exportOptions = "NoRawData L5KData DecoratedData ForceProtectedEncoding AllProjDocTrans";

  return { targetName, schemaRevision, softwareRevision, targetType, containsContext, exportOptions };
}

// Builds the full RSLogix5000Content (project.controller must be set by the
// caller once ControllerBuilder has run, matching ExportL5x.project's own
// lazy-build order in Python).
function buildProjectContent(quickInfoBytes, exportDate) {
  const p = buildProject(quickInfoBytes);
  return new RSLogix5000Content(
    null,
    p.schemaRevision,
    p.softwareRevision,
    p.targetName,
    p.targetType,
    p.containsContext,
    exportDate,
    p.exportOptions,
  );
}

module.exports = { buildProject, buildProjectContent, getAttr };
