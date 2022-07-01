import fs from "fs";
import path from "path";
import { serializeClosure } from "../src/closure/serializeClosure2";

test("capturing a reference to a function", () => {
  function foo() {
    return "hello";
  }

  return {
    closure: () => foo(),
    args: [],
    expectResult: "hello",
  };
});

test("capturing a reference to a string", () => {
  const foo = "hello";

  return {
    closure: () => foo,
    args: [],
    expectResult: foo,
  };
});

test("capturing a reference to an array", () => {
  const foo = ["hello"];

  return {
    closure: () => foo,
    args: [],
    expectResult: foo,
  };
});

test("capturing a reference to an array containing a function", () => {
  function bar() {
    return "hello";
  }

  const foo = [bar];

  return {
    closure: () => foo,
    args: [],
    expectResult: [expect.any(Function)],
  };
});

test("value captured multiple times is only emitted once", () => {
  function bar() {
    return "hello";
  }

  const b = bar; // even if the value is captured indirectly
  const foo = [bar, bar, b];

  return {
    closure: () => foo,
    args: [],
    expectResult: [
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    ],
  };
});

test("capturing a reference to a native bound function", () => {
  function foo() {
    return this.internal;
  }

  const f = foo.bind({
    internal: "value",
  });

  return {
    closure: () => f(),
    args: [],
    expectResult: "value",
  };
});

test("arrow function nested within a function", () => {
  function foo() {
    return ((val) => `${val} ${this.internal}`)("hello");
  }

  return {
    closure: foo.bind({ internal: "value" }),
    args: [],
    expectResult: "hello value",
  };
});

function test<F extends (...args: any[]) => any, T>(
  title: string,
  testCase: () => {
    closure: F;
    args: Parameters<F> extends never[] ? [] : Parameters<F>;
    expectResult: T;
  }
) {
  it(title, async () => {
    const { closure, args, expectResult } = testCase();
    const serialized = await serializeClosure(closure);
    expect(serialized).toMatchSnapshot();
    const fileName = path.join(__dirname, `${title}.js`);
    try {
      fs.writeFileSync(fileName, serialized);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const js = require(fileName).handler;
      let actualResult: any = js(...args);
      if (typeof actualResult?.then === "function") {
        actualResult = await actualResult;
      }
      expect(actualResult).toEqual(expectResult);
    } finally {
      // fs.rmSync(fileName);
    }
  });
}
