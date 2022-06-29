import { SerializedFunction, SerializeFunctionArgs } from "./serializeClosure";

export async function serializeFunction(
  func: Function,
  args: Partial<SerializeFunctionArgs> = {}
): Promise<SerializedFunction> {
  const exportName = args.exportName || "handler";
  const isFactoryFunction =
    args.isFactoryFunction === undefined ? false : args.isFactoryFunction;

  throw new Error(``);
}
