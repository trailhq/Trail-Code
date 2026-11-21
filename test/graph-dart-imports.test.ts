import { test } from "node:test";
import assert from "node:assert/strict";
import { extractGeneric, warmGenericGrammars } from "../src/graph/generic.js";
import { resolveEdges } from "../src/graph/resolve.js";

test("Dart links local file directives and skips lookalikes in ordinary strings", async () => {
  await warmGenericGrammars(["dart"]);
  const source = "lib/panel/main.dart";
  const main = extractGeneric(source, [
    "import 'auth.dart' as auth;",
    "import '../shared/stub.dart' if (dart.library.io) '../shared/io.dart';",
    "import 'dart:io';",
    "import 'package:external/noise.dart';",
    'export "api.dart" show Status;',
    "part 'main.g.dart';",
    "const text = 'noise.dart';",
    "// import 'noise.dart';",
  ].join("\n"), "dart");
  const files = [
    "lib/panel/auth.dart", "lib/shared/stub.dart", "lib/shared/io.dart",
    "lib/panel/api.dart", "lib/panel/main.g.dart", "lib/panel/noise.dart",
  ];
  const nodes = [...main.nodes, ...files.flatMap((file) => extractGeneric(file, "void helper() {}", "dart").nodes)];
  const edges = resolveEdges(nodes, main.rawEdges);
  assert.deepEqual(
    edges.filter((edge) => edge.source === source && edge.relation === "imports").map((edge) => edge.target).sort(),
    files.filter((file) => !file.endsWith("noise.dart")).sort(),
  );
});
