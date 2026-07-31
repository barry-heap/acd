// Browser UI glue: file input/drag-drop -> convertAcdToL5x (see build.js's
// RUNTIME_BOOTSTRAP, which exposes it as a plain global) -> progress
// rendering + final L5X -> Blob download. Conversion runs on the main
// thread (see build.js for why a Web Worker was tried and reverted); its
// onProgress hook is awaited at each milestone and yields back to the
// browser via requestAnimationFrame afterward, so the page still repaints
// (progress bar, log, scrolling) between routine builds on a large project
// instead of freezing until 100%.
(function () {
  var drop = document.getElementById("drop");
  var input = document.getElementById("file-input");
  var status = document.getElementById("status");
  var progressWrap = document.getElementById("progress-wrap");
  var progressBar = document.getElementById("progress-bar");
  var progressSummary = document.getElementById("progress-summary");
  var progressLog = document.getElementById("progress-log");
  var resetBtn = document.getElementById("reset-btn");

  var PHASE_LABELS = {
    extract: "Extracting archive…",
    comps: "Reading component records…",
    rungs: "Reading ladder logic…",
    comments: "Reading comments…",
    nameless: "Reading routine bodies…",
    indexing: "Indexing…",
    datatypes: "Building data types…",
    tags: "Building tags…",
    modules: "Building I/O modules…",
    done: "Finalizing…",
  };

  // Rough phase weights for the progress bar, since the true total work
  // (routine/tag count) isn't known until the ingest phases finish. Once a
  // project's datatype/tag counts are known, "program"/"routine" phases
  // fill the remaining ~70% proportionally to routines seen so far -- there's
  // no reliable upfront routine total without a second full pass, so this is
  // a smooth approximation, not an exact percentage.
  var INGEST_PHASES = ["extract", "comps", "rungs", "comments", "nameless", "indexing"];

  function setStatus(text, cls) {
    status.textContent = text;
    status.className = "status" + (cls ? " " + cls : "");
  }

  function logLine(text) {
    var line = document.createElement("div");
    line.className = "progress-log-line";
    line.textContent = text;
    progressLog.appendChild(line);
    progressLog.scrollTop = progressLog.scrollHeight;
    // Cap the DOM log size on very large projects -- keep the most recent
    // lines visible without letting the log grow unbounded.
    while (progressLog.children.length > 500) {
      progressLog.removeChild(progressLog.firstChild);
    }
  }

  // Clears any error/progress state left over from a previous attempt and
  // returns to the initial file-picker UI, without a page reload. Covers
  // every failure path (bad magic bytes, empty/truncated file, a real .ACD
  // that fails partway through parsing, ...) since they all funnel through
  // handleFile's single .catch() below -- there's exactly one place that
  // needs to show this button, not one per failure mode.
  function resetUI() {
    setStatus("");
    resetBtn.hidden = true;
    progressWrap.hidden = true;
    progressLog.textContent = "";
    progressBar.style.width = "0%";
    progressSummary.textContent = "";
    // Clearing the input's value (not just relying on the "change" event)
    // means picking the exact same file again still fires "change" -- some
    // browsers don't re-fire it for an unchanged file list otherwise.
    input.value = "";
  }

  function downloadText(filename, text) {
    var blob = new Blob([text], { type: "application/xml" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Yields control back to the browser's event loop/paint cycle. Used after
  // every progress update so the DOM changes above actually become visible
  // instead of batching invisibly behind one long synchronous JS turn.
  function yieldToBrowser() {
    return new Promise(function (resolve) {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(function () {
          resolve();
        });
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  function handleFile(file) {
    setStatus("");
    resetBtn.hidden = true;
    progressWrap.hidden = false;
    progressLog.textContent = "";
    progressBar.style.width = "0%";
    progressSummary.textContent = "Starting…";

    var routineCount = 0;
    var ingestPhasesSeen = 0;

    function onProgress(p) {
      if (p.phase === "routine") {
        routineCount++;
        var where = p.program ? "Program " + p.program : "AOI " + p.aoi;
        logLine(where + " – " + p.routine);
        progressSummary.textContent = routineCount + " routine" + (routineCount === 1 ? "" : "s") + " processed…";
        // Once routines start flowing, park the bar in the last third and
        // creep it toward (but never quite reaching) 100% -- see the
        // INGEST_PHASES comment above for why an exact percentage isn't
        // available here.
        var creep = 70 + Math.min(28, Math.log2(routineCount + 1) * 4);
        progressBar.style.width = creep + "%";
      } else if (p.phase === "program") {
        logLine("Program: " + p.program);
      } else if (p.phase === "aoi") {
        logLine("AOI: " + p.aoi);
      } else if (p.phase === "datatypes") {
        logLine("Building " + p.count + " data type" + (p.count === 1 ? "" : "s"));
        progressBar.style.width = "55%";
        progressSummary.textContent = PHASE_LABELS.datatypes;
      } else if (p.phase === "tags") {
        logLine("Building " + p.count + " controller tag" + (p.count === 1 ? "" : "s"));
        progressBar.style.width = "65%";
        progressSummary.textContent = PHASE_LABELS.tags;
      } else if (p.phase === "modules") {
        logLine("Building " + p.count + " I/O module" + (p.count === 1 ? "" : "s"));
      } else if (PHASE_LABELS[p.phase]) {
        var idx = INGEST_PHASES.indexOf(p.phase);
        if (idx >= 0) {
          ingestPhasesSeen = idx + 1;
          progressBar.style.width = Math.round((ingestPhasesSeen / INGEST_PHASES.length) * 45) + "%";
        }
        progressSummary.textContent = PHASE_LABELS[p.phase];
        logLine(PHASE_LABELS[p.phase]);
      }
      return yieldToBrowser();
    }

    file
      .arrayBuffer()
      .then(function (buf) {
        var acdBytes = new Uint8Array(buf);
        return convertAcdToL5x(acdBytes, onProgress);
      })
      .then(function (xml) {
        progressBar.style.width = "100%";
        progressSummary.textContent = "Done – " + routineCount + " routine" + (routineCount === 1 ? "" : "s") + " total.";
        var outName = file.name.replace(/\.acd$/i, "") + ".L5X";
        downloadText(outName, xml);
        setStatus("Done — " + outName + " (" + xml.length.toLocaleString() + " characters) downloaded.", "ok");
      })
      .catch(function (err) {
        progressWrap.hidden = true;
        setStatus("Error: " + ((err && err.message) || String(err)), "error");
        resetBtn.hidden = false;
        console.error(err);
      });
  }

  drop.addEventListener("click", function () {
    input.click();
  });
  input.addEventListener("change", function () {
    if (input.files[0]) handleFile(input.files[0]);
  });
  drop.addEventListener("dragover", function (e) {
    e.preventDefault();
    drop.classList.add("dragover");
  });
  drop.addEventListener("dragleave", function () {
    drop.classList.remove("dragover");
  });
  drop.addEventListener("drop", function (e) {
    e.preventDefault();
    drop.classList.remove("dragover");
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  resetBtn.addEventListener("click", resetUI);
})();
