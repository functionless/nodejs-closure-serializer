/* eslint-disable no-bitwise */
import inspector from "inspector";
import util from "util";
import { Set as iSet } from "immutable";
import ts from "typescript";
import { collectEachChild } from "./collect-each-child";
import { getFunctionId } from "./function";
import {
  CallFunctionSession,
  inflightContext,
  inspectorSession,
} from "./inspector-session";
import { getInternalProperties } from "./internal-properties";
import { assertNever } from "./util";

export interface FreeVariable<T = any> {
  /**
   * Name of the free variable passed in to the closure initialization.
   *
   * ```ts
   * function f1 = (function(name) {
   * //                      ^ lexicalName
   * })
   * ```
   */
  variableName: string;
  /**
   * A {@link ts.Expression} for the value passed into the closure initialization.
   *
   * ```ts
   * const f1 = (function() { .. })(value)
   * //                             ^ outerNode
   * ```
   */
  variableValue: T;
}

/**
 * Walks the tree in evaluation order, collects all variable names from
 * Function/Class Declarations, and VariableStatements.
 *
 * All {@link ts.Identifier} expressions point to values not in {@link lexicalScope}
 * are resolved with {@link getFreeVariableValue}..
 *
 * @param node TypeScript AST tree node to walk
 * @param lexicalScope accumulated names at this point in the evaluate
 * @returns an array of a Promise resolving each {@link FreeVariable}s referenced by {@link node}
 */
export function getFreeVariables(
  func: Function,
  /**
   * The current node being visited.
   */
  node: ts.Node,
  /**
   * A Set of all names known at this point in the AST.
   */
  lexicalScope: iSet<string> = iSet()
): Promise<Array<FreeVariable>> {
  return Promise.all(_discoverFreeVariables(node, lexicalScope));

  function _discoverFreeVariables(
    node: ts.Node,
    lexicalScope: iSet<string> = iSet()
  ): Promise<FreeVariable>[] {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isConstructorDeclaration(node)
    ) {
      return collectEachChild(
        node,
        lexicalScope.concat(
          iSet([
            ...(node.name && ts.isIdentifier(node.name)
              ? [node.name.text]
              : []),
            ...node.parameters.flatMap(getBindingNames),
          ])
        ),
        _discoverFreeVariables
      );
    } else if (ts.isBlock(node)) {
      // first extract all hoisted functions
      lexicalScope = lexicalScope.concat(getBindingNames(node));
      return node.statements.flatMap((stmt) => {
        const freeVariables = _discoverFreeVariables(stmt, lexicalScope);
        if (ts.isVariableStatement(stmt) || ts.isClassDeclaration(stmt)) {
          // update the current lexical scope with the variable declarations
          lexicalScope = lexicalScope.concat(getBindingNames(stmt));
        }
        return freeVariables;
      });
    } else if (ts.isVariableDeclaration(node)) {
      return collectEachChild(
        node,
        lexicalScope.concat(getBindingNames(node.name)),
        _discoverFreeVariables
      );
    } else if (ts.isVariableDeclarationList(node)) {
      return node.declarations.flatMap((variableDecl) =>
        _discoverFreeVariables(
          variableDecl,
          lexicalScope.concat(getBindingNames(variableDecl.name))
        )
      );
    } else if (isFreeVariable(node, lexicalScope)) {
      return [
        getFreeVariableValue(func, node.text, false).then((val) => ({
          variableName: node.text,
          variableValue: val,
        })),
        ...collectEachChild(node, lexicalScope, _discoverFreeVariables),
      ];
    } else {
      return collectEachChild(node, lexicalScope, _discoverFreeVariables);
    }
  }
}

/**
 * Get all of the names declared by a binding.
 *
 * @param binding AST node representing the binding
 * @returns all of the names produced by the {@link binding}
 */
