import inspector from "inspector";
import util from "util";
import { Set as iSet } from "immutable";
import ts from "typescript";
import {
  CallFunctionSession,
  EvaluationSession,
  inflightContext,
  inspectorSession,
} from "./inspector-session";
import { getInternalProperties } from "./internal-properties";

/**
 * Determines if a ts.Identifier in a Class or Function points to a free variable (i.e. a value outside of its scope).
 */
export function isFreeVariable(
  node: ts.Node,
  lexicalScope: iSet<string>
): node is ts.Identifier {
  if (!ts.isIdentifier(node)) {
    return false;
  }
  const parent = node.parent;

  if (ts.isBindingElement(parent)) {
    return false;
  } else if (
    /**
     * the ID is the name of the Function, Class, Method or Parameter
     *
     * ```ts
     * function foo() {
     *        // ^ this is not a free variable
     * }
     *
     * function foo(arg) {
     *            // ^ this is not a free variable
     * }
     *
     * class A {
     *    // ^ this is not a free variable
     *
     *    foo() {}
     *  // ^ this is not a free variable
     * }
     * ```
     */
    (ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isParameter(parent)) &&
    parent.name === node
  ) {
    return false;
  } else if (
    /**
     * The ID is the `name` property in a PropertyAccessExpression.
     * ```ts
     * const a = b.c;
     *          // ^ not a free variable
     * ```
     */
    (ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAccessChain(parent)) &&
    parent.name === node
  ) {
    return false;
  } else if (
    /**
     * The ID is contained within a VariableDeclaration's BindingName - as an Identifier, ObjectBindingPattern or ArrayBindingPattern.
     * ```ts
     * function foo() {
     *   const a = ?;
     *      // ^ not a free variable
     *   const { a } = ?;
     *        // ^ not a free variable
     *   const [ a ] = ?;
     *        // ^ not a free variable
     * }
     * ```
     */
    ts.isVariableDeclaration(parent) &&
    bindingHasId(node, parent.name)
  ) {
    return false;
  }
  /**
   * Finally, this is a ts.Identifier that is referencing a value. Let's now check and see if the value it
   * references is inside or outside of the function scope.
   *
   * ```ts
   * const a = ?;
   * function foo() {
   *   return a;
   *       // ^ free variable
   * }
   *
   * function bar() {
   *   const a = ?;
   *
   *   return a;
   *       // ^ not a free variable
   * }
   * ```
   */
  return !lexicalScope.has(node.text);
}

/**
 * Determines if the Binding, {@link binding}, contains the Identifier, {@link id}.
 *
 * Comparison is done by object identity, not identifier text.
 */
function bindingHasId(
  id: ts.Identifier,
  binding: ts.BindingName | ts.BindingElement | ts.OmittedExpression
): boolean {
  if (ts.isOmittedExpression(binding)) {
    return false;
  } else if (ts.isBindingElement(binding)) {
    return bindingHasId(id, binding.name);
  } else if (ts.isIdentifier(binding)) {
    return binding === id;
  } else if (
    ts.isObjectBindingPattern(binding) ||
    ts.isArrayBindingPattern(binding)
  ) {
    return (
      binding.elements.find((element) => bindingHasId(id, element)) !==
      undefined
    );
  }
  return false;
}

export async function getFreeVariable(
  func: Function,
  freeVariable: string,
  throwOnFailure: boolean
): Promise<any> {
  // First, find the runtime's internal id for this function.
  const functionId = await getFunctionId(func);

  // Now, query for the internal properties the runtime sets up for it.
  const internalProperties = await getInternalProperties(
    functionId,
    /*ownProperties:*/ false
  );

  // There should normally be an internal property called [[Scopes]]:
  // https://chromium.googlesource.com/v8/v8.git/+/3f99afc93c9ba1ba5df19f123b93cc3079893c9b/src/inspector/v8-debugger.cc#820
  const scopes = internalProperties.find((p) => p.name === "[[Scopes]]");
  if (!scopes) {
    throw new Error("Could not find [[Scopes]] property");
  }

  if (!scopes.value) {
    throw new Error("[[Scopes]] property did not have [value]");
  }

  if (!scopes.value.objectId) {
    throw new Error("[[Scopes]].value have objectId");
  }

  // This is sneaky, but we can actually map back from the [[Scopes]] object to a real in-memory
  // v8 array-like value.  Note: this isn't actually a real array.  For example, it cannot be
  // iterated.  Nor can any actual methods be called on it. However, we can directly index into
  // it, and we can.  Similarly, the 'object' type it optionally points at is not a true JS
  // object.  So we can't call things like .hasOwnProperty on it.  However, the values pointed to
  // by 'object' are the real in-memory JS objects we are looking for.  So we can find and return
  // those successfully to our caller.
  const scopesArray: { object?: Record<string, any> }[] =
    await getValueForObjectId(scopes.value.objectId);

  // scopesArray is ordered from innermost to outermost.
  for (let i = 0, n = scopesArray.length; i < n; i++) {
    const scope = scopesArray[i];
    if (scope.object) {
      if (freeVariable in scope.object) {
        const val = scope.object[freeVariable];
        return val;
      }
    }
  }

  if (throwOnFailure) {
    throw new Error(
      "Unexpected missing variable in closure environment: " + freeVariable
    );
  }

  return undefined;
}

