#!/usr/bin/env node
// The `graft` command: trail under its old name, with every old command and
// meaning kept. Set explicitly, so a graft started from inside a trail process
// is still graft.
import { setBrand } from "../brand.js";

setBrand("graft");
await import("../cli.js");
