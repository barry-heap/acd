// Port of acd/api.py's ConvertAcdToL5x. Note write-back-only helpers
// (export_routine, export_datatype, patch_rungs, the diff/CSV functions)
// are intentionally NOT ported -- this converter is read-only ACD -> L5X,
// per the project's scope (see js/README.md).

const { ingestAcd } = require("./ingest");
const { buildController } = require("./l5x/builders");
const { buildProjectContent } = require("./l5x/project");

const WEEKDAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Mirrors Python's datetime.now().strftime("%a %b %d %H:%M:%S %Y") -- a
// naive (local-time, not UTC) timestamp, matching ProjectBuilder.build()'s
// export_date. Like Python's, this is inherently a point-in-time value and
// will differ between separate runs -- not something to diff for parity.
function formatNowWeekdayString(date) {
  const p = (n) => String(n).padStart(2, "0");
  const dayIdx = (date.getDay() + 6) % 7;
  return (
    `${WEEKDAY_ABBR[dayIdx]} ${MONTH_ABBR[date.getMonth()]} ${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())} ${date.getFullYear()}`
  );
}

// acdBytes: Uint8Array/Buffer of the whole .ACD file.
// Returns the L5X XML text (UTF-8, with an XML declaration prepended) --
// not pretty-printed (Python's ConvertAcdToL5x optionally pretty-prints via
// xml.dom.minidom; skipped here since Studio 5000 imports either form
// identically and this avoids an XML-parsing dependency for a purely
// cosmetic feature). Byte-for-byte identical, modulo whitespace, to
// Python's raw (non-pretty-printed) output for the same file.
// onProgress(event), if given, is awaited at each major milestone (container
// extraction, each .Dat file parsed, each program/AOI/routine as it's built,
// ...) -- see ingest.js/l5x/builders.js for the exact event shapes
// ({phase, ...}). This lets a caller yield back to the browser's event loop
// between milestones (e.g. `await new Promise(requestAnimationFrame)`) so a
// long conversion still renders visible incremental progress on the main
// thread. Purely a progress-reporting hook; conversion correctness/output is
// identical whether or not one is passed.
async function convertAcdToL5x(acdBytes, onProgress = null) {
  const { db, rawFiles } = await ingestAcd(acdBytes, onProgress);
  const controller = await buildController(db, onProgress);
  const quickInfoBytes = rawFiles.get("QuickInfo.XML");
  const project = buildProjectContent(quickInfoBytes, formatNowWeekdayString(new Date()));
  project.controller = controller;
  if (onProgress) onProgress({ phase: "done" });
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + project.toXml();
}

module.exports = { convertAcdToL5x };
