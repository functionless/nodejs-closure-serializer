import { parseSync } from "@swc/core";
import { globalSingleton } from "./global-singleton";

export type UnparsedClosure = [
  filename: string,
  captured: () => CapturedVariables
];

type CapturedVariables = any[];

export interface Closure {
  filename: string;
  captured: FreeVariables;
}

export type FreeVariables = Record<string, any>;

// cache parsed closures
const parsedClosureCache = globalSingleton(
  Symbol.for("@functionless/parsed-closure-cache"),
  () => new WeakMap<Function, Closure>()
);

export function getClosure(func: Function): Closure | undefined {
  const closure: UnparsedClosure | undefined = (func as any)["[[Closure]]"];
  if (closure === undefined) {
    return undefined;
  }

  if (!parsedClosureCache.has(func)) {
    const [filename, captured] = closure;
    // because of SWC's hygiene step where variables are renamed
    // we cannot inject the name of a variable as a string literal
    // as a workaround, we parse the closure that returns the free variables
    // which is in the form: () => [a, b, c]

    const ast = parseSync(captured.toString(), {
      syntax: "ecmascript",
      script: false,
    });

    if (ast.body.length !== 1) {
      throw new Error(`expected a single statement`);
    }
    const stmt = ast.body[0]!;
    if (stmt.type !== "ExpressionStatement") {
      throw new Error(`expected an ExpressionStatement, but got ${stmt.type}`);
    } else if (stmt.expression.type !== "ArrowFunctionExpression") {
      throw new Error(
        `expected ExpressionStatement's expression to be an ArrowFunctionExpression, but got ${stmt.expression.type}`
      );
    } else if (stmt.expression.body.type !== "ArrayExpression") {
      throw new Error(
        `expected ArrowFunctionExpressions's body to be an ArrayExpression, but got ${stmt.expression.body.type}`
      );
    }

    const variableValues = captured();

    if (stmt.expression.body.elements.length !== variableValues.length) {
      throw new Error(
        `expected ArrayExpression to have ${variableValues.length} elements, but has ${stmt.expression.body.elements.length}`
      );
    }

    parsedClosureCache.set(func, {
      filename: filename,
      captured: Object.fromEntries(
        stmt.expression.body.elements.map((variable, i) => {
          if (variable?.expression.type !== "Identifier") {
            throw new Error(
              `expected item ${i} in ArrayExpression to be an Identifier, but got ${variable?.expression.type}`
            );
          }

          return [variable.expression.value, variableValues[i]];
        })
      ),
    });
  }

  return parsedClosureCache.get(func);
}
