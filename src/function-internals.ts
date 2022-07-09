import inspector from "inspector";
import { getFunctionId, getValueForObjectId } from "./free-variable";
import { getInternalProperties } from "./internal-properties";

export interface FunctionInternals {
  boundThis?: any;
  boundArgs?: any;
  targetFunction?: any;
  prototype?: any;
}

/**
 * Extracts the `[[BoundThis]]`, `[[BoundArgs]], `[[TargetFunction]] and `[[Prototype]]` internal
 * properties from a bound function, i.e. a function created with `.bind`:
 *
 * ```ts
 * const a = new A();
 * const f = a.f.bind(a);
 *
 * const [boundThis, target, prototype] = await unBindFunction(f);
 * ```
 */
export async function getFunctionInternals(
  func: Function
): Promise<FunctionInternals | undefined> {
  if (!func.name.startsWith("bound ")) {
    return undefined;
  }
  const functionId = await getFunctionId(func);
  const internalProperties = await getInternalProperties(functionId, true);

  const [boundThis, boundArgs, targetFunction] = await Promise.all([
    getInternalProperty(internalProperties, "[[BoundThis]]"),
    getInternalProperty(internalProperties, "[[BoundArgs]]"),
    getInternalProperty(internalProperties, "[[TargetFunction]]"),
  ]);

  return {
    boundThis,
    boundArgs,
    targetFunction,
    prototype: Object.getPrototypeOf(func),
  };

  function getInternalProperty(
    internalProperties: inspector.Runtime.InternalPropertyDescriptor[],
    name: string
  ): unknown | undefined {
    const prop = internalProperties.find((prop) => prop.name === name);
    if (prop?.value?.objectId) {
      return getValueForObjectId(prop.value.objectId);
    }
    return undefined;
  }
}
