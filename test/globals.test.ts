import * as globals from "../src/globals";

test("should parse free variable names", () => {
  let a = "a1";
  let b = "b1";

  function foo() {
    return [a, b];
  }

  globals.registerClosure(foo, __filename, () => [a, b]);

  const closure = globals.getClosure(foo);

  expect(closure).toEqual({
    filename: __filename,
    captured: {
      a,
      b,
    },
  });
});

test("should parse empty array of free variable names", () => {
  function foo() {
    return;
  }

  globals.registerClosure(foo, __filename, () => []);

  const closure = globals.getClosure(foo);

  expect(closure).toEqual({
    filename: __filename,
    captured: {},
  });
});
