// Browser UI glue: file input -> ArrayBuffer -> convertAcdToL5x() -> Blob
// download. Runs inside the assembled single-file HTML (see build.js);
// __require is the CommonJS shim defined just above this script.
(function () {
  var convertAcdToL5x = __require("__ui__", "./convert").convertAcdToL5x;

  var drop = document.getElementById("drop");
  var input = document.getElementById("file-input");
  var status = document.getElementById("status");

  function setStatus(text, cls) {
    status.textContent = text;
    status.className = "status" + (cls ? " " + cls : "");
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

  async function handleFile(file) {
    setStatus("Converting " + file.name + " …");
    try {
      var buf = new Uint8Array(await file.arrayBuffer());
      var xml = await convertAcdToL5x(buf);
      var outName = file.name.replace(/\.acd$/i, "") + ".L5X";
      downloadText(outName, xml);
      setStatus("Done — " + outName + " (" + xml.length.toLocaleString() + " characters) downloaded.", "ok");
    } catch (e) {
      setStatus("Error: " + (e && e.message ? e.message : e), "error");
      console.error(e);
    }
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
})();
