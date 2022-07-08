// Copyright 2016-2018, Pulumi Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/* eslint-disable */

import { serializeFunction } from "../src";
import { assertAsyncThrows, asyncTest } from "./util";
import { platformIndependentEOL } from "./constants";
import ts from "typescript";
import * as semver from "semver";
import { z } from "./mockpackage/lib";

import os from "os";
import path from "path";
import fs from "fs";

import * as deploymentOnlyModule from "./deploymentOnlyModule";

interface ClosureCase {
  pre?: () => void; // an optional function to run before this case.
  title: string; // a title banner for the test case.
  func?: Function; // the function whose body and closure to serialize.
  factoryFunc?: Function; // the function whose body and closure to serialize (as a factory).
  expectText?: string; // optionally also validate the serialization to JavaScript text.
  snapshot?: boolean; // optionally snapshot the outputs
  error?: string; // error message we expect to be thrown if we are unable to serialize closure.
  afters?: ClosureCase[]; // an optional list of test cases to run afterwards.
  transformers?: ts.TransformerFactory<ts.Node>[];
  inputArguments?: any[];
  expectResult?: any; // optional value - if defined, then the closure will be invoked with this result expected
  expectThrow?: any; // optional value - if defined, then the closure will be invoked with the exception expected
  noClean?: boolean; // set to true to disable the removal of generated closure source file
  skip?: boolean; // set to true to still pass tests even if the test fails
}

/** @internal */
export const exportedValue = 42;

