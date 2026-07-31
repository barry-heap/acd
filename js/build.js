// Build script (dev-only, not shipped): assembles every module this port
// needs into one self-contained, offline HTML file with no build step for
// the *end user* -- they just open the resulting file in a browser. This
// script is what "builds" it (run once per change to the source files
// below), using a small hand-rolled CommonJS-in-the-browser shim so the
// existing, already-verified Node modules can be embedded completely
// unmodified (their own require()/module.exports lines are untouched).
//
// The conversion runs on the main thread, not a Web Worker. A Worker was
// tried first (so a large project's conversion couldn't freeze the page at
// all), but sql.js's asm.js build (sql-asm.js -- deliberately used instead
// of the wasm build so this stays a single offline file with no separate
// .wasm fetch) crashes with `RangeError: Maximum call stack size exceeded`
// when run inside a Worker in real headless Chromium, while the identical
// code works fine on the main thread or in Node -- a genuine asm.js/Worker
// incompatibility, not a bug in this port. Instead, convertAcdToL5x's
// onProgress hook (see convert.js) is awaited at each milestone, and ui.js's
// onProgress implementation yields via requestAnimationFrame so the browser
// still gets to repaint between routine builds, without a Worker's fragility.
//
// Run: node build.js  (writes dist/acd-to-l5x.html)

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, "dist");

// Each own-source module to embed, by id (== its path relative to js/,
// without the .js extension -- matches how require() specifiers resolve,
// see resolveId() in the emitted shim below). Order doesn't matter; each
// factory only runs the first time something requires it.
const MODULE_FILES = [
  "generated/Dat.js",
  "generated/FafaComps.js",
  "generated/FdfdComps.js",
  "generated/FafaSbregions.js",
  "generated/RxGeneric.js",
  "unzip.js",
  "parseDat.js",
  "record/comps.js",
  "record/sbregion.js",
  "record/comments.js",
  "record/nameless.js",
  "ingest.js",
  "l5x/render.js",
  "l5x/tag.js",
  "l5x/port_structures.js",
  "l5x/catalog_numbers.js",
  "l5x/elements.js",
  "l5x/sqlutil.js",
  "l5x/builders.js",
  "l5x/project.js",
  "convert.js",
];

function idFor(relPath) {
  return relPath.replace(/\.js$/, "");
}

// Guards against a future embedded source accidentally containing the
// literal substring "</script" (which would prematurely close the
// surrounding <script> tag regardless of its type= attribute) by splitting
// it -- harmless for JS semantics, since JS never actually parses
// "</scr" + "ipt" as anything meaningful on its own.
function scriptSafe(src) {
  return src.replace(/<\/script/gi, "<\\/script");
}

function buildModulesScript() {
  const parts = [];
  for (const relPath of MODULE_FILES) {
    const id = idFor(relPath);
    const src = fs.readFileSync(path.join(ROOT, relPath), "utf8");
    parts.push(
      `__modules[${JSON.stringify(id)}] = function(module, exports, require) {\n${src}\n};`,
    );
  }
  // port_structures.json is require()'d directly (not a .js module) by
  // l5x/port_structures.js -- register it under the exact id that
  // resolveId() computes for "./port_structures.json" from "l5x/port_structures".
  const portStructuresJson = fs.readFileSync(path.join(ROOT, "l5x/port_structures.json"), "utf8");
  parts.push(`__modules["l5x/port_structures.json"] = function(module, exports, require) {\n  module.exports = ${portStructuresJson};\n};`);
  return parts.join("\n\n");
}

