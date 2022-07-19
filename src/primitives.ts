import vm from "vm";

type OwnFunctions<T extends object> = {
  [k in FunctionProperties<T>]: T[k];
};

type FunctionProperties<T extends object> = {
  [k in keyof T]: T extends Function ? k : never;
}[keyof T];

/**
 * A list of objects containing stringified form of all of the Global object's Own Function Properties.
 *
 * We will use these string forms to detect augmentations (such as poly-filling) to the primitive types.
 */
export const unModifiedGlobalOwnFunctions: [
  OwnFunctions<typeof Object>,
  OwnFunctions<typeof Object["prototype"]>,
  OwnFunctions<typeof Function>,
  OwnFunctions<typeof Function["prototype"]>
] = (() => {
  return vm.runInNewContext(
    (() => {
      // run a function in an isolated VM that walks through each of the functions on global objects
      // and returns a stringified version of that function
      // we will use this stringified form to detect when a global object has been augmented by another module
      // only augmented functions will be serialized
      return [
        getOwnPropertyFunctionStringForms(Object),
        getOwnPropertyFunctionStringForms(Object.prototype),
        getOwnPropertyFunctionStringForms(Function),
        getOwnPropertyFunctionStringForms(Function.prototype),
        getOwnPropertyFunctionStringForms(Array),
        getOwnPropertyFunctionStringForms(Array.prototype),
      ];

      /**
       * Walk through each of the Own Properties that are Functions and stringify them
       *
       * @param object containing properties that are Functions
       * @returns map of functionName to stringified Function
       */
      function getOwnPropertyFunctionStringForms<T extends object>(
        object: T
      ): Record<Extract<keyof T, string>, string> {
        const functions: any = {};
        for (const ownPropertyName in Object.getOwnPropertyNames(object)) {
          const ownProperty = object[ownPropertyName as keyof typeof object];
          if (typeof ownProperty === "function") {
            functions[ownPropertyName] = ownProperty.toString();
          }
        }
        return functions;
      }
    }).toString()
  );
})();
