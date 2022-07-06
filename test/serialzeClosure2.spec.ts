import fs from "fs";
import path from "path";
import * as uuid from "uuid";
import { serializeFunction } from "../src/closure/serializeClosure2";

test("capturing a reference to a function", () => {
  function foo() {
    return "hello";
  }

  return testCase({
    closure: () => foo(),
    expectResult: "hello",
  });
});

test("capturing a reference to a string", () => {
  const foo = "hello";

  return testCase({
    closure: () => foo,
    expectResult: foo,
  });
});

test("capturing a reference to an array", () => {
  const foo = ["hello"];

  return testCase({
    closure: () => foo,
    expectResult: foo,
  });
});

test("capturing a reference to an array containing a function", () => {
  function bar() {
    return "hello";
  }

  const foo = [bar];

  return testCase({
    closure: () => foo,
    expectResult: [expect.any(Function)],
  });
});

test("value captured multiple times is only emitted once", () => {
  function bar() {
    return "hello";
  }

  const b = bar; // even if the value is captured indirectly
  const foo = [bar, bar, b];

  return testCase({
    closure: () => foo,
    expectResult: [
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    ],
  });
});

test("capturing a reference to a native bound function", () => {
  function foo() {
    return this.internal;
  }

  const f = foo.bind({
    internal: "value",
  });

  return testCase({
    closure: () => f(),
    expectResult: "value",
  });
});

test("arrow function nested within a function", () => {
  function foo() {
    return ((val) => `${val} ${this.internal}`)("hello");
  }

  return testCase({
    closure: foo.bind({ internal: "value" }),
    expectResult: "hello value",
  });
});

test("class method", () => {
  class Foo {
    constructor(readonly internal: string) {}
    foo() {
      return this.internal;
    }
  }

  const foo = new Foo("hello");

  return testCase({
    closure: () => foo.foo(),
    expectResult: "hello",
  });
});

test("super class method", () => {
  class Foo {
    constructor(readonly internal: string) {}
    foo() {
      return this.internal;
    }
  }
  class Bar extends Foo {}

  const foo = new Bar("hello");

  return testCase({
    closure: () => foo.foo(),
    expectResult: "hello",
  });
});

test("class with prototype swapped", () => {
  class A {
    constructor(readonly internal: string) {}

    foo() {
      return `${this.internal} a`;
    }
  }
  class B {
    constructor(readonly internal: string) {}

    foo() {
      return `${this.internal} b`;
    }
  }

  class C extends A {}
  Object.setPrototypeOf(C, B);

  return testCase({
    closure: () => new C("value").foo(),
    expectResult: "value b",
  });
});

test("class mix-in", () => {
  const mixin = (Base: new (internal: string) => any) =>
    class extends Base {
      constructor(internal: string) {
        super(internal);
      }
      foo() {
        return this.internal;
      }
    };

  const A = mixin(
    class {
      constructor(readonly internal: string) {}
    }
  );

  const a = new A("value");
  return testCase({
    closure: () => a.foo(),
    expectResult: "value",
  });
});

test("traditional function prototype class", () => {
  function Animal(noise: string) {
    this.noise = noise;
  }
  Animal.prototype.speak = function () {
    return this.noise;
  };
  const animal = new Animal("bork");

  function Dog(noise: string) {
    Animal.call(this, `bark ${noise}`);
  }
  Object.setPrototypeOf(Dog.prototype, Animal.prototype);

  return testCase({
    closure: () => [new Dog("woof").speak(), animal.speak()],
    expectResult: ["bark woof", "bork"],
  });
});

async function testCase<F extends (...args: any[]) => any, T>(testCase: {
  closure: F;
  args?: Parameters<F> extends never[] ? [] : Parameters<F>;
  expectResult: T;
}) {
  const { closure, args, expectResult } = testCase;
  const serialized = await serializeFunction(closure);
  expect(serialized).toMatchSnapshot();
  const fileName = path.join(__dirname, `${uuid.v4()}.js`);
  try {
    fs.writeFileSync(fileName, serialized);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const js = require(fileName).handler;
    let actualResult: any = js(...(args ?? []));
    if (typeof actualResult?.then === "function") {
      actualResult = await actualResult;
    }
    expect(actualResult).toEqual(expectResult);
  } finally {
    fs.rmSync(fileName);
  }
}
