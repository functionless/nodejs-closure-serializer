import { parseSync } from "@swc/core";

/**
 * This file adds the `__fnl_func` function to the global object.
 *
 * It must be run prior to the `@swc/register` hook runs as part of the `node -r <require>` step or else
 * transformed code will break.
 */

export interface UnparsedClosure {
  filename: string;
  captured: () => CapturedVariables;
}

type CapturedVariables = any[];

export interface Closure {
  filename: string;
  captured: Record<string, any>;
}

export type BoundFunction = [
  targetFunc: Function,
  boundThis: any,
  boundArgs: any[]
];

declare global {
  function __fnl_func(
    func: Function,
    filename: string,
    captured: () => CapturedVariables
  ): void;
}
global.__fnl_func = registerClosure;

export function registerClosure(
  func: Function,
  filename: string,
  captured: () => CapturedVariables
) {
  if (closures.has(func)) {
    throw new Error(`illegal override of function captured closure`);
  }
  closures.set(func, {
    filename,
    captured: captured,
  });
  return func;
}

const closures = globalSingleton(
  Symbol.for("@functionless/captured-closures"),
  () => new WeakMap<Function, UnparsedClosure>()
);

const bind = Function.prototype.bind;

Function.prototype.bind = function (boundThis: any, ...boundArgs: any[]) {
  const bound = bind.call(this, boundThis, ...boundArgs);
  boundFunctions.set(bound, [this, boundThis, boundArgs]);
  return bound;
};

const boundFunctions = globalSingleton(
  Symbol.for("@functionless/bound-functions"),
  () => new WeakMap<Function, BoundFunction>()
);

// cache parsed closures
const parsedClosureCache = globalSingleton(
  Symbol.for("@functionless/parsed-closure-cache"),
  () => new WeakMap<Function, Closure>()
);

export function getClosure(func: Function): Closure | undefined {
  const closure = closures.get(func);
  if (closure === undefined) {
    return undefined;
  }

  if (!parsedClosureCache.has(func)) {
    // because of SWC's hygiene step where variables are renamed
    // we cannot inject the name of a variable as a string literal
    // as a workaround, we parse the closure that returns the free variables
    // which is in the form: () => [a, b, c]

    const ast = parseSync(closure.captured.toString(), {
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

    const variableValues = closure.captured();

    if (stmt.expression.body.elements.length !== variableValues.length) {
      throw new Error(
        `expected ArrayExpression to have ${variableValues.length} elements, but has ${stmt.expression.body.elements.length}`
      );
    }

    parsedClosureCache.set(func, {
      filename: closure.filename,
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

export function getBoundFunction(func: Function): BoundFunction | undefined {
  return boundFunctions.get(func);
}

function globalSingleton<T>(key: symbol, create: () => T): T {
  return ((global as any)[key] = (global as any)[key] ?? create());
}
