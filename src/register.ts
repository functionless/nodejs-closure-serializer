export type CapturedClosure = () => Closure;

export interface Closure {
  __filename: string;
  free: FreeVariable[];
}

export type FreeVariable = [name: string, id: number, value: any];

export type BoundFunction = [
  targetFunc: Function,
  boundThis: any,
  boundArgs: any[]
];

declare global {
  function __fnl_func(func: Function, capturedClosure: CapturedClosure): void;
}

global.__fnl_func = (func, capture) => {
  if (closures.has(func)) {
    throw new Error(`illegal override of function captured closure`);
  }
  closures.set(func, capture);
};

const closures = globalSingleton(
  Symbol.for("@functionless/captured-closures"),
  () => new WeakMap<Function, CapturedClosure>()
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

export function getCapturedClosure(
  func: Function
): CapturedClosure | undefined {
  return closures.get(func);
}

export function getClosure(func: Function): Closure | undefined {
  return getCapturedClosure(func)?.();
}

export function getBoundFunction(func: Function): BoundFunction | undefined {
  return boundFunctions.get(func);
}

function globalSingleton<T>(key: symbol, create: () => T): T {
  return ((global as any)[key] = (global as any)[key] ?? create());
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
require("@swc/register");