// This group of tests ensure that we serialize closures properly.
describe("closure", () => {
  const cases: ClosureCase[] = [];

  cases.push({
    title: "Empty function closure",
    func: function () {},
    expectResult: undefined,
    snapshot: true,
  });

  cases.push({
    title: "Empty named function",
    func: function f() {},
    snapshot: true,
    expectResult: undefined,
  });

  cases.push({
    title: "Named function with self-reference",
    func: function f() {
      if (false) {
        f();
      }
    },
    snapshot: true,
    expectResult: undefined,
  });

  cases.push({
    title: "Function closure with this capture",
    func: function () {
      return 0;
    },
    snapshot: true,
    expectResult: 0,
  });

  cases.push({
    title: "Function closure with this and arguments capture",
    // @ts-ignore: this is just test code.
    func: function () {
      console.log(this + arguments);
    },
    snapshot: true,
    expectResult: undefined,
  });

  cases.push({
    title: "Empty arrow closure",
    func: () => {},
    snapshot: true,
    expectResult: undefined,
  });

  cases.push({
    title: "Arrow closure with this capture",
    func: () => {
      return (<any>this)?.value;
    },
    error: `Error serializing function 'func'

function 'func': which could not be serialized because
  arrow function captured 'this'. Assign 'this' to another name outside function and capture that.

Function code:
  () => {
              return this === null || this === void 0 ? void 0 : this.value;
          }
`,
  });

  cases.push({
    title: "Async lambda that does not capture this",
    func: async () => {},
    snapshot: true,
    expectResult: undefined,
  });

  cases.push({
    title: "Async lambda that does capture this",
    // @ts-ignore: this is just test code.
    func: async () => {
      console.log(this);
      return 0;
    },
    snapshot: true,
    expectResult: 0,
  });

  cases.push({
    title: "Async function that does not capture this",
    func: async function () {},
    snapshot: true,
    expectResult: undefined,
  });

  cases.push({
    title: "Async function that does capture this",
    func: async function () {
      console.log(this);
      return 0;
    },
    snapshot: true,
    expectResult: 0,
  });

  cases.push({
    title: "Arrow closure with this and arguments capture",
    // @ts-ignore: this is just test code.
    func: function () {
      return () => {
        console.log(this + arguments);
      };
    }.apply(this, [0, 1]),
    error: `Error serializing function '<anonymous>'

function '<anonymous>': which could not be serialized because
  arrow function captured 'this'. Assign 'this' to another name outside function and capture that.

Function code:
  () => {
                  console.log(this + arguments);
              }
`,
  });

  cases.push({
    title: "Arrow closure with this capture inside function closure",
    func: function () {
      () => {
        console.log(this);
      };
      return 0;
    },
    snapshot: true,
    expectResult: 0,
  });

  cases.push({
    title:
      "Arrow closure with this and arguments capture inside function closure",
    // @ts-ignore: this is just test code.
    func: function () {
      () => {
        console.log(this + arguments);
      };
    },
    snapshot: true,
    expectResult: undefined,
  });

  {
    class Task {
      run: any;
      constructor() {
        this.run = async function () {
          return 0;
        };
      }
    }

    const task = new Task();

    cases.push({
      title: "Invocation of async function that does not capture this #1",
      func: async function () {
        return await task.run();
      },
      snapshot: true,
      expectResult: 0,
    });
  }

  {
    class Task {
      run: any;
      constructor() {
        this.run = async function () {
          return 0;
        };
      }
    }

    const task = new Task();

    cases.push({
      title: "Invocation of async function that does capture this #1",
      func: async function () {
        return await task.run();
      },
      snapshot: true,
      expectResult: 0,
    });
  }

  {
    class Task {
      run: any;
      constructor() {
        this.run = async () => {};
      }
    }

    const task = new Task();

    cases.push({
      title: "Invocation of async lambda that does not capture this #1",
      func: async function () {
        await task.run();
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    class Task {
      run: any;
      constructor() {
        this.run = async () => {
          console.log(this);
          return 0;
        };
      }
    }

    const task = new Task();

    cases.push({
      title: "Invocation of async lambda that capture this #1",
      func: async function () {
        await task.run();
      },
      error: `Error serializing function 'func'

function 'func': captured
  variable 'task' which indirectly referenced
    function '<anonymous>': which could not be serialized because
      arrow function captured 'this'. Assign 'this' to another name outside function and capture that.

Function code:
  () => __awaiter(this, void 0, void 0, function* () {
                      console.log(this);
                      return 0;
                  })
`,
    });
  }

  cases.push({
    title: "Empty function closure w/ args",
    func: function (x: any, y: any, z: any) {},
    snapshot: true,
    expectResult: undefined,
  });

  cases.push({
    title: "Empty arrow closure w/ args",
    func: (x: any, y: any, z: any) => {},
    snapshot: true,
    expectResult: undefined,
  });

  // Serialize captures.
  cases.push({
    title: "Doesn't serialize global captures",
    func: () => {
      console.log("Just a global object reference");
    },
    snapshot: true,
    expectResult: undefined,
  });
  {
    const a = -0;
    const b = -0.0;
    const c = Infinity;
    const d = -Infinity;
    const e = NaN;
    const f = Number.MAX_SAFE_INTEGER;
    const g = Number.MAX_VALUE;
    const h = Number.MIN_SAFE_INTEGER;
    const i = Number.MIN_VALUE;

    cases.push({
      title: "Handle edge-case literals",
      func: () => {
        const x = [a, b, c, d, e, f, g, h, i];
      },
      snapshot: true,
      expectResult: undefined,
    });
  }
  {
    const wcap = "foo";
    const xcap = 97;
    const ycap = [true, -1, "yup"];
    const zcap = {
      a: "a",
      b: false,
      c: [0],
    };
    cases.push({
      title: "Serializes basic captures",
      func: () => {
        return wcap + `${xcap}` + ycap.length + zcap.a + zcap.b + zcap.c;
      },
      snapshot: true,
      expectResult: wcap + `${xcap}` + ycap.length + zcap.a + zcap.b + zcap.c,
    });
  }
  {
    let nocap1 = 1,
      nocap2 = 2,
      nocap3 = 3,
      nocap4 = 4,
      nocap5 = 5,
      nocap6 = 6,
      nocap7 = 7;
    let nocap8 = 8,
      nocap9 = 9,
      nocap10 = 10;
    let cap1 = 100,
      cap2 = 200,
      cap3 = 300,
      cap4 = 400,
      cap5 = 500,
      cap6 = 600,
      cap7 = 700;
    let cap8 = 800;

    const functext = `(nocap1, nocap2) => {
  let zz = nocap1 + nocap2; // not a capture: args
  let yy = nocap3; // not a capture: var later on
  if (zz) {
      zz += cap1; // true capture
      let cap1 = 9; // because let is properly scoped
      zz += nocap4; // not a capture
      var nocap4 = 7; // because var is function scoped
      zz += cap2; // true capture
      const cap2 = 33;
      var nocap3 = 8; // block the above capture
  }
  let f1 = (nocap5) => {
      yy += nocap5; // not a capture: args
      cap3++; // capture
  };
  let f2 = (function (nocap6) {
      zz += nocap6; // not a capture: args
      if (cap4) { // capture
          yy = 0;
      }
  });
  let www = nocap7(); // not a capture; it is defined below
  if (true) {
      function nocap7() {
      }
  }
  let [{t: [nocap8]},nocap9 = "hello",...nocap10] = [{t: [true]},null,undefined,1,2];
  let vvv = [nocap8, nocap9, nocap10]; // not a capture; declarations from destructuring
  let aaa = { // captures in property and method declarations
      [cap5]: cap6,
      [cap7]() {
          cap8
      }
  }
}`;
    cases.push({
      title: "Doesn't serialize non-free variables (but retains frees)",
      func: eval(functext),
      snapshot: true,
    });
  }
  {
    let nocap1 = 1;
    let cap1 = 100;

    cases.push({
      title: "Complex capturing cases #1",
      func: () => {
        // cap1 is captured here.
        // nocap1 introduces a new variable that shadows the outer one.
        let [nocap1 = cap1] = [];
        console.log(nocap1);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }
  {
    let nocap1 = 1;
    let cap1 = 100;

    cases.push({
      title: "Complex capturing cases #2",
      func: () => {
        // cap1 is captured here.
        // nocap1 introduces a new variable that shadows the outer one.
        let { nocap1 = cap1 } = {};
        console.log(nocap1);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }
  {
    let nocap1 = 1;
    let cap1 = 100;

    cases.push({
      title: "Complex capturing cases #3",
      func: () => {
        // cap1 is captured here.
        // nocap1 introduces a new variable that shadows the outer one.
        let { x: nocap1 = cap1 } = {};
        console.log(nocap1);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  cases.push({
    title: "Don't capture built-ins",
    func: () => {
      let x: any = eval("undefined + null + NaN + Infinity + __filename");
      require("os");
    },
    snapshot: true,
    expectResult: undefined,
  });

  {
    const os = require("os");

    cases.push({
      title: "Capture built in module by ref",
      func: () => os,
      snapshot: true,
      expectResult: os,
    });
  }

  {
    const os = require("os");

    cases.push({
      title: "Wrapped lambda function",
      func: (a: any, b: any, c: any) => {
        const v = os;
        return { v };
      },
      snapshot: true,
    });
  }

  {
    const os = require("os");
    function wrap(handler: Function) {
      return () => handler;
    }

    const func = wrap(() => os);

    cases.push({
      title: "Capture module through indirect function references",
      func: func,
      snapshot: true,
    });
  }

  {
    const util = require("./util");
    cases.push({
      title: "Capture user-defined module by value",
      func: () => util,
      // expectResult: util,
      snapshot: true,
    });
  }

  cases.push({
    title: "Don't capture catch variables",
    func: () => {
      try {
      } catch (err) {
        console.log(err);
      }
    },
    snapshot: true,
    expectResult: undefined,
  });

  {
    const defaultValue = 1;

    cases.push({
      title: "Capture default parameters",
      func: (arg: any = defaultValue) => {},
      snapshot: true,
      expectResult: undefined,
    });
  }

  // Recursive function serialization.
  {
    const fff = "fff!";
    const ggg = "ggg!";
    const xcap = {
      fff: function () {
        console.log(fff);
      },
      ggg: () => {
        console.log(ggg);
      },
      zzz: {
        a: [
          (a1: any, a2: any) => {
            console.log(a1 + a2);
          },
        ],
      },
    };
    const func = () => {
      xcap.fff();
      xcap.ggg();
      xcap.zzz.a[0]("x", "y");
    };

    cases.push({
      title: "Serializes recursive function captures",
      func: func,
      expectResult: undefined,
      snapshot: true,
    });
  }

  {
    class CapCap {
      constructor() {
        (<any>this).x = 42;
        (<any>this).f = () => {
          console.log((<any>this).x);
        };
      }
    }

    const cap: any = new CapCap();

    cases.push({
      title: "Serializes `this` capturing arrow functions",
      func: cap.f,
      error: `Error serializing function '<anonymous>'

function '<anonymous>': which could not be serialized because
  arrow function captured 'this'. Assign 'this' to another name outside function and capture that.

Function code:
  () => {
                      console.log(this.x);
                  }
`,
    });
  }

  const func = function () {
    return this.value;
  };
  func.value = "value";

  cases.push({
    title: "Don't serialize `this` in function expressions",
    func: () => func.call(func),
    snapshot: true,
    expectResult: "value",
  });

  {
    const mutable: any = {};
    cases.push({
      title:
        "Serialize mutable objects by value at the time of capture (pre-mutation)",
      func: function () {
        return mutable;
      },
      snapshot: true,
      expectResult: {},
      afters: [
        {
          pre: () => {
            mutable.timesTheyAreAChangin = true;
          },
          title:
            "Serialize mutable objects by value at the time of capture (post-mutation)",
          func: function () {
            return mutable;
          },
          snapshot: true,
          expectResult: { timesTheyAreAChangin: true },
        },
      ],
    });
  }

  {
    const obj = {
      method1() {
        return this.method2();
      },
      method2: () => {
        return;
      },
    };

    cases.push({
      title: "Capture object with methods",
      func: function () {
        console.log(obj);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    cases.push({
      title: "Undeclared variable in typeof",
      // @ts-ignore
      func: function () {
        const x = typeof a;
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const a = 0;
    cases.push({
      title: "Declared variable in typeof",
      // @ts-ignore
      func: function () {
        const x = typeof a;
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const array: any[] = [];
    const obj = { 80: "foo", arr: array };
    array.push(obj);

    cases.push({
      title: "Capture numeric property",
      func: function () {
        return array;
      },
      snapshot: true,
      expectResult: array,
    });
  }

  {
    const outer: any = { o: 1 };
    const array = [outer];
    outer.b = array;
    const C = (function () {
      function C() {}
      C.prototype.m = function () {
        return this.n() + outer;
      };
      C.prototype.n = function () {
        return array;
      };
      (<any>C).m = function () {
        return this.n();
      };
      return C;
    })();

    cases.push({
      title: "Serialize es5-style class",
      func: () => new C().n(),
      snapshot: true,
      expectResult: array,
    });
  }

  {
    const outer: any = { o: 1 };
    const array = [outer];
    outer.b = array;
    class C {
      public static s() {
        return array;
      }
      public m() {
        return this.n();
      }
      public n() {
        return outer;
      }
    }
    cases.push({
      title: "Serialize class",
      func: () => C.s(),
      snapshot: true,
      expectResult: array,
    });
  }

  {
    class C {
      private x: number;
      public static s(c: C) {
        return c.n();
      }
      constructor() {
        this.x = 1;
      }
      public m() {
        return this.n();
      }
      public n() {
        return this.x;
      }
    }
    cases.push({
      title: "Serialize class with constructor and field",
      func: () => C.s(new C()),
      snapshot: true,
      expectResult: 1,
    });
  }

  {
    class C {
      private x: number;
      public static s() {
        return 0;
      }
      constructor() {
        this.x = 1;
      }
      public m() {
        return this.n();
      }
      public n() {
        return this.x;
      }
    }
    cases.push({
      title: "Serialize constructed class",
      func: () => new C(),
      snapshot: true,
      expectResult: { x: 1 },
    });
  }

  {
    class C {
      public m() {
        return this.n();
      }
      public n() {
        return 0;
      }
    }
    const c = new C();

    cases.push({
      title: "Serialize instance class methods",
      func: () => c.m(),
      snapshot: true,
      expectResult: 0,
    });
  }

  {
    class C {
      public m() {
        return this.n();
      }
      public n() {
        return 0;
      }
    }
    cases.push({
      title: "Serialize instance class methods, forget to bind",
      func: new C().m,
      snapshot: true,
      expectThrow: new TypeError("this.n is not a function"),
    });
  }

  {
    class C {
      public delete() {
        return 0;
      }
    }
    cases.push({
      title: "Serialize method with reserved name",
      func: new C().delete,
      snapshot: true,
      expectResult: 0,
    });
  }

  {
    class C {
      public static m() {
        return C.n();
      }
      public static n() {
        return 0;
      }
    }
    cases.push({
      title: "Serialize static class methods",
      func: C.m,
      snapshot: true,
      expectResult: 0,
    });
  }

  // TODO: currently broken
  // {
  //   class C {
  //     public static m() {
  //       return this.n();
  //     }
  //     public static n() {
  //       return 0;
  //     }
  //   }
  //   cases.push({
  //     title: "Serialize static class methods with this reference",
  //     func: C.m,
  //     snapshot: true,
  //     expectResult: 0,
  //   });
  // }

  // TODO: currently broken
  // {
  //   const D = (function () {
  //     function D() {}
  //     (<any>D).m = function () {
  //       return this.n();
  //     };
  //     (<any>D).n = function () {
  //       return 0;
  //     };
  //     return D;
  //   })();
  //   cases.push({
  //     title: "Serialize reference to static class methods (es5 class style)",
  //     func: (<any>D).m,
  //     snapshot: true,
  //     expectResult: undefined,
  //   });
  // }

  {
    const D = (function () {
      function D() {}
      (<any>D).m = function () {
        return this.n();
      };
      (<any>D).n = function () {
        return 0;
      };
      return D;
    })();
    cases.push({
      title:
        "Serialize arrow function calling static class methods (es5 class style)",
      func: () => (<any>D).m(),
      snapshot: true,
      expectResult: 0,
    });
  }

  {
    const array: any[] = [1];
    array.push(array);

    cases.push({
      title: "Cyclic object #1",
      func: () => array,
      snapshot: true,
      expectResult: array,
    });
  }

  {
    const obj: any = { a: 1 };
    obj.b = obj;

    cases.push({
      title: "Cyclic object #2",
      func: () => obj,
      snapshot: true,
      expectResult: obj,
    });
  }

  {
    const obj: any = { a: [] };
    obj.a.push(obj);
    obj.b = obj.a;

    cases.push({
      title: "Cyclic object #3",
      func: () => obj,
      snapshot: true,
      expectResult: obj,
    });
  }

  {
    const obj: any = { a: [] };
    obj.a.push(obj);
    obj.b = obj.a;
    const obj2 = [obj, obj];

    cases.push({
      title: "Cyclic object #4",
      func: () => obj2,
      snapshot: true,
      expectResult: obj2,
    });
  }

  {
    const obj: any = { a: 1 };

    function f1() {
      return obj;
    }
    function f2() {
      return obj;
    }

    cases.push({
      title: "Object captured across multiple functions",
      func: () => {
        f1();
        obj.a = 2;
        return f2();
      },
      snapshot: true,
      expectResult: { a: 2 },
    });
  }

  {
    const v = {};
    Object.defineProperty(v, "key", {
      configurable: true,
      value: 1,
    });
    cases.push({
      title: "Complex property descriptor #1",
      func: () => v,
      snapshot: true,
      expectResult: v,
    });
  }

  {
    const v = {};
    Object.defineProperty(v, "key", {
      writable: true,
      enumerable: true,
      value: 1,
    });
    cases.push({
      title: "Complex property descriptor #2",
      func: () => v,
      snapshot: true,
      expectResult: v,
    });
  }

  {
    const v = [1, 2, 3];
    delete v[1];

    cases.push({
      title: "Test array #1",
      func: () => v,
      snapshot: true,
      expectResult: [1, , 3],
    });
  }

  {
    const v = [1, 2, 3];
    delete v[1];
    (<any>v).foo = "";

    cases.push({
      title: "Test array #2",
      func: () => v,
      snapshot: true,
      expectResult: v,
    });
  }

  {
    const v = () => {
      return 1 + (<any>v).foo;
    };
    (<any>v).foo = "bar";

    cases.push({
      title: "Test function with property",
      func: v,
      snapshot: true,
      expectResult: "1bar",
    });
  }

  {
    const x = Object.create(null);
    const v = () => {
      return x;
    };

    cases.push({
      title: "Test null prototype",
      func: v,
      snapshot: true,
      expectResult: {},
    });
  }

  {
    const x = Object.create(Number.prototype);
    x.prop = "value";
    const v = () => {
      return x;
    };

    cases.push({
      title: "Test non-default object prototype",
      func: v,
      snapshot: true,
      expectResult: { prop: "value" },
    });
  }

  {
    const x = Object.create({
      x() {
        return v;
      },
    });
    const v = () => {
      return x;
    };

    cases.push({
      title: "Test recursive prototype object prototype",
      func: v,
      snapshot: true,
      expectResult: {},
    });
  }

  {
    const v = () => {
      return 0;
    };
    Object.setPrototypeOf(v, () => {
      return 1;
    });

    cases.push({
      title: "Test non-default function prototype",
      func: v,
      snapshot: true,
      expectResult: 0,
    });
  }

  {
    function* f() {
      yield 1;
    }

    cases.push({
      title: "Test generator func",
      func: () => {
        const arr: any[] = [];
        for (const i of f()) {
          arr.push(i);
        }
        return arr;
      },
      snapshot: true,
      expectResult: [1],
    });
  }

  {
    const gf = function* () {
      yield 1;
    };

    cases.push({
      title: "Test anonymous generator func",
      func: () => {
        let accum = 0;
        for (const i of gf()) {
          accum += i;
        }
        return accum;
      },
      snapshot: true,
      expectResult: 1,
    });
  }

  {
    class C {
      private _x: number;

      constructor() {
        this._x = 0;
      }

      get foo() {
        return this._x;
      }

      set foo(v: number) {
        this._x = v + 1;
      }
    }

    cases.push({
      title: "Test getter/setter #1",
      func: () => {
        const c = new C();
        c.foo = 1;
        return c.foo;
      },
      snapshot: true,
      expectResult: 2,
    });
  }

  {
    class C {
      static i = 1;
      static get foo() {
        return C.i;
      }

      static set foo(v: number) {
        C.i += v;
      }
    }

    cases.push({
      title: "Test getter/setter #2",
      func: () => {
        C.foo = 1;
        return C.foo;
      },
      snapshot: true,
      expectResult: 2,
    });
  }

  {
    const methodName = "method name";
    class C {
      [methodName](a: number) {
        return a;
      }
    }

    cases.push({
      title: "Test computed method name.",
      func: () => new C()[methodName](1),
      snapshot: true,
      expectResult: 1,
    });
  }

  {
    const sym = Symbol("test_symbol");
    class C {
      [sym](a: number) {
        return a;
      }

      getSym() {
        return sym;
      }
    }

    cases.push({
      title: "Test symbols #1",
      func: () => C,
      snapshot: true,
    });
  }

  {
    class C {
      *[Symbol.iterator]() {
        yield 1;
      }
    }

    cases.push({
      title: "Test Symbol.iterator",
      func: () => {
        const c = new C();
        return Array.from(c);
      },
      snapshot: true,
      expectResult: [1],
    });
  }

  {
    class D {
      public n: number;
      constructor(n: number) {
        this.n = n;
      }
      dMethod(x: number) {
        return x;
      }
      dVirtual() {
        return 1;
      }
    }
    class C extends D {
      constructor(n: number) {
        super(n + 1);
      }
      cMethod() {
        return (
          "" +
          super.dMethod +
          super["dMethod"] +
          super.dMethod(1) +
          super["dMethod"](2) +
          super.dMethod(super.dMethod(3))
        );
      }
      dVirtual() {
        return 3;
      }
    }

    cases.push({
      title: "Test class extension",
      func: () => {
        const c = new C(0);
        return [c.cMethod(), c.dVirtual()];
      },
      snapshot: true,
      expectResult: [
        `function __f3(__0) {
  return (function() {
    return function /*dMethod*/(x) {
                return x;
            };
  }).apply(undefined, undefined).apply(this, arguments);
}function __f3(__0) {
  return (function() {
    return function /*dMethod*/(x) {
                return x;
            };
  }).apply(undefined, undefined).apply(this, arguments);
}123`,
        3,
      ],
    });
  }

  {
    class A {
      public n: number;
      constructor(n: number) {
        this.n = n;
      }
      method(x: number) {
        return x;
      }
    }
    class B extends A {
      constructor(n: number) {
        super(n + 1);
      }
      method(n: number) {
        return 1 + super.method(n + 1);
      }
    }
    class C extends B {
      constructor(n: number) {
        super(n * 2);
      }
      method(n: number) {
        return 2 * super.method(n * 2);
      }
    }

    cases.push({
      title: "Three level inheritance",
      func: () => new C(1).method(2),
      snapshot: true,
      expectResult: new C(1).method(2),
    });
  }

  {
    const sym = Symbol.for("sym");

    class A {
      public n: number;
      constructor(n: number) {
        this.n = n;
      }
      public [sym](x: number) {
        return x;
      }
    }
    class B extends A {
      constructor(n: number) {
        super(n + 1);
      }
      // @ts-ignore
      public [sym](n: number) {
        return 1 + super[sym](n + 1);
      }
    }
    class C extends B {
      constructor(n: number) {
        super(n * 2);
      }
      // @ts-ignore
      public [sym](n: number) {
        return 2 * super[sym](n * 2);
      }
    }

    cases.push({
      title: "Three level inheritance with symbols",
      func: () => new C(1)[sym](1),
      snapshot: true,
      expectResult: new C(1)[sym](1),
    });
  }

  {
    const sym = Symbol();

    class A {
      public n: number;
      static method(x: number) {
        return x;
      }
      static [sym](x: number) {
        return x * x;
      }
      constructor(n: number) {
        this.n = n;
      }
    }
    class B extends A {
      static method(n: number) {
        return 1 + super.method(n + 1);
      }
      // @ts-ignore
      static [sym](x: number) {
        return x * super[sym](x + 1);
      }
      constructor(n: number) {
        super(n + 1);
      }
    }

    cases.push({
      title: "Two level static inheritance",
      func: () =>
        B.method(1) +
        B[sym](1) +
        new B(1).n +
        A.method(1) +
        A[sym](1) +
        new A(1).n,
      snapshot: true,
      expectResult:
        B.method(1) +
        B[sym](1) +
        new B(1).n +
        A.method(1) +
        A[sym](1) +
        new A(1).n,
    });
  }

  {
    const o = { a: 1, b: 2 };

    cases.push({
      title: "Capture subset of properties #1",
      func: function () {
        return o.a;
      },
      snapshot: true,
      expectResult: 1,
    });
  }

  {
    const o = { a: 1, b: 2 };

    cases.push({
      title: "Capture subset of properties #1.1",
      func: function () {
        return o["a"];
      },
      snapshot: true,
      expectResult: 1,
    });
  }

  {
    const o = { a: 1, b: 2, c: 3 };

    cases.push({
      title: "Capture subset of properties #2",
      func: function () {
        console.log(o.b + o.c);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = { a: 1, b: 2, c: 3 };

    cases.push({
      title: "Capture subset of properties #2.1",
      func: function () {
        console.log(o["b"] + o["c"]);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = { a: 1, b: 2, c: 3 };

    cases.push({
      title: "Capture all if object is used as is.",
      func: function () {
        console.log(o);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = {
      a: 1,
      b: 2,
      c() {
        return this;
      },
    };

    cases.push({
      title: "Capture all if object property is invoked, and it uses this. #1",
      func: function () {
        console.log(o.c());
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = {
      a: 1,
      b: 2,
      c() {
        return this;
      },
    };

    cases.push({
      title:
        "Capture all if object property is invoked, and it uses this. #1.1",
      func: function () {
        console.log(o["c"]());
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = {
      a: 1,
      b: 2,
      c() {
        const v = () => this;
      },
    };

    cases.push({
      title:
        "Capture all if object property is invoked, and it uses this in nested arrow function.",
      func: function () {
        console.log(o.c());
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    // @ts-ignore: this is just test code.
    const o = {
      a: 1,
      b: 2,
      c() {
        const v = function () {
          return this;
        };
      },
    };

    cases.push({
      title:
        "Capture one if object property is invoked, but it uses this in nested function.",
      func: function () {
        console.log(o.c());
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = {
      a: 1,
      b: 2,
      c() {
        return this;
      },
    };

    cases.push({
      title:
        "Capture one if object property is captured, uses this, but is not invoked. #1",
      func: function () {
        console.log(o.c);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = {
      a: 1,
      b: 2,
      c() {
        return this;
      },
    };

    cases.push({
      title:
        "Capture one if object property is captured, uses this, but is not invoked. #1.1",
      func: function () {
        console.log(o["c"]);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = {
      a: 1,
      b: 2,
      c() {
        return 0;
      },
    };

    cases.push({
      title:
        "Capture one if object property is invoked, and it does not use this. #1",
      func: function () {
        console.log(o.c());
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = {
      a: 1,
      b: 2,
      c() {
        return 0;
      },
    };

    cases.push({
      title:
        "Capture one if object property is invoked, and it does not use this. #1.1",
      func: function () {
        console.log(o["c"]());
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = {
      a: 1,
      b: {
        c() {
          return this;
        },
      },
    };

    cases.push({
      title: "Capture subset if sub object property is invoked. #1",
      func: function () {
        console.log(o.b.c());
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = {
      a: 1,
      b: {
        c() {
          return this;
        },
      },
    };

    cases.push({
      title: "Capture subset if sub object property is invoked. #1.1",
      func: function () {
        console.log(o["b"]["c"]());
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = {
      a: 1,
      get b() {
        return this;
      },
    };

    cases.push({
      title: "Capture all if getter and getter uses this. #1",
      func: function () {
        console.log(o.b);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = {
      a: 1,
      get b() {
        return this;
      },
    };

    cases.push({
      title: "Capture all if getter and getter uses this. #1.1",
      func: function () {
        console.log(o["b"]);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = {
      a: 1,
      get b() {
        return 0;
      },
    };

    cases.push({
      title: "Capture one if getter and getter does not use this. #1",
      func: function () {
        console.log(o.b);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = {
      a: 1,
      get b() {
        return 0;
      },
    };

    cases.push({
      title: "Capture one if getter and getter does not use this. #1.1",
      func: function () {
        console.log(o["b"]);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = { a: 1, b: 1, c: 2 };
    function f1() {
      console.log(o.a);
      f2();
    }

    function f2() {
      console.log(o.c);
    }

    cases.push({
      title: "Capture multi props from different contexts #1",
      func: f1,
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = { a: 1, b: 1, c: 2 };
    function f1() {
      console.log(o["a"]);
      f2();
    }

    function f2() {
      console.log(o["c"]);
    }

    cases.push({
      title: "Capture multi props from different contexts #1.1",
      func: f1,
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = { a: 1 };
    function f1() {
      // @ts-ignore
      console.log(o.c);
    }

    cases.push({
      title: "Do not capture non-existent prop #1",
      func: f1,
      expectResult: undefined,
      snapshot: true,
    });
  }

  {
    const o = { a: 1 };
    function f1() {
      // @ts-ignore
      console.log(o["c"]);
    }

    cases.push({
      title: "Do not capture non-existent prop #1.1",
      func: f1,
      expectResult: undefined,
      snapshot: true,
    });
  }

  {
    const o = { a: 1, b: 1, c: 2 };
    function f1() {
      console.log(o.a);
      f2();
    }

    function f2() {
      console.log(o);
    }

    cases.push({
      title: "Capture all props from different contexts #1",
      func: f1,
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = { a: 1, b: 1, c: 2 };
    function f1() {
      console.log(o["a"]);
      f2();
    }

    function f2() {
      console.log(o);
    }

    cases.push({
      title: "Capture all props from different contexts #1.1",
      func: f1,
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = { a: 1, b: 1, c: 2 };
    function f1() {
      console.log(o);
      f2();
    }

    function f2() {
      console.log(o.a);
    }

    cases.push({
      title: "Capture all props from different contexts #2",
      func: f1,
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = { a: 1, b: 1, c: 2 };
    function f1() {
      console.log(o);
      f2();
    }

    function f2() {
      console.log(o["a"]);
    }

    cases.push({
      title: "Capture all props from different contexts #2.1",
      func: f1,
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    class C {
      a: number;
      b: number;

      constructor() {
        this.a = 1;
        this.b = 2;
      }

      m() {
        console.log(this);
        return 0;
      }
    }
    const o = new C();

    cases.push({
      title: "Capture all props if prototype is and uses this #1",
      func: function () {
        o.m();
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    class C {
      a: number;
      b: number;

      constructor() {
        this.a = 1;
        this.b = 2;
      }

      m() {
        console.log(this);
        return 0;
      }
    }
    const o = new C();

    cases.push({
      title: "Capture all props if prototype is and uses this #1.1",
      func: function () {
        o["m"]();
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    class C {
      a: number;
      b: number;

      constructor() {
        this.a = 1;
        this.b = 2;
      }

      m() {}
    }
    const o = new C();

    cases.push({
      title: "Capture no props if prototype is used but does not use this #1",
      func: function () {
        o.m();
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    class C {
      a: number;
      b: number;

      constructor() {
        this.a = 1;
        this.b = 2;
      }

      m() {}
    }
    const o = new C();

    cases.push({
      title: "Capture no props if prototype is used but does not use this #1.1",
      func: function () {
        o["m"]();
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    class C {
      a: number;

      constructor() {
        this.a = 1;
      }

      m() {
        (<any>this).n();
      }
    }

    class D extends C {
      b: number;
      constructor() {
        super();
        this.b = 2;
      }
      n() {}
    }
    const o = new D();

    cases.push({
      title: "Capture all props if prototype is accessed #2",
      func: function () {
        o.m();
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    class C {
      a: number;

      constructor() {
        this.a = 1;
      }

      m() {
        (<any>this).n();
      }
    }

    class D extends C {
      b: number;
      constructor() {
        super();
        this.b = 2;
      }
      n() {}
    }
    const o = new D();

    cases.push({
      title: "Capture all props if prototype is accessed #2.1",
      func: function () {
        o["m"]();
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const table1: any = { primaryKey: 1, insert: () => {}, scan: () => {} };

    async function testScanReturnsAllValues() {
      await table1.insert({
        [table1.primaryKey]: "val1",
        value1: 1,
        value2: "1",
      });
      await table1.insert({
        [table1.primaryKey]: "val2",
        value1: 2,
        value2: "2",
      });

      const values = [];
      // @ts-ignore
      const value1 = values.find((v) => v[table1.primaryKey] === "val1");
      // @ts-ignore
      const value2 = values.find((v) => v[table1.primaryKey] === "val2");
    }

    cases.push({
      title: "Cloud table function",
      func: testScanReturnsAllValues,
      expectResult: undefined,
      snapshot: true,
    });
  }

  {
    const o = { a: 1, b: { x: 1, doNotCapture: true }, c: 2 };
    function f1() {
      console.log(o);
    }

    cases.push({
      title: "Do not capture #1",
      func: f1,
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = { a: 1, b: () => console.log("the actual function") };
    (<any>o.b).doNotCapture = true;

    function f1() {
      console.log(o);
    }

    cases.push({
      title: "Do not capture #2",
      func: f1,
      expectResult: undefined,
      snapshot: true,
    });
  }

  {
    const lambda1 = () => console.log(1);
    const lambda2 = () => console.log(1);

    function f3() {
      return lambda1(), lambda2();
    }

    cases.push({
      title: "Merge simple functions",
      func: f3,
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const awaiter1 = function (
      thisArg: any,
      _arguments: any,
      P: any,
      generator: any
    ) {
      return new (P || (P = Promise))(function (resolve: any, reject: any) {
        function fulfilled(value: any) {
          try {
            step(generator.next(value));
          } catch (e) {
            reject(e);
          }
        }
        function rejected(value: any) {
          try {
            step(generator["throw"](value));
          } catch (e) {
            reject(e);
          }
        }
        function step(result: any) {
          result.done
            ? resolve(result.value)
            : new P(function (resolve1: any) {
                resolve1(result.value);
              }).then(fulfilled, rejected);
        }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
      });
    };
    const awaiter2 = function (
      thisArg: any,
      _arguments: any,
      P: any,
      generator: any
    ) {
      return new (P || (P = Promise))(function (resolve: any, reject: any) {
        function fulfilled(value: any) {
          try {
            step(generator.next(value));
          } catch (e) {
            reject(e);
          }
        }
        function rejected(value: any) {
          try {
            step(generator["throw"](value));
          } catch (e) {
            reject(e);
          }
        }
        function step(result: any) {
          result.done
            ? resolve(result.value)
            : new P(function (resolve1: any) {
                resolve1(result.value);
              }).then(fulfilled, rejected);
        }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
      });
    };

    function f3() {
      const v1 = awaiter1,
        v2 = awaiter2;
    }

    cases.push({
      title: "Share __awaiter functions",
      func: f3,
      expectResult: undefined,
      snapshot: true,
    });
  }

  {
    cases.push({
      title: "Capture of exported variable #1",
      func: function () {
        console.log(exportedValue);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    cases.push({
      title: "Capture of exported variable #2",
      func: function () {
        console.log(exports.exportedValue);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    cases.push({
      title: "Capture of exported variable #3",
      func: function () {
        console.log(module.exports.exportedValue);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    function foo() {
      require("./util");
    }

    cases.push({
      title: "Required packages #1",
      func: function () {
        require("typescript");
        foo();
        if (true) {
          require("os");
        }
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = { a: 1, b: { c: 2, d: 3 } };

    cases.push({
      title: "Analyze property chain #1",
      func: function () {
        console.log(o.b.c);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = { a: 1, b: { c: 2, d: 3 } };

    cases.push({
      title: "Analyze property chain #2",
      func: function () {
        console.log(o.b);
        console.log(o.b.c);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = { a: 1, b: { c: 2, d: 3 } };

    cases.push({
      title: "Analyze property chain #3",
      func: function () {
        console.log(o.b);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = { a: 1, b: { c: 2, d: 3 } };

    cases.push({
      title: "Analyze property chain #4",
      func: function () {
        console.log(o.a);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = { a: 1, b: { c: { d: 1, e: 3 } } };

    cases.push({
      title: "Analyze property chain #5",
      func: function () {
        console.log(o.b.c.d);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = { a: 1, b: { c: { d: 1, e: 3 } } };

    cases.push({
      title: "Analyze property chain #6",
      func: function () {
        console.log(o.b.c.d);
        console.log(o.b);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = { a: 1, b: { c: { d: 1, e: 3 } } };

    cases.push({
      title: "Analyze property chain #7",
      func: function () {
        console.log(o.b.c.d);
        console.log(o.b.c);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = { a: 1, b: { c: { d: 1, e: 3 } } };

    cases.push({
      title: "Analyze property chain #8",
      func: function () {
        console.log(o.b.c.d);
        console.log(o.b.c);
        console.log(o.b);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = { a: 1, b: function () {} };

    cases.push({
      title: "Analyze property chain #9",
      func: function () {
        console.log(o.b.name);
      },
      snapshot: true,
    });
  }

  {
    const o = { a: 1, b: function () {} };

    cases.push({
      title: "Analyze property chain #10",
      func: function () {
        console.log(o.b.name);
        console.log(o.b());
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = { a: 1, b: function () {} };

    cases.push({
      title: "Analyze property chain #11",
      func: function () {
        console.log(o.b());
        console.log(o.b.name);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = {
      a: 1,
      b: function () {
        return this;
      },
    };

    cases.push({
      title: "Analyze property chain #12",
      func: function () {
        console.log(o.b.name);
        console.log(o.b());
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o = {
      a: 1,
      b: function () {
        return this;
      },
    };

    cases.push({
      title: "Analyze property chain #13",
      func: function () {
        console.log(o.b());
        console.log(o.b.name);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o1 = { c: 2, d: 3 };
    const o2 = { a: 1, b: o1 };

    cases.push({
      title: "Analyze property chain #14",
      func: function () {
        console.log(o2.b.d);
        console.log(o1);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o1 = { c: 2, d: 3 };
    const o2 = { a: 1, b: o1 };

    cases.push({
      title: "Analyze property chain #15",
      func: function () {
        console.log(o1);
        console.log(o2.b.d);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o1 = { c: 2, d: 3 };
    const o2 = { a: 1, b: o1 };
    const o3 = { a: 1, b: o1 };

    cases.push({
      title: "Analyze property chain #16",
      func: function () {
        console.log(o2.b.c);
        console.log(o3.b.d);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o1 = { c: 2, d: 3 };
    const o2 = { a: 1, b: o1 };
    const o3 = { a: 1, b: o1 };

    cases.push({
      title: "Analyze property chain #17",
      func: function () {
        console.log(o2.b.d);
        console.log(o3.b.d);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o1 = { c: 2, d: 3 };
    const o2 = { a: 1, b: o1 };
    const o3 = { a: 1, b: o1 };

    cases.push({
      title: "Analyze property chain #18",
      func: function () {
        console.log(o2.b);
        console.log(o2.b.d);
        console.log(o3.b.d);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o1 = { c: 2, d: 3 };
    const o2 = { a: 1, b: o1 };
    const o3 = { a: 1, b: o1 };

    cases.push({
      title: "Analyze property chain #19",
      func: function () {
        console.log(o2.b.d);
        console.log(o3.b.d);
        console.log(o2.b);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o1 = { c: 2, d: 3 };
    const o2 = { a: 1, b: o1 };
    const o3 = { a: 1, b: o1 };

    cases.push({
      title: "Analyze property chain #20",
      func: function () {
        console.log(o2.b.d);
        console.log(o3.b.d);
        console.log(o1);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const o1 = { c: 2, d: 3 };
    const o2 = { a: 1, b: o1 };
    const o3 = { a: 1, b: o1 };

    cases.push({
      title: "Analyze property chain #21",
      func: function () {
        console.log(o1);
        console.log(o2.b.d);
        console.log(o3.b.d);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const defaultsForThing = { config: { x: "x", y: "y" } };
    function getX() {
      return defaultsForThing.config.x;
    }
    function getAll() {
      const x = getX();
      return { x, y: defaultsForThing.config.y };
    }

    cases.push({
      title: "Analyze property chain #22",
      func: function () {
        console.log(getAll());
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const defaultsForThing = { config: { x: "x", y: "y" } };
    function getAll() {
      return { y: defaultsForThing.config.y };
    }

    cases.push({
      title: "Analyze property chain #23",
      func: function () {
        console.log(getAll());
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const config = { x: "x", y: "y" };
    function getX() {
      return config.x;
    }
    function getAll() {
      const x = getX();
      return { x, y: config.y };
    }

    cases.push({
      title: "Analyze property chain #24",
      func: function () {
        console.log(getAll());
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const defaultsForThing = { config: { x: "x", y: "y" } };
    function getX() {
      return defaultsForThing;
    }
    function getAll() {
      const x = getX();
      return { y: defaultsForThing.config.y };
    }

    cases.push({
      title: "Analyze property chain #25",
      func: function () {
        console.log(getAll());
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const defaultsForThing = { config: { x: "x", y: "y" } };
    function getX() {
      return defaultsForThing.config;
    }
    function getAll() {
      const x = getX();
      return { y: defaultsForThing.config.y };
    }

    cases.push({
      title: "Analyze property chain #26",
      func: function () {
        console.log(getAll());
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const defaultsForThing = { config: { x: "x", y: "y" } };
    function getX() {
      return defaultsForThing.config.x;
    }
    function getAll() {
      const x = getX();
      return { y: defaultsForThing };
    }

    cases.push({
      title: "Analyze property chain #27",
      func: function () {
        console.log(getAll());
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const defaultsForThing = { config: { x: "x", y: "y" } };
    function getX() {
      return defaultsForThing.config.x;
    }
    function getAll() {
      const x = getX();
      return { y: defaultsForThing.config };
    }

    cases.push({
      title: "Analyze property chain #28",
      func: function () {
        console.log(getAll());
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    cases.push({
      title: "Capture non-built-in module",
      func: function () {
        ts.parseCommandLine([""]);
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  //     {
  //         cases.push({
  //             title: "Fail to capture non-deployment module due to native code",
  //             func: function () { console.log(pulumi); },
  //             error: `Error serializing function 'func': tsClosureCases.js(0,0)

  // function 'func':(...)
  //   module './bin/index.js' which indirectly referenced
  //     function 'debug':(...)
  // (...)
  // Function code:
  //   function (...)() { [native code] }

  // Module './bin/index.js' is a 'deployment only' module. In general these cannot be captured inside a 'run time' function.`
  //         });
  //     }

  {
    // Used just to validate that if we capture a Config object we see these values serialized over.
    // Specifically, the module that Config uses needs to be captured by value and not be
    // 'require-reference'.
    deploymentOnlyModule.setConfig("test:TestingKey1", "TestingValue1");
    const testConfig = new deploymentOnlyModule.Config("test");

    cases.push({
      title: "Capture config created on the outside",
      func: function () {
        const v = testConfig.get("TestingKey1");
        console.log(v);
      },
      expectResult: undefined,
      snapshot: true,
    });
  }

  {
    deploymentOnlyModule.setConfig("test:TestingKey2", "TestingValue2");

    cases.push({
      title: "Capture config created on the inside",
      func: function () {
        const v = new deploymentOnlyModule.Config("test").get("TestingKey2");
        console.log(v);
      },
      // TODO: this is currently throwing an error
      // expectResult: undefined,
      snapshot: true,
    });
  }

  {
    cases.push({
      title: "Capture factory func #1",
      factoryFunc: () => {
        const serverlessExpress = require("aws-serverless-express");
        const express = require("express");
        const app = express();
        app.get("/", (req: any, res: any) => {
          res.json({ succeeded: true });
        });

        const server = serverlessExpress.createServer(app);

        return (event: any, context: any) => {
          serverlessExpress.proxy(server, event, context);
        };
      },
      snapshot: true,
    });
  }

  {
    const outerVal = [{}];
    (<any>outerVal[0]).inner = outerVal;

    function foo() {
      outerVal.pop();
    }

    function bar() {
      outerVal.join();
    }

    cases.push({
      title: "Capture factory func #2",
      factoryFunc: () => {
        outerVal.push({});
        foo();

        return (event: any, context: any) => {
          bar();
        };
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  cases.push({
    title: "Deconstructing function",
    // @ts-ignore
    func: function f({ whatever }) {
      return whatever;
    },
    snapshot: true,
    inputArguments: [{ whatever: "hello" }],
    expectResult: "hello",
  });

  cases.push({
    title: "Deconstructing async function",
    func: async function f({ whatever }) {
      return whatever;
    },
    inputArguments: [{ whatever: "hello" }],
    expectResult: "hello",
    snapshot: true,
  });

  cases.push({
    title: "Deconstructing arrow function",
    // @ts-ignore
    func: ({ whatever }) => whatever,
    snapshot: true,
    inputArguments: [{ whatever: "hello" }],
    expectResult: "hello",
  });

  class ClassWithStatic {
    static readonly S = "hello";
    static readonly T = "hello2";

    constructor() {}
  }

  cases.push({
    title: "Class statics",
    // @ts-ignore
    // func: () => { const s = ASL.S; const a = new ASL(); return s; },
    func: () => {
      return ClassWithStatic.S;
    },
    snapshot: true,
  });

  cases.push({
    title: "Class serialize all",
    // @ts-ignore
    // func: () => { const s = ASL.S; const a = new ASL(); return s; },
    func: () => {
      const doSomething = (c: any) => {};
      return doSomething(ClassWithStatic);
    },
    snapshot: true,
  });

  cases.push({
    title: "Class statics with prototype reference",
    // @ts-ignore
    // func: () => { const s = ASL.S; const a = new ASL(); return s; },
    func: () => {
      console.log(ClassWithStatic);
      return ClassWithStatic.S;
    },
    snapshot: true,
  });

  cases.push({
    title: "Class statics with class invoke",
    // @ts-ignore
    func: () => {
      const s = ClassWithStatic.S;
      const a = new ClassWithStatic();
      return s;
    },
    snapshot: true,
  });

  cases.push({
    title: "Class statics without static reference",
    // @ts-ignore
    func: () => {
      return new ClassWithStatic();
    },
    snapshot: true,
  });

  class ClassWithMoreStatic {
    static readonly S = () => "x";
    static readonly SX = () => new ClassWithMoreStatic();

    static x: number;

    static {
      ClassWithMoreStatic.x = 1 + 2;
    }

    constructor() {}
  }

  cases.push({
    title: "Class complex statics",
    // @ts-ignore
    func: () => {
      return new ClassWithMoreStatic();
    },
    snapshot: true,
  });

  cases.push({
    title: "Class complex statics only",
    // @ts-ignore
    func: () => {
      ClassWithMoreStatic.S();
      ClassWithMoreStatic.SX();
      console.log(ClassWithMoreStatic.x);
    },
    snapshot: true,
  });

  function F() {
    return "wee";
  }

  F.x = "hello";

  cases.push({
    title: "Function with props",
    // @ts-ignore
    func: () => {
      console.log(F.x);
    },
    snapshot: true,
  });

  cases.push({
    title: "Function invoked with props",
    // @ts-ignore
    func: () => {
      console.log(F());
    },
    snapshot: true,
  });

  const c = { x: ClassWithStatic };

  cases.push({
    title: "Class nested statics",
    // @ts-ignore
    // func: () => { const s = ASL.S; const a = new ASL(); return s; },
    func: () => {
      return c.x.S + c.x.T;
    },
    snapshot: true,
  });

  cases.push({
    title: "Deconstructing async arrow function",
    // @ts-ignore
    func: async ({ whatever }) => whatever,
    snapshot: true,
    inputArguments: [{ whatever: "hello" }],
    expectResult: "hello",
  });

  {
    const regex = /(abc)[\(123-456]\\a\b\z/gi;

    cases.push({
      title: "Regex #1",
      // @ts-ignore
      func: function () {
        console.log(regex);
      },
      expectResult: undefined,
      snapshot: true,
    });
  }

  {
    const regex = /(abc)/g;

    function foo() {
      console.log(regex);
    }

    cases.push({
      title: "Regex #2",
      // @ts-ignore
      func: function () {
        console.log(regex);
        foo();
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    const regex = /(abc)/;

    function foo() {
      console.log(regex);
    }

    cases.push({
      title: "Regex #3 (no flags)",
      // @ts-ignore
      func: function () {
        console.log(regex);
        foo();
      },
      snapshot: true,
      expectResult: undefined,
    });
  }

  {
    type LambdaInput = {
      message: string;
    };

    // @ts-ignore
    const getSchemaValidator = (): z.ZodSchema<LambdaInput> =>
      z.object({
        message: z.string(),
      });

    async function reproHandler(input: any) {
      const payload = getSchemaValidator().parse(input);
      return payload.message;
    }

    cases.push({
      title: "Respects package.json exports",
      func: reproHandler,
      inputArguments: [
        {
          message: "message in a bottle",
        },
      ],
      expectResult: "message in a bottle",
      snapshot: true,
    });
  }

  function wrap<F extends (...args: any[]) => any>(f: F): F {
    return f;
  }

  cases.push({
    title: "Remove specific syntax with a TypeScript transformer",
    func: function foo() {
      wrap((text: string) => `hello ${text}`);
      const a = wrap((text: string) => `hello ${text}`);
      const b = [wrap((text: string) => `hello ${text}`)];
      const c = {
        prop: wrap((text: string) => `hello ${text}`),
      };

      function bar(...args: any[]) {
        const a = wrap((text: string) => `hello ${text}`);
        const b = [wrap((text: string) => `hello ${text}`)];
        const c = {
          prop: wrap((text: string) => `hello ${text}`),
        };

        return [a("a"), b[0]("b"), c.prop("c"), ...args];
      }

      return bar(a("a"), b[0]("b"), c.prop("c"));
    },
    expectResult: [
      "hello a",
      "hello b",
      "hello c",
      "hello a",
      "hello b",
      "hello c",
    ],
    snapshot: true,
    transformers: [
      (ctx) =>
        function clean(node: ts.Node) {
          if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "wrap" &&
            node.arguments.length === 1
          ) {
            node = node.arguments[0];
          }
          return ts.visitEachChild(node, clean, ctx);
        },
    ],
  });

  // Run a bunch of direct checks on async js functions if we're in node 8 or above.
  // We can't do this inline as node6 doesn't understand 'async functions'.  And we
  // can't do this in TS as TS will convert the async-function to be a normal non-async
  // function.
  if (semver.gte(process.version, "8.0.0")) {
    const jsCases = require("./jsClosureCases_8");
    cases.push(...jsCases.cases);
  }

  if (semver.gte(process.version, "10.4.0")) {
    const jsCases = require("./jsClosureCases_10_4");
    cases.push(...jsCases.cases);
  }

  // Make a callback to keep running tests.
  let remaining = cases;
  while (true) {
    const test = remaining.shift();
    if (!test) {
      return;
    }

    // if (test.title.indexOf("Analyze property chain #2") < 0) {
    // //if (test.title !== "Analyze property chain #23") {
    //     continue;
    // }

    it(
      test.title,
      asyncTest(async () => {
        // Run pre-actions.
        if (test.pre) {
          test.pre();
        }

        try {
          // Invoke the test case.
          if (test.expectText !== undefined || test.snapshot) {
            const sf = await serializeFunctionTest(test);
            if (test.expectText !== undefined) {
              compareTextWithWildcards(test.expectText, sf.text);
            }
            if (test.snapshot) {
              expect(sf).toMatchSnapshot();
            }

            if ("expectResult" in test || "expectThrow" in test) {
              const fileName = path.join(
                __dirname,
                test.title.replace(/\//g, "_")
              );
              try {
                fs.writeFileSync(fileName, sf.text);
                const module = require(fileName);
                const closure = module[sf.exportName];
                let result = closure(...(test.inputArguments ?? []));
                if (typeof result?.then === "function") {
                  result = await result;
                }
                expect(result).toEqual(test.expectResult);
              } catch (err) {
                if ("expectThrow" in test) {
                  expect(err).toEqual(test.expectThrow);
                } else {
                  throw err;
                }
              } finally {
                if (!test.noClean) {
                  fs.rmSync(fileName);
                }
              }
            }
          } else {
            const message = await assertAsyncThrows(async () => {
              await serializeFunctionTest(test);
            });

            // replace real locations with (0,0) so that our test baselines do not need to
            // updated any time this file changes.
            const regex = /\([0-9]+,[0-9]+\)/g;
            const withoutLocations = message.replace(regex, "(0,0)");
            if (test.error) {
              compareTextWithWildcards(test.error, withoutLocations);
            }
          }
        } finally {
          if (test.skip) {
            // swallow failures
            return;
          }
        }
      })
    );

    // Schedule any additional tests.
    if (test.afters) {
      remaining = test.afters.concat(remaining);
    }
  }
  async function serializeFunctionTest(test: ClosureCase) {
    if (test.func) {
      return await serializeFunction(test.func, {
        transformers: test.transformers,
      });
    } else if (test.factoryFunc) {
      return await serializeFunction(test.factoryFunc!, {
        isFactoryFunction: true,
        transformers: test.transformers,
      });
    } else {
      throw new Error("Have to supply [func] or [factoryFunc]!");
    }
  }
});

/**
 * compareErrorText compares an "expected" error string and an "actual" error string
 * and issues an error if they do not match.
 *
 * This function accepts two repetition operators to make writing tests easier against
 * error messages that are dependent on the environment:
 *
 *  * (...) alone on a single line causes the matcher to accept zero or more lines
 *    between the repetition and the next line.
 *  * (...) within in the context of a line causes the matcher to accept zero or more characters
 *    between the repetition and the next character.
 *
 * This is useful when testing error messages that you get when capturing bulit-in modules,
 * because the specific error message differs between Node versions.
 * @param expected The expected error message string, potentially containing repetitions
 * @param actual The actual error message string
 */
function compareTextWithWildcards(expected: string, actual: string) {
  const wildcard = "(...)";

  expected = expected.replace(platformIndependentEOL, "\n");
  actual = actual.replace(platformIndependentEOL, "\n");

  if (!expected.includes(wildcard)) {
    // We get a nice diff view if we diff the entire string, so do that
    // if we didn't get a wildcard.
    expect(actual).toEqual(expected);
    return;
  }

  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  let actualIndex = 0;
  for (
    let expectedIndex = 0;
    expectedIndex < expectedLines.length;
    expectedIndex++
  ) {
    const expectedLine = expectedLines[expectedIndex].trim();
    if (expectedLine === wildcard) {
      if (expectedIndex + 1 === expectedLines.length) {
        return;
      }

      const nextLine = expectedLines[++expectedIndex].trim();
      while (true) {
        const actualLine = actualLines[actualIndex++].trim();
        if (actualLine === nextLine) {
          break;
        }

        if (actualIndex === actualLines.length) {
          fail(
            `repetition failed to find match: expected terminator ${nextLine}, received ${actual}`
          );
        }
      }
    } else if (expectedLine.includes(wildcard)) {
      const line = actualLines[actualIndex++].trim();
      const index = expectedLine.indexOf(wildcard);
      const indexAfter = index + wildcard.length;
      expect(line.substring(0, index)).toEqual(
        expectedLine.substring(0, index)
      );

      if (indexAfter === expectedLine.length) {
        continue;
      }
      let repetitionIndex = index;
      for (; repetitionIndex < line.length; repetitionIndex++) {
        if (line[repetitionIndex] === expectedLine[indexAfter]) {
          break;
        }
      }

      expect(line.substring(repetitionIndex)).toEqual(
        expectedLine.substring(indexAfter)
      );
    } else {
      expect(actualLines[actualIndex++].trim()).toEqual(expectedLine);
    }
  }
}