const SHIM = `
// Minimal CommonJS-in-the-browser shim: enough to run the existing Node
// modules below completely unmodified. "kaitai-struct"/"pako"/"sql.js" are
// mapped to the UMD-global runtimes loaded earlier in this same script.
// "self" (rather than "window") is used below since it resolves the same
// way on both the main thread and in a Worker, in case a Worker is ever
// reintroduced for some part of this later.
var __modules = {};
var __cache = {};

function __resolveId(fromId, spec) {
  var fromDir = fromId.split("/").slice(0, -1);
  var specParts = spec.split("/");
  var parts = fromDir.slice();
  for (var i = 0; i < specParts.length; i++) {
    var p = specParts[i];
    if (p === "." || p === "") continue;
    if (p === "..") parts.pop();
    else parts.push(p);
  }
  return parts.join("/");
}

function __require(fromId, spec) {
  if (spec === "kaitai-struct") return { KaitaiStream: self.KaitaiStream };
  if (spec === "kaitai-struct/KaitaiStream") return self.KaitaiStream;
  if (spec === "pako") return self.pako;
  if (spec === "sql.js") return self.initSqlJs;
  if (spec === "fs" || spec === "path") {
    // Only reachable via Unzip.writeFiles(), a Node-only dev convenience
    // never called from the browser build's own code path.
    throw new Error("Node-only module '" + spec + "' is not available in the browser build");
  }
  var id = __resolveId(fromId, spec);
  if (__cache[id]) return __cache[id].exports;
  var factory = __modules[id];
  if (!factory) throw new Error("Module not found: " + spec + " (resolved to " + id + ", required from " + fromId + ")");
  var mod = { exports: {} };
  __cache[id] = mod;
  factory(mod, mod.exports, function (s) { return __require(id, s); });
  return mod.exports;
}
`;

// Exposes convertAcdToL5x as a plain global for ui.js (loaded right after
// this in the same <script>, on the same main thread) to call directly.
const RUNTIME_BOOTSTRAP = `
var convertAcdToL5x = __require("__main__", "./convert").convertAcdToL5x;
`;

function buildRuntimeSource() {
  const kaitaiSrc = fs.readFileSync(path.join(ROOT, "node_modules/kaitai-struct/KaitaiStream.js"), "utf8");
  const pakoSrc = fs.readFileSync(path.join(ROOT, "node_modules/pako/dist/browser/pako.umd.min.js"), "utf8");
  const sqlAsmSrc = fs.readFileSync(path.join(ROOT, "node_modules/sql.js/dist/sql-asm.js"), "utf8");
  const modulesSrc = buildModulesScript();
  return [kaitaiSrc, pakoSrc, sqlAsmSrc, SHIM, modulesSrc, RUNTIME_BOOTSTRAP].join("\n\n");
}

function buildHtml() {
  const runtimeSrc = buildRuntimeSource();
  const uiSrc = fs.readFileSync(path.join(ROOT, "ui.js"), "utf8");
  const mainScript = scriptSafe([runtimeSrc, uiSrc].join("\n\n"));
  const cssSrc = fs.readFileSync(path.join(ROOT, "theme.css"), "utf8");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>ACD &rarr; L5X Converter</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
${cssSrc}
</style>
</head>
<body>
<div class="page">
<h1>ACD &rarr; L5X Converter</h1>
<p class="lede">Converts a Rockwell Studio 5000 <code>.ACD</code> project file to <code>.L5X</code> XML,
entirely in your browser. No file ever leaves this page.</p>
<div id="drop" class="drop">
  <p>Drop a <code>.ACD</code> file here, or click to choose one.</p>
  <input id="file-input" type="file" accept=".ACD,.acd" style="display:none" />
</div>
<div id="progress-wrap" class="progress-wrap" hidden>
  <div class="progress-bar-track"><div id="progress-bar" class="progress-bar-fill"></div></div>
  <div id="progress-summary" class="progress-summary"></div>
  <div id="progress-log" class="progress-log"></div>
</div>
<div id="status" class="status"></div>
<button id="reset-btn" class="reset-btn" type="button" hidden>Try another file</button>
<footer>Read-only: produces an L5X export only, never writes back to the source .ACD.
FBD routines are not yet supported and export as an empty shell, matching the Python reference tool.</footer>
</div>
<script>
${mainScript}
</script>
</body>
</html>
`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const html = buildHtml();
const outPath = path.join(OUT_DIR, "acd-to-l5x.html");
fs.writeFileSync(outPath, html);
console.log(`Wrote ${outPath} (${(html.length / 1024).toFixed(0)} KB)`);
