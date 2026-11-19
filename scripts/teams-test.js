// Sends one test card to the Teams channel in TEAMS_WEBHOOK_URL (.env.local).   npm run teams:test
import fs from "node:fs";
import { CONFIG } from "../src/paths.js";
import { configure, postTeams } from "../src/mail.js";

if (!process.env.TEAMS_WEBHOOK_URL) { console.error("TEAMS_WEBHOOK_URL is not set in .env.local"); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
configure({ name: cfg.appName, url: process.env.MATCHBOOK_URL || `http://localhost:${cfg.port}` });
const m = { at: new Date().toISOString(), agent: "MIRO Parking Agent", subject: "Test from Match Book: Teams is connected", toNames: ["AP team"],
  text: "If you can read this card in the Alerts channel, Match Book notifications (parked, posted, exceptions, follow-ups) will arrive here.", ref: null };
await postTeams(m);
console.log(m.status, m.error ?? "");
process.exit(m.status === "SENT TO TEAMS" ? 0 : 1);
