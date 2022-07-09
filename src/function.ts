import inspector from "inspector";
import util from "util";
import ts from "typescript";

import { collectEachChild } from "./collect-each-child";
import {
  EvaluationSession,
  inflightContext,
  inspectorSession,
} from "./inspector-session";
import { getInternalProperties } from "./internal-properties";

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
export async function getFunctionInternals(func: Function) {
  if (!func.name.startsWith("bound ")) {
    return undefined;
  }
  return getInternalProperties(await getFunctionId(func), true);
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

/**
 * Find all of the {@link ts.Identifier}s used within the Function.
 */
export function getFunctionIdentifiers(
  funcAST:
    | ts.ClassDeclaration
    | ts.ClassExpression
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction
): string[] {
  return collectEachChild(funcAST, function walk(node): string[] {
    if (ts.isIdentifier(node)) {
      return [node.text];
    }
    return collectEachChild(node, walk);
  });
}
