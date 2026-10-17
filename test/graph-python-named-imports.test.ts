import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFile } from "../src/graph/extract.js";
import { resolveEdges } from "../src/graph/resolve.js";

const definitions = `def validate_result(value):
    return value

class Workspace:
    @classmethod
    def open(cls):
        return cls()
`;

function calls(files: Record<string, string>, source = "consumer.py#run"): string[] {
  const extracted = Object.entries(files).map(([path, text]) => extractFile(path, text, "python"));
  return resolveEdges(extracted.flatMap((x) => x.nodes), extracted.flatMap((x) => x.rawEdges))
    .filter((e) => e.source === source && e.relation === "calls")
    .map((e) => e.target);
}

test("Python named imports resolve aliases, class methods and duplicate function names", () => {
  const files = {
    "validators.py": definitions,
    "other.py": definitions,
    "first/helpers.py": "def parse_value(value):\n    return value\n",
    "second/helpers.py": "def parse_value(value):\n    return value\n",
    "consumer.py": `from validators import validate_result as validate_equity_result
from validators import Workspace as Project
from first.helpers import parse_value

def run():
    validate_equity_result(1)
    Project.open()
    return parse_value(1)
`,
  };
  assert.deepEqual(calls(files), [
    "validators.py#validate_result", "validators.py#Workspace.open", "first/helpers.py#parse_value",
  ]);
});

test("Python named imports resolve relative modules and package initialisers", () => {
  assert.deepEqual(calls({
    "pkg/validators.py": definitions,
    "pkg/tools/__init__.py": "def parse_value(value):\n    return value\n",
    "pkg/consumer.py": `from .validators import Workspace
from .tools import parse_value
def run():
    Workspace.open()
    return parse_value(1)
`,
  }, "pkg/consumer.py#run"), ["pkg/validators.py#Workspace.open", "pkg/tools/__init__.py#parse_value"]);
});

test("Python named imports do not guess past an external, absent or ambiguous target", () => {
  for (const module of ["external", "empty", "shared"]) {
    assert.deepEqual(calls({
      "validators.py": definitions,
      "empty.py": "def unrelated():\n    pass\n",
      "a/shared.py": definitions,
      "b/shared.py": definitions,
      "consumer.py": `from ${module} import validate_result, Workspace\ndef run():\n    validate_result(1)\n    Workspace.open()\n`,
    }), [], module);
  }
});

test("Python named imports stay shadowed by parameters and local bindings", () => {
  const bodies = [
    "def run(validate_result):\n    return validate_result(1)\n",
    "def run():\n    validate_result = callback\n    return validate_result(1)\n",
    "def run():\n    validate_result, other = callbacks\n    return validate_result(1)\n",
    "def run():\n    for validate_result in callbacks:\n        validate_result(1)\n",
    "def run():\n    from external import other as validate_result\n    return validate_result(1)\n",
    "def run(Workspace):\n    return Workspace.open()\n",
    "def run():\n    with manager() as validate_result:\n        return validate_result(1)\n",
    "def run():\n    try:\n        pass\n    except Error as validate_result:\n        validate_result(1)\n",
    "def run():\n    (validate_result := callback)\n    return validate_result(1)\n",
    "def run():\n    del validate_result\n    return validate_result(1)\n",
  ];
  for (const body of bodies) {
    assert.deepEqual(calls({
      "validators.py": definitions,
      "consumer.py": "from validators import validate_result, Workspace\n" + body,
    }), [], body);
  }
});

test("Python lambda and comprehension bindings shadow imported names locally", () => {
  for (const expression of [
    "lambda validate_result: validate_result(1)",
    "[validate_result(1) for validate_result in callbacks]",
    "(validate_result(1) for validate_result in callbacks)",
  ]) {
    assert.deepEqual(calls({
      "validators.py": definitions,
      "consumer.py": `from validators import validate_result\ndef run():\n    return ${expression}\n`,
    }), [], expression);
  }
});