function getBindingNames(
  binding:
    | ts.ArrayBindingElement
    | ts.BindingElement
    | ts.BindingName
    | ts.BindingPattern
    | ts.ClassDeclaration
    | ts.ClassExpression
    | ts.ObjectBindingPattern
    | ts.ParameterDeclaration
    | ts.VariableDeclaration
    | ts.VariableDeclarationList
    | ts.VariableStatement
    | ts.Block
    | ts.FunctionDeclaration
): string[] {
  if (ts.isBlock(binding)) {
    // hoist all relevant `function` and `var` declarations
    return binding.statements.flatMap((stmt) => {
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        return [stmt.name.text];
      } else if (
        ts.isVariableStatement(stmt) &&
        (stmt.declarationList.flags &
          // if the variable is neither a `const` or `let`, then hoist the bindings
          (ts.NodeFlags.Const | ts.NodeFlags.Let)) ===
          0
      ) {
        return stmt.declarationList.declarations
          .filter(
            // `var` is only hoisted if there is no initializer
            // see: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/var
            (declaration) => declaration.initializer === undefined
          )
          .flatMap(getBindingNames);
      }

      return [];
    });
  } else if (
    ts.isFunctionDeclaration(binding) ||
    ts.isClassDeclaration(binding) ||
    ts.isClassExpression(binding)
  ) {
    return binding.name ? [binding.name.text] : [];
  } else if (ts.isParameter(binding)) {
    return getBindingNames(binding.name);
  } else if (ts.isIdentifier(binding)) {
    return [binding.text];
  } else if (
    ts.isArrayBindingPattern(binding) ||
    ts.isObjectBindingPattern(binding)
  ) {
    return binding.elements.flatMap(getBindingNames);
  } else if (ts.isOmittedExpression(binding)) {
    return [];
  } else if (ts.isBindingElement(binding)) {
    return getBindingNames(binding.name);
  } else if (ts.isVariableStatement(binding)) {
    return getBindingNames(binding.declarationList);
  } else if (ts.isVariableDeclarationList(binding)) {
    return binding.declarations.flatMap(getBindingNames);
  } else if (ts.isVariableDeclaration(binding)) {
    return getBindingNames(binding.name);
  }
  return assertNever(binding);
}

/**
 * Determines if a ts.Identifier in a Class or Function points to a free variable.
 *
 * i.e. a reference to a value declared outside of the scope of a function.
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

/**
 * Get the value of a {@link freeVariable} captured by the {@link closure}.
 *
 * @param closure the closure whose lexical scope to probe for the free variable
 * @param freeVariable name of the free variable to resolve
 * @param throwOnFailure whether to throw when the variable cannot be resolved
 * @returns the value of the free variable if it can be resolved
 * @throws an error if {@link throwOnFailure} is true and the free variable is not visible in scope
 */
export async function getFreeVariableValue(
  closure: Function,
  freeVariable: string,
  throwOnFailure: boolean
): Promise<any> {
  // First, find the runtime's internal id for this function.
  const functionId = await getFunctionId(closure);

  // Now, query for the internal properties the runtime sets up for it.
  const internalProperties = await getInternalProperties(
    functionId,
    /*ownProperties:*/ false
  );

  // There should normally be an internal property called [[Scopes]]:
  // https://chromium.googlesource.com/v8/v8.git/+/3f99afc93c9ba1ba5df19f123b93cc3079893c9b/src/inspector/v8-debugger.cc#820

  // This is sneaky, but we can actually map back from the [[Scopes]] object to a real in-memory
  // v8 array-like value.  Note: this isn't actually a real array.  For example, it cannot be
  // iterated.  Nor can any actual methods be called on it. However, we can directly index into
  // it.
  // Similarly, the 'object' type it optionally points at is not a true JS
  // object.  So we can't call things like .hasOwnProperty on it.  However, the values pointed to
  // by 'object' are the real in-memory JS objects we are looking for.  So we can find and return
  // those successfully to our caller.
  const scopes: { object?: Record<string, any> }[] | undefined =
    internalProperties["[[Scopes]]"];

  if (scopes === undefined) {
    throw new Error(`[[Scopes]] internal property is not defined`);
  }

  // scopes are ordered from innermost to outermost.
  for (let i = 0, n = scopes.length; i < n; i++) {
    const scope = scopes[i];
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
