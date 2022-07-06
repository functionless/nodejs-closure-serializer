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

test("call the exports.handler if isFactoryFunction", () => {
  function expensiveTask() {
    return "world";
  }

  return testCase({
    closure: () => {
      const expensive = expensiveTask();

      return (handleInput: string) => {
        return `${handleInput} ${expensive}`;
      };
    },
    args: ["hello"],
    expectResult: "hello world",
    isFactoryFunction: true,
  });
});

test("all binding patterns should be considered when detecting free variables", () => {
  const free = "free";

  return testCase({
    closure: (
      // argument identifier
      argument: string,
      // object binding pattern in argument
      { objArgument }: any,
      // array binding pattern in argument
      [arrayArgument]: any,
      // nested array binding pattern in argument
      { a: [arrayInObjectArgument] },
      // nested object binding pattern in argument
      { b: { objectBindingInObjectBindingArgument } }
    ) => {
      function notHoisted() {
        return "notHoisted";
      }

      const arrowFunction = () => "arrowFunction";

      const functionExpression = function () {
        return "functionExpression";
      };

      class ClassDeclaration {
        get() {
          return "ClassDeclaration";
        }
      }

      const ClassExpression = class {
        get() {
          return "ClassExpression";
        }
      };

      const NamedClassExpression = class NamedClassExpression {
        get() {
          return "NamedClassExpression";
        }
      };

      // single variable declaration with ts.Identifier
      const id = "id";

      // variable declaration list
      const a = "a",
        b = "b";

      // object binding pattern
      const {
        objPattern1,
        a: [arrayPatternInObject],
      } = {
        objPattern1: "objPattern1",
        a: ["arrayPatternInObject"],
      };
      // object binding patterns in a variable declaration list
      const { objPatternList1 } = {
          objPatternList1: "objPatternList1",
        },
        { objPatternList2 } = {
          objPatternList2: "objPatternList2",
        };

      // array binding pattern
      const [arrayPattern1, { objPatternInArray }] = [
        "arrayPattern1",
        { objPatternInArray: "objPatternInArray" },
      ];

      // array binding pattern list
      const [arrayPatternList1] = ["arrayPatternList1"],
        [arrayPatternList2] = ["arrayPatternList2"];

      return [
        argument,
        objArgument,
        arrayArgument,
        arrayInObjectArgument,
        objectBindingInObjectBindingArgument,
        free,
        id,
        a,
        b,
        objPattern1,
        arrayPatternInObject,
        objPatternList1,
        objPatternList2,
        arrayPattern1,
        objPatternInArray,
        arrayPatternList1,
        arrayPatternList2,
        notHoisted(),
        hoisted(),
        arrowFunction(),
        functionExpression(),
        new ClassDeclaration().get(),
        new ClassExpression().get(),
        new NamedClassExpression().get(),
      ];

      function hoisted() {
        return "hoisted";
      }
    },
    args: [
      "argument",
      { objArgument: "objArgument" },
      ["arrayArgument"],
      { a: ["arrayInObjectArgument"] },
      {
        b: {
          objectBindingInObjectBindingArgument:
            "objectBindingInObjectBindingArgument",
        },
      },
    ],
    expectResult: [
      "argument",
      "objArgument",
      "arrayArgument",
      "arrayInObjectArgument",
      "objectBindingInObjectBindingArgument",
      "free",
      "id",
      "a",
      "b",
      "objPattern1",
      "arrayPatternInObject",
      "objPatternList1",
      "objPatternList2",
      "arrayPattern1",
      "objPatternInArray",
      "arrayPatternList1",
      "arrayPatternList2",
      "notHoisted",
      "hoisted",
      "arrowFunction",
      "functionExpression",
      "ClassDeclaration",
      "ClassExpression",
      "NamedClassExpression",
    ],
  });
});

async function testCase<
  F extends (...args: any[]) => any,
  T,
  IsFactoryFunction extends boolean = false
>(testCase: {
  closure: F;
  isFactoryFunction?: IsFactoryFunction;
  args?: any;
  expectResult: T;
}) {
  const { closure, args, expectResult, isFactoryFunction } = testCase;
  const serialized = await serializeFunction(closure, {
    isFactoryFunction,
  });
  expect(serialized).toMatchSnapshot();
  const fileName = path.join(__dirname, `${uuid.v4()}.js`);
  try {
    fs.writeFileSync(fileName, serialized);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    let js = require(fileName).handler;
    let actualResult: any = js(...(args ?? []));
    if (typeof actualResult?.then === "function") {
      actualResult = await actualResult;
    }
    expect(actualResult).toEqual(expectResult);
  } finally {
    fs.rmSync(fileName);
  }
}
