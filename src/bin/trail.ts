#!/usr/bin/env node
// The `trail` command. Same code as `graft`, with trail's command layout.
// The Node check runs before the rest loads (node-version.ts says why).
import { nodeTooOld } from "../node-version.js";

const tooOld = nodeTooOld("trail", "@trailhq/trail-code");
if (tooOld) {
  console.error(tooOld);
  process.exit(1);
}
const { setBrand } = await import("../brand.js");
setBrand("trail");
await import("../cli.js");
