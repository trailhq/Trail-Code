/**
 * Makes one native grammar module unloadable, so a test can reproduce #323
 * without a machine that lacks a C toolchain. The package to break is named by
 * `GRAFT_TEST_BREAK_GRAMMAR`; with the variable unset this file does nothing.
 *
 * Preloaded with `--require`, which runs before the ESM graph is linked, so
 * `extract.ts` meets the failure at its own load time — where the reported
 * machine meets it. BOTH ways of reaching a grammar are broken, deliberately:
 * the ESM `import` that #323 was filed against, and the `createRequire` this
 * module now uses. Break only the second and the test cannot fail if the static
 * imports ever come back, which is the regression worth holding.
 *
 * The message is node-gyp-build's, near enough verbatim, because graft puts it
 * in front of the user and the test asserts on what the user sees.
 */
const { register } = require("node:module");
const Module = require("node:module");

const target = process.env.GRAFT_TEST_BREAK_GRAMMAR;

function message(pkg) {
  return (
    `No native build was found for platform=${process.platform} arch=${process.arch} ` +
    `runtime=node abi=137 uv=1 node=${process.versions.node}\n    loaded from: ${pkg}`
  );
}

if (target) {
  // `import "<grammar>"` from an ES module: fail it at resolution, which is as
  // fatal to the importing module as the real throw from its binding.
  register(
    "data:text/javascript," +
      encodeURIComponent(
        `const target = ${JSON.stringify(target)};\n` +
          `const msg = ${JSON.stringify(message(target))};\n` +
          `export function resolve(spec, ctx, next) {\n` +
          `  if (spec === target) throw new Error(msg);\n` +
          `  return next(spec, ctx);\n` +
          `}\n`,
      ),
  );

  // `require("<grammar>")`, including the one `createRequire` hands out.
  const load = Module._load;
  Module._load = function (request, ...rest) {
    if (request === target) throw new Error(message(target));
    return load.call(this, request, ...rest);
  };
}