test("Python nested scope assignments do not shadow an outer imported caller", () => {
  assert.deepEqual(calls({
    "validators.py": definitions,
    "consumer.py": `from validators import validate_result
def run():
    def inner():
        validate_result = callback
    return validate_result(1)
`,
  }), ["validators.py#validate_result"]);
});

test("Python module assignments suppress named import resolution", () => {
  assert.deepEqual(calls({
    "validators.py": definitions,
    "consumer.py": "from validators import validate_result\nvalidate_result = callback\ndef run():\n    return validate_result(1)\n",
  }), []);
});

test("Python conditional imports suppress overwritten module bindings", () => {
  for (const statement of [
    "from external import validate_result",
    "from external import other as validate_result",
    "import external as validate_result",
  ]) {
    assert.deepEqual(calls({
      "validators.py": definitions,
      "external.py": "def validate_result(value):\n    return value\ndef other(value):\n    return value\n",
      "consumer.py": `from validators import validate_result
if True:
    ${statement}
def run():
    return validate_result(1)
`,
    }), [], statement);
  }
});

test("Python annotations, default values and attribute assignments do not rebind imports", () => {
  assert.deepEqual(calls({
    "validators.py": definitions,
    "consumer.py": `from validators import validate_result, Workspace
def run(value: Workspace = Workspace):
    value.validate_result = callback
    return validate_result(1)
`,
  }), ["validators.py#validate_result"]);
});

test("Python function-local imports do not become named imports in another function", () => {
  assert.deepEqual(calls({
    "validators.py": definitions,
    "consumer.py": "def load():\n    from validators import validate_result as validate\ndef run():\n    return validate(1)\n",
  }), []);
});

test("Python named imports do not select the first duplicate definition", () => {
  assert.deepEqual(calls({
    "validators.py": definitions + definitions,
    "consumer.py": "from validators import validate_result, Workspace\ndef run():\n    validate_result(1)\n    Workspace.open()\n",
  }), []);
  assert.deepEqual(calls({
    "validators.py": "class Workspace:\n    def open(self):\n        pass\n    def open(self):\n        pass\n",
    "consumer.py": "from validators import Workspace\ndef run():\n    return Workspace.open()\n",
  }), []);
});

test("Python module aliases come from unconditional module-level imports only", () => {
  const billing = "def charge():\n    pass\n";
  for (const consumer of [
    "def load():\n    from app.services import billing\n\ndef run():\n    billing.charge()\n",
    "import app.services.billing as billing\nbilling = Stub()\n\ndef run():\n    billing.charge()\n",
    "from app.services import billing\nif flag:\n    from other import billing\n\ndef run():\n    billing.charge()\n",
  ]) {
    assert.deepEqual(calls({
      "app/services/billing.py": billing,
      "other/billing.py": billing,
      "consumer.py": consumer,
    }), [], consumer);
  }
});

test("Python match captures, lambda walrus targets and class-body bindings shadow imports", () => {
  for (const body of [
    "def run(value):\n    match value:\n        case v:\n            return v(1)\n",
    "def run(value):\n    match value:\n        case str() as v:\n            return v(1)\n",
    "def run(value):\n    match value:\n        case [v, *rest]:\n            return v(1)\n",
    "def run():\n    return (lambda: ((v := callback), v(1))[-1])()\n",
  ]) {
    assert.deepEqual(calls({
      "validators.py": definitions,
      "consumer.py": "from validators import validate_result as v\n" + body,
    }), [], body);
  }
  assert.deepEqual(calls({
    "validators.py": definitions,
    "consumer.py": "from validators import validate_result as v\ndef run(value):\n    match value:\n        case Color.RED:\n            return v(1)\n",
  }), ["validators.py#validate_result"]);
  const classBody = {
    "validators.py": definitions,
    "consumer.py": `from validators import Workspace as Project
class C:
    Project = LocalWorkspace
    Project.open()

    def m(self):
        return Project.open()
`,
  };
  assert.deepEqual(calls(classBody, "consumer.py#C"), []);
  // Class-body names are not visible inside methods.
  assert.deepEqual(calls(classBody, "consumer.py#C.m"), ["validators.py#Workspace.open"]);
});

