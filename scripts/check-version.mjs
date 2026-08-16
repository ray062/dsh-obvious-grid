import fs from "node:fs"

// Guard against version drift: package.json is the single source of truth;
// lib/index.js and lib/sessions.js read it at runtime. The one remaining
// literal is the page.html fallback (used if the status payload lacks a
// version), which must match.
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const page = fs.readFileSync(new URL("../lib/page.html", import.meta.url), "utf8")
const m = page.match(/i\.version \|\| "(\d+\.\d+\.\d+)"/)
if (!m) {
  console.error("check-version: page.html version fallback not found")
  process.exit(1)
}
if (m[1] !== pkg.version) {
  console.error(`check-version: version mismatch - package.json ${pkg.version} vs page.html fallback ${m[1]}`)
  process.exit(1)
}
console.log("version OK:", pkg.version)
