// Extracts the <script> block from lib/page.html (a plain file, no template
// processing — same trap as the original plugin) and syntax-checks it with
// node --check. A syntax error in the embedded script blanks the whole grid
// ("Invalid or unexpected token" in the browser console), and node --check
// cannot see inside the HTML file on its own.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const pagePath = new URL("../lib/page.html", import.meta.url)
const html = fs.readFileSync(pagePath, "utf8")
const m = html.match(/<script>([\s\S]*?)<\/script>/)
if (!m) {
  console.error("check-page-script: no <script> block found in lib/page.html")
  process.exit(1)
}
const tmp = path.join(os.tmpdir(), "obvious-grid-page-" + process.pid + ".mjs")
fs.writeFileSync(tmp, m[1])
const r = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" })
fs.unlinkSync(tmp)
if (r.status !== 0) {
  console.error(r.stderr || "page script: syntax error")
  process.exit(r.status || 1)
}
console.log("page script OK")
