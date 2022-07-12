import fs from "fs";
import path from "path";
import * as uuid from "uuid";
import { serializeFunction, SerializeFunctionProps } from "../src";

test("maintain captured value", async () => {
  let i = 0;

  function foo() {
    i += 1;
  }

  function bar() {
    return i;
  }

  const handler = () => {
    foo();
    return bar();
  };

  await serializeFunction(handler);
});

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

test("capturing a reference to a native bound method", () => {
  class F {
    internal: string;
    foo(a, { b }, [c]) {
      return [this.internal, a, b, c];
    }
  }

  const f = new F();
  const func = f.foo.bind({
    internal: "value",
  });

  return testCase({
    closure: () => func("a", { b: "b" }, ["c"]),
    expectResult: ["value", "a", "b", "c"],
  });
});

test("capturing a reference to a native bound async method", () => {
  class F {
    internal: string;
    async foo() {
      return this.internal;
    }
  }

  const f = new F();
  const func = f.foo.bind({
    internal: "value",
  });

  return testCase({
    closure: () => func(),
    expectResult: "value",
  });
});

test("capturing a reference to a native bound generator method", () => {
  class F {
    i: number = 0;
    *foo() {
      while ((this.i += 1) <= 1) {
        yield "hello";
      }
    }
  }

  const f = new F();
  const func = f.foo.bind(f);

  return testCase({
    closure: () => func(),
    expectResult: (generator: any) => {
      const values: any[] = [];
      for (const i of generator) {
        values.push(i);
      }
      expect(values).toEqual(["hello"]);
    },
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

test("call method on class with prototype swapped", () => {
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
  Object.setPrototypeOf(C.prototype, B.prototype);

  return testCase({
    closure: () => new C("value").foo(),
    expectResult: "value b",
  });
});

test("call static method on class with prototype swapped", () => {
  class A {
    static foo() {
      return "A";
    }
  }
  class B {
    static foo() {
      return "B";
    }
  }

  class C extends A {}
  Object.setPrototypeOf(C, B);
  Object.setPrototypeOf(C.prototype, B.prototype);

  return testCase({
    closure: () => C.foo(),
    expectResult: "B",
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

test("call method on traditional function prototype class", () => {
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

  class FreeClass {}

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

      class ClassDeclaration extends FreeClass {
        //                              ^ free

        constructor(readonly text: string = "ClassDeclaration") {
          super();
        }

        get() {
          return "ClassDeclaration";
        }
      }

      const ClassExpression = class extends FreeClass {
        //                                    ^ free
        get() {
          return "ClassExpression";
        }
      };

      const NamedClassExpression = class NamedClassExpression extends FreeClass {
        //                                                              ^ free
        get() {
          return "NamedClassExpression";
        }
      };

      function SuperClass(text: string) {
        this.text = text;
      }
      SuperClass.prototype.get = function () {
        return this.text;
      };
      function TraditionalClass() {
        SuperClass.call(this, "TraditionalClass");
      }
      Object.setPrototypeOf(TraditionalClass.prototype, SuperClass.prototype);

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
        new TraditionalClass().get(),
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
      "TraditionalClass",
    ],
  });
});

test("should not capture global values as free variables", () => {
  return testCase({
    closure: () => {
      // Object.getOwnPropertyNames(global).sort().join(';\n')

      // $0;
      // $1;
      // $2;
      // $3;
      // $4;
      // $_;
      AbortController;
      AbortSignal;
      // AggregateError;
      Array;
      ArrayBuffer;
      Atomics;
      BigInt;
      BigInt64Array;
      BigUint64Array;
      Boolean;
      Buffer;
      DataView;
      Date;
      Error;
      EvalError;
      Event;
      EventTarget;
      // FinalizationRegistry;
      Float32Array;
      Float64Array;
      Function;
      Infinity;
      Int16Array;
      Int32Array;
      Int8Array;
      Intl;
      JSON;
      Map;
      Math;
      NaN;
      Number;
      Object;
      Promise;
      Proxy;
      RangeError;
      ReferenceError;
      Reflect;
      RegExp;
      Set;
      SharedArrayBuffer;
      String;
      Symbol;
      SyntaxError;
      TextDecoder;
      TextEncoder;
      TypeError;
      URIError;
      URL;
      URLSearchParams;
      Uint16Array;
      Uint32Array;
      Uint8Array;
      Uint8ClampedArray;
      WeakMap;
      // WeakRef;
      WeakSet;
      WebAssembly;
      // afterAll;
      // afterEach;
      atob;
      // beforeAll;
      // beforeEach;
      btoa;
      // clear;
      clearImmediate;
      clearInterval;
      clearTimeout;
      console;
      // copy;
      // debug;
      decodeURI;
      decodeURIComponent;
      describe;
      // dir;
      // dirxml;
      encodeURI;
      encodeURIComponent;
      escape;
      eval;
      // expect;
      // fdescribe;
      // fit;
      global;
      globalThis;
      // inspect;
      isFinite;
      isNaN;
      // it;
      // jest-symbol-do-not-touch;
      // keys;
      // monitor;
      parseFloat;
      parseInt;
      performance;
      process;
      // profile;
      // profileEnd;
      // queryObjects;
      queueMicrotask;
      // require; // can't test this, stupid jest overrides it and we end up traversing all of JEST
      setImmediate;
      setInterval;
      setTimeout;
      // table;
      // test;
      // ts - jest;
      // undebug;
      undefined;
      unescape;
      // unmonitor;
      // values;
      // xdescribe;
      // xit;
      // xtest;
    },
    expectResult: undefined,
  });
});

async function testCase<
  F extends (...args: any[]) => any,
  T,
  IsFactoryFunction extends boolean = false
>(testCase: {
  preSerializeValue?: SerializeFunctionProps["preSerializeValue"];
  closure: F;
  isFactoryFunction?: IsFactoryFunction;
  args?: any;
  expectResult: T | ((t: T) => void);
}) {
  const { closure, args, expectResult, isFactoryFunction, preSerializeValue } =
    testCase;
  const serialized = await serializeFunction(closure, {
    isFactoryFunction,
    preSerializeValue,
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
    if (typeof expectResult === "function") {
      (<any>expectResult)(actualResult);
    } else {
      expect(actualResult).toEqual(expectResult);
    }
  } finally {
    fs.rmSync(fileName);
  }
}
