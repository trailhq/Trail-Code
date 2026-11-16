#!/usr/bin/env node
// The `graft` command: trail under its old name, with every old command and
// meaning kept. Set explicitly, so a graft started from inside a trail process
// is still graft. The Node check runs before the rest loads (node-version.ts).
import { nodeTooOld } from "../node-version.js";

const tooOld = nodeTooOld("graft", "@nanonets/graft");
if (tooOld) {
  console.error(tooOld);
  process.exit(1);
}
const { setBrand } = await import("../brand.js");
setBrand("graft");
await import("../cli.js");
