import { getClosure } from "../src/free-variables";

test("should parse free variable names", () => {
  let a = "a1";
  let b = "b1";

  function foo() {
    return [a, b];
  }

  (foo as any)["[[Closure]]"] = [__filename, () => [a, b]];

  const closure = getClosure(foo);

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

  (foo as any)["[[Closure]]"] = [__filename, () => []];

  const closure = getClosure(foo);

  expect(closure).toEqual({
    filename: __filename,
    captured: {},
  });
});
