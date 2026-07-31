// Automated regression check for the specific PLC-Studio FBD-render
// failure mode that caught the VisiblePins bug (see CLAUDE.md's
// "VisiblePins is a per-block-TYPE default" section): load a converted
// .L5X into plc_studio.html (headless, same Playwright/pre-installed-
// Chromium approach as test_browser.js) and check, for each named
// routine, whether its FBD content actually renders (a real
// <svg class="fbd-sheet"> with blocks/wires drawn in it) or falls back to
// the generic "not yet supported" placeholder (<div class="skip-note">,
// see renderUnsupportedTab in plc_studio.html).
//
// This is a coarse, cheap regression guard for "did this fail outright" --
// it is NOT a substitute for occasionally eyeballing whether wires land on
// the right pins/sheets. Keep doing both (see CLAUDE.md).
//
// Routine lookup goes through the app's own in-page model (model.programs/
// model.aois/model.routines) and calls openRoutine() directly, rather than
// clicking through the tree DOM -- more robust (works regardless of
// collapsed tree state) and unambiguous when the same routine name repeats
// across scopes (e.g. multiple AOIs each have their own "Logic" routine).
//
// Usage: node test_plc_studio_fbd.js <l5x-path> <routine-spec> [<routine-spec> ...]
//   routine-spec: "program:ProgramName:RoutineName" or "aoi:AOIName:RoutineName"
const path = require("path");
const { chromium } = require("playwright");

async function main() {
  const l5xPath = process.argv[2];
  const specs = process.argv.slice(3);
  if (!l5xPath || !specs.length) {
    console.error("usage: node test_plc_studio_fbd.js <l5x-path> <program:Name:Routine|aoi:Name:Routine> ...");
    process.exit(2);
  }

  const htmlPath = path.join(__dirname, "plc_studio.html");
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();

  page.on("dialog", async (dialog) => {
    console.log("[dialog]", dialog.message());
    await dialog.dismiss();
  });
  page.on("pageerror", (err) => console.log("[pageerror]", String(err)));

  await page.goto("file://" + htmlPath);

  // The app auto-loads its own embedded demo model on open (window.model is
  // already truthy before any upload), so waiting on window.model alone
  // races with -- and is satisfied by -- that stale demo, not the file we're
  // about to upload. #fileLabel starts as the literal placeholder "-" and is
  // only ever overwritten (inside loadModel()) with the just-uploaded file's
  // own basename, so waiting for that exact match is the reliable signal
  // that OUR file (not the demo) has finished parsing and replaced
  // window.model.
  const uploadedBasename = path.basename(l5xPath);
  await page.locator("#fileInput").setInputFiles(l5xPath);
  await page.waitForFunction(
    (expectedLabel) => document.getElementById("fileLabel").textContent === expectedLabel,
    uploadedBasename,
    { timeout: 60000 },
  );

  let allOk = true;
  const results = [];
  for (const spec of specs) {
    const [scopeType, scopeName, routineName] = spec.split(":");
    const result = await page.evaluate(
      ({ scopeType, scopeName, routineName }) => {
        function findRoutineId() {
          if (scopeType === "program") {
            const prog = model.programs[scopeName];
            if (!prog) return null;
            const id = prog.routineIds.find((rid) => model.routines[rid].name === routineName);
            return id === undefined ? null : id;
          }
          if (scopeType === "aoi") {
            const aoi = model.aois.find((a) => a.name === scopeName);
            if (!aoi) return null;
            const id = aoi.routineIds.find((rid) => model.routines[rid].name === routineName);
            return id === undefined ? null : id;
          }
          return null;
        }
        const routineId = findRoutineId();
        if (routineId === null) return { found: false };
        openRoutine(routineId);
        const el = document.getElementById("tabContent");
        // ".skip-note" is reused for TWO different things: the genuine
        // "no renderer for this routine type" fallback (renderUnsupportedTab's
        // final branch, reached only when NOT an FBD-with-sheets routine),
        // AND a benign explanatory caption shown ALONGSIDE a real rendered
        // FBD sheet (renderUnsupportedTab's FBD branch, always present when
        // FBD content DOES render). The class alone is not the signal --
        // must check for the specific fallback phrasing.
        const unsupportedNote = [...el.querySelectorAll(".skip-note")].find((n) =>
          n.textContent.includes("not yet supported by this tool"),
        );
        const sheets = el.querySelectorAll("svg.fbd-sheet");
        let blockCount = 0;
        let wireCount = 0;
        sheets.forEach((svg) => {
          blockCount += svg.querySelectorAll("text.fbd-type-lbl").length;
          wireCount += svg.querySelectorAll("line").length;
        });
        return {
          found: true,
          unsupportedText: unsupportedNote ? unsupportedNote.textContent : null,
          sheetCount: sheets.length,
          blockCount,
          wireCount,
        };
      },
      { scopeType, scopeName, routineName },
    );

    if (!result.found) {
      console.log(`[MISSING]  ${spec} -- routine not found in this model`);
      allOk = false;
      results.push({ spec, status: "MISSING" });
      continue;
    }
    if (result.sheetCount > 0) {
      console.log(`[PASS]     ${spec} -- ${result.sheetCount} sheet(s), ${result.blockCount} block(s), ${result.wireCount} wire(s)`);
      results.push({ spec, status: "PASS", sheetCount: result.sheetCount, blockCount: result.blockCount, wireCount: result.wireCount });
    } else if (result.unsupportedText) {
      console.log(`[FAIL]     ${spec} -- fell back to unsupported placeholder: ${result.unsupportedText}`);
      allOk = false;
      results.push({ spec, status: "FAIL", detail: result.unsupportedText });
    } else {
      console.log(`[FAIL]     ${spec} -- no FBD sheet rendered and no fallback note either (unexpected state)`);
      allOk = false;
      results.push({ spec, status: "FAIL", detail: "no sheet, no skip-note" });
    }
  }

  await browser.close();

  const passed = results.filter((r) => r.status === "PASS").length;
  console.log(`\n${passed}/${results.length} routines rendered real FBD content`);

  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
