// Port of acd/l5x/port_structures.py's PORT_STRUCTURES table. The data
// itself is mechanically generated (see js/CLAUDE.md) from the Python
// source -- port_structures.json -- to avoid hand-transcription errors
// across ~39 module types; this file just loads it into a Map keyed by
// "vendor,productType,productCode" (matching Module._buildPortsXml's own
// key construction).
const raw = require("./port_structures.json");

const PORT_STRUCTURES = new Map(Object.entries(raw));

module.exports = { PORT_STRUCTURES };