export async function getFunctionId(
  func: Function
): Promise<inspector.Runtime.RemoteObjectId> {
  // In order to get information about an object, we need to put it in a well known location so
  // that we can call Runtime.evaluate and find it.  To do this, we use a special map on the
  // 'global' object of a vm context only used for this purpose, and map from a unique-id to that
  // object.  We then call Runtime.evaluate with an expression that then points to that unique-id
  // in that global object.  The runtime will then find the object and give us back an internal id
  // for it.  We can then query for information about the object through that internal id.
  //
  // Note: the reason for the mapping object and the unique-id we create is so that we don't run
  // into any issues when being called asynchronously.  We don't want to place the object in a
  // location that might be overwritten by another call while we're asynchronously waiting for our
  // original call to complete.

  const session = <EvaluationSession>await inspectorSession;
  const post = util.promisify(session.post);

  // Place the function in a unique location
  const context = await inflightContext;
  const currentFunctionName = "id" + context.currentFunctionId++;
  context.functions[currentFunctionName] = func;
  const contextId = context.contextId;
  const expression = `functions.${currentFunctionName}`;

  try {
    const retType = await post.call(session, "Runtime.evaluate", {
      contextId,
      expression,
    });

    if (retType.exceptionDetails) {
      throw new Error(
        `Error calling "Runtime.evaluate(${expression})" on context ${contextId}: ` +
          retType.exceptionDetails.text
      );
    }

    const remoteObject = retType.result;
    if (remoteObject.type !== "function") {
      throw new Error(
        "Remote object was not 'function': " + JSON.stringify(remoteObject)
      );
    }

    if (!remoteObject.objectId) {
      throw new Error(
        "Remote function does not have 'objectId': " +
          JSON.stringify(remoteObject)
      );
    }

    return remoteObject.objectId;
  } finally {
    delete context.functions[currentFunctionName];
  }
}

export async function getValueForObjectId(
  objectId: inspector.Runtime.RemoteObjectId
): Promise<any> {
  // In order to get the raw JS value for the *remote wrapper* of the [[Scopes]] array, we use
  // Runtime.callFunctionOn on it passing in a fresh function-declaration.  The Node runtime will
  // then compile that function, invoking it with the 'real' underlying scopes-array value in
  // memory as the bound 'this' value.  Inside that function declaration, we can then access
  // 'this' and assign it to a unique-id in a well known mapping table we have set up.  As above,
  // the unique-id is to prevent any issues with multiple in-flight asynchronous calls.

  const session = <CallFunctionSession>await inspectorSession;
  const post = util.promisify(session.post);
  const context = await inflightContext;

  // Get an id for an unused location in the global table.
  const tableId = "id" + context.currentCallId++;

  // Now, ask the runtime to call a fictitious method on the scopes-array object.  When it
  // does, it will get the actual underlying value for the scopes array and bind it to the
  // 'this' value inside the function.  Inside the function we then just grab 'this' and
  // stash it in our global table.  After this completes, we'll then have access to it.

  // This cast will become unnecessary when we move to TS 3.1.6 or above.  In that version they
  // support typesafe '.call' calls.
  const retType = <inspector.Runtime.CallFunctionOnReturnType>await post.call(
    session,
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: `function () { calls["${tableId}"] = this; }`,
    }
  );
  if (retType.exceptionDetails) {
    throw new Error(
      `Error calling "Runtime.callFunction(${objectId})": ` +
        retType.exceptionDetails.text
    );
  }

  if (!context.calls.hasOwnProperty(tableId)) {
    throw new Error(
      `Value was not stored into table after calling "Runtime.callFunctionOn(${objectId})"`
    );
  }

  // Extract value and clear our table entry.
  const val = context.calls[tableId];
  delete context.calls[tableId];

  return val;
}
