// Extracts the brand logos from the simple-icons package into ONE compact JSON file (build/simple-icons.json),
// so the packaged app ships ~2 MB of icon paths instead of the whole 23 MB package, and never downloads anything.
// Runs as part of `npm run build`. Output: { "<slug>": { t: title, h: hex, p: svgPath } }.
const fs = require("fs");
const path = require("path");

const icons = require("simple-icons");
const table = {};
for (const value of Object.values(icons)) {
  if (value && typeof value === "object" && value.slug && value.path) {
    table[value.slug] = { t: value.title, h: value.hex, p: value.path };
  }
}

const out = path.join(__dirname, "..", "build", "simple-icons.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(table));
const kb = Math.round(fs.statSync(out).size / 1024);
console.log(`wrote build/simple-icons.json: ${Object.keys(table).length} icons, ${kb} KB (simple-icons ${JSON.parse(fs.readFileSync(path.join(__dirname, "..", "node_modules", "simple-icons", "package.json"), "utf8")).version})`);
