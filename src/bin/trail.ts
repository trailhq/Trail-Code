#!/usr/bin/env node
// The `trail` command. Same code as `graft`, with trail's command layout.
import { setBrand } from "../brand.js";

setBrand("trail");
await import("../cli.js");
