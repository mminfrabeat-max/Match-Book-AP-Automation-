// Safe JSON files for config and runtime data.
// read: tolerates a UTF-8 BOM (Notepad / PowerShell) and falls back to the last good copy (.bak) if the file is damaged.
// write: writes a temp file and renames it over the old one, so a crash or power cut never leaves half a file;
// the previous version is kept as .bak.
import fs from "node:fs";
import path from "node:path";

const parse = text => JSON.parse(text.replace(/^﻿/, ""));

export function readJson(file, fallback) {
  try { return parse(fs.readFileSync(file, "utf8")); }
  catch (e) {
    if (e.code === "ENOENT" && fallback !== undefined) return fallback;
    const bak = `${file}.bak`;
    if (fs.existsSync(bak)) {
      console.error(`${path.basename(file)} could not be read (${e.message}); using the last good copy ${path.basename(bak)}`);
      return parse(fs.readFileSync(bak, "utf8"));
    }
    if (fallback !== undefined && e.code === "ENOENT") return fallback;
    throw new Error(`${path.basename(file)} could not be read: ${e.message}`);
  }
}

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function writeJson(file, data, { pretty = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
  if (fs.existsSync(file)) { try { fs.copyFileSync(file, `${file}.bak`); } catch { /* backup is best effort */ } }
  // Windows refuses to replace a file another process has open for a moment (virus scanner, backup, indexer): retry briefly
  for (let i = 1; ; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      if (i < 8) { pause(25 * i); continue; }
      fs.copyFileSync(tmp, file); fs.rmSync(tmp, { force: true }); return;      // last resort: overwrite in place (.bak is kept)
    }
  }
}
