// Builds the Microsoft Teams app package (manifest + icons, zipped) for Match Book.
//   npm run teams:app -- https://abc123-3100.inc1.devtunnels.ms
// Upload the zip in Teams: team "..." > Manage team > Apps > Upload an app (or Apps > Manage your apps > Upload).
// Personal tabs: My tiles, Invoices, Follow-ups. Channel / group-chat tab: pick a view in teams-config.html.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { ROOT } from "../src/paths.js";

const { createCanvas } = createRequire(import.meta.url)("@napi-rs/canvas");
const url = (process.argv[2] || "").replace(/\/+$/, "");
if (!/^https:\/\/[^/]+$/i.test(url)) { console.error("Usage: npm run teams:app -- https://<your tunnel or server host>   (Teams only loads https)"); process.exit(1); }
const host = new URL(url).host;
const OUT = path.join(ROOT, "teams-app");
fs.mkdirSync(OUT, { recursive: true });

// the app id stays the same between builds, so a re-upload updates the installed app
const idFile = path.join(OUT, "app-id.txt");
const id = fs.existsSync(idFile) ? fs.readFileSync(idFile, "utf8").trim() : crypto.randomUUID();
fs.writeFileSync(idFile, id);
const version = `1.0.${Math.floor(Date.now() / 60000) % 100000}`;   // newer on every build, so Teams takes the update

const tab = (entityId, name) => ({ entityId, name, contentUrl: `${url}/?teams=1#${entityId}`, websiteUrl: `${url}/#${entityId}`, scopes: ["personal"] });
const manifest = {
  $schema: "https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
  manifestVersion: "1.17", version, id,
  developer: { name: "InfraBeat", websiteUrl: url, privacyUrl: url, termsOfUseUrl: url },
  name: { short: "Match Book", full: "Match Book - AP invoice agents" },
  description: {
    short: "Matched. Checked. Booked. Your AP invoice tiles in Teams.",
    full: "Match Book reads vendor invoices, checks them against SAP (PO, GRN, quality, GST, MSME) and parks them in MIRO. In Teams each person sees their own tiles: invoice queue, GRNs waiting for invoices, open advances, usage decisions, the MSME clock and payments due.",
  },
  icons: { color: "color.png", outline: "outline.png" },
  accentColor: "#6A2FA8",
  staticTabs: [tab("home", "My tiles"), tab("invoices", "Invoices"), tab("monitor", "Follow-ups")],
  configurableTabs: [{ configurationUrl: `${url}/teams-config.html`, canUpdateConfiguration: true, scopes: ["team", "groupChat"] }],
  permissions: ["identity"],
  validDomains: [host],
  showLoadingIndicator: false,
};

// icons: 192x192 colour (brand gradient) and 32x32 outline (white on transparent, as Teams requires)
function mark(ctx, s, color) {
  ctx.strokeStyle = color; ctx.lineWidth = s * 0.09; ctx.lineCap = "round"; ctx.lineJoin = "round";
  const r = s * 0.06, x = s * 0.22, y = s * 0.17, w = s * 0.56, h = s * 0.66;       // invoice sheet
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(s * 0.36, s * 0.50); ctx.lineTo(s * 0.46, s * 0.61); ctx.lineTo(s * 0.65, s * 0.38); ctx.stroke();   // tick
}
const color = createCanvas(192, 192), c1 = color.getContext("2d");
const g = c1.createLinearGradient(0, 0, 192, 192); g.addColorStop(0, "#6a2fa8"); g.addColorStop(1, "#2f4ec9");
c1.fillStyle = g; c1.beginPath(); c1.roundRect(0, 0, 192, 192, 36); c1.fill();
mark(c1, 192, "#ffffff");
const outline = createCanvas(32, 32);
mark(outline.getContext("2d"), 32, "#ffffff");

const files = {
  "manifest.json": Buffer.from(JSON.stringify(manifest, null, 2)),
  "color.png": await color.encode("png"),
  "outline.png": await outline.encode("png"),
};
for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(OUT, n), b);

// zip (stored, no compression): the three files at the root of the archive, as Teams expects
function zip(entries) {
  const parts = [], dir = []; let off = 0;
  for (const [name, data] of Object.entries(entries)) {
    const n = Buffer.from(name), crc = zlib.crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    const d = Buffer.alloc(46); d.writeUInt32LE(0x02014b50, 0); d.writeUInt16LE(20, 4); d.writeUInt16LE(20, 6); d.writeUInt32LE(crc, 16); d.writeUInt32LE(data.length, 20); d.writeUInt32LE(data.length, 24); d.writeUInt16LE(n.length, 28); d.writeUInt32LE(off, 42);
    parts.push(h, n, data); dir.push(d, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(dir), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(dir.length / 2, 8); e.writeUInt16LE(dir.length / 2, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}
const zipFile = path.join(OUT, "MatchBook-Teams.zip");
fs.writeFileSync(zipFile, zip(files));
console.log(`Teams app ${version} for ${url}\n  ${zipFile}\nUpload it in Teams: Match Book team > ... > Manage team > Apps > Upload an app.`);
