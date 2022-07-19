import { globalSingleton } from "./global-singleton";

export interface BoundFunction {
  "[[TargetFunction]]": Function;
  "[[BoundThis]]": any;
  "[[BoundArgs]]": any[];
}

const boundFunctions = globalSingleton(
  Symbol.for("@functionless/bound-functions"),
  () => new WeakMap<Function, BoundFunction>()
);

export function getBoundFunction(func: Function): BoundFunction | undefined {
  return boundFunctions.get(func);
}

const bind = Function.prototype.bind;

Function.prototype.bind = function (boundThis: any, ...boundArgs: any[]) {
  const bound = bind.call(this, boundThis, ...boundArgs);
  boundFunctions.set(bound, {
    "[[TargetFunction]]": this,
    "[[BoundThis]]": boundThis,
    "[[BoundArgs]]": boundArgs,
  });
  return bound;
};