test("Python walrus targets in definition headers and type aliases rebind imports", () => {
  const files = (consumer: string) => ({
    "validators.py": definitions,
    "app/services/billing.py": "def charge():\n    pass\n",
    "consumer.py": consumer,
  });
  for (const consumer of [
    "from validators import validate_result as v\ndef bind(x=(v := callback)):\n    pass\ndef run():\n    return v(1)\n",
    "from app.services import billing\ndef bind(x=(billing := Stub())):\n    pass\ndef run():\n    billing.charge()\n",
    "from validators import validate_result as v\ntype v = int\ndef run():\n    return v(1)\n",
    "from app.services import billing\ntype billing = object\ndef run():\n    billing.charge()\n",
  ]) {
    assert.deepEqual(calls(files(consumer)), [], consumer);
  }
  // A method or lambda default runs in the class body, so it sees the class-local name.
  const classLocal = "from validators import validate_result as v\nclass C:\n    v = callback\n";
  assert.deepEqual(calls(files(classLocal + "    def m(self, x=v(1)):\n        pass\n"), "consumer.py#C.m"), []);
  assert.deepEqual(calls(files(classLocal + "    f = lambda x=v(1): x\n"), "consumer.py#C"), []);
});

test("Python local imports in one def do not hide a same-named function elsewhere", () => {
  assert.deepEqual(calls({
    "consumer.py": `def load():
    from thirdparty import parse_value
def parse_value(value):
    return value
def run():
    return parse_value(1)
`,
  }), ["consumer.py#parse_value"]);
});

test("Python defaults and the leftmost comprehension iterable see the enclosing import", () => {
  for (const body of [
    "def run(v=v(1)):\n    pass\n",
    "def run():\n    return lambda v=v(1): v\n",
    "def run():\n    return [v for v in v(1)]\n",
  ]) {
    assert.deepEqual(calls({
      "validators.py": definitions,
      "consumer.py": "from validators import validate_result as v\n" + body,
    }), ["validators.py#validate_result"], body);
  }
});

test("Python names bound by an unresolved import never fall back to a global match", () => {
  for (const consumer of [
    "def run():\n    from thirdparty import validate_result\n    return validate_result(1)\n",
    "if flag:\n    from thirdparty import validate_result\n\ndef run():\n    return validate_result(1)\n",
    "def run():\n    from thirdparty import Workspace\n    return Workspace.open()\n",
  ]) {
    assert.deepEqual(calls({ "validators.py": definitions, "consumer.py": consumer }), [], consumer);
  }
});

test("Python submodule imports anchor to their package and drop an ambiguous one", () => {
  const f = "def f():\n    pass\n";
  const consumer = "from pkg import submodule\ndef run():\n    submodule.f()\n";
  assert.deepEqual(calls({ "pkg/submodule.py": f, "consumer.py": consumer }), ["pkg/submodule.py#f"]);
  assert.deepEqual(calls({
    "root2/pkg/__init__.py": "",
    "root2/pkg/submodule.py": f,
    "other/submodule.py": f,
    "consumer.py": consumer,
  }), ["root2/pkg/submodule.py#f"]);
  // Python's finder takes the package directory before a same-named module file.
  assert.deepEqual(calls({
    "pkg/__init__.py": "",
    "pkg/submodule.py": f,
    "pkg/submodule/__init__.py": f,
    "consumer.py": consumer,
  }), ["pkg/submodule/__init__.py#f"]);
  assert.deepEqual(calls({
    "root1/pkg/__init__.py": "",
    "root2/pkg/__init__.py": "",
    "root2/pkg/submodule.py": f,
    "consumer.py": consumer,
  }), []);
});

test("Python named imports feed call resolution, not identifier references", () => {
  const { rawEdges } = extractFile(
    "consumer.py",
    "from validators import validate_result\ndef run():\n    handler = validate_result\n    return handler\n",
    "python",
  );
  assert.deepEqual(rawEdges.filter((e) => e.relation === "references"), []);
});
