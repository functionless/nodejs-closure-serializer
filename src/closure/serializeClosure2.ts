import inspector from "inspector";
import util from "util";
import v8 from "v8";
import vm from "vm";
import ts from "typescript";
v8.setFlagsFromString("--allow-natives-syntax");

export interface SerializeFunctionArgs {
  /**
   * AST Transformers that will run prior to serialization.
   */
  preProcess?: ts.TransformerFactory<ts.Node>[];
  /**
   * AST Transformers that will run after serialization.
   */
  postProcess?: ts.TransformerFactory<ts.Node>[];
  /**
   * A hook called on every value before serialization. It allows
   * serialization to swap out values with optimized values for
   * serialization, e.g. by omitting properties that should not be
   * serialized.
   */
  preSerializeValue?: (value: any) => any;
}

interface CapturedValue {
  /**
   * Name of the captured value passed in to the closure initialization.
   *
   * ```ts
   * function f1 = (function(name) {
   * //                      ^ lexicalName
   * })
   * ```
   */
  lexicalName: string;
  /**
   * A {@link ts.Expression} for the value passed into the closure initialization.
   *
   * ```ts
   * const f1 = (function() { .. })(value)
   * //                             ^ outerNode
   * ```
   */
  outerNode: ts.Expression;
}

export async function serializeFunction(
  func: Function,
  args: SerializeFunctionArgs = {}
): Promise<string> {
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

  function emit(stmts: ts.Statement[], file: ts.SourceFile) {
    statements.push(
      ...stmts.map((stmt) =>
        printer.printNode(ts.EmitHint.Unspecified, stmt, file).trim()
      )
    );
  }

  function nameGenerator(prefix: string) {
    let i = 0;

    const nextName = () => `${prefix}${(i += 1)}`;

    return (exclude?: Set<string>) => {
      let name = nextName();
      if (exclude) {
        while (exclude.has(name)) {
          name = nextName();
        }
      }
      return name;
    };
  }

  const nextVarName = nameGenerator("v");

  const statements: string[] = [];
  // caches a map of distinct value to a ts.Expression that references the serialized value
  const valueCache = new Map<any, ts.Expression>();

  const handler = await serializeClosure(func);

  return `${statements.join("\n")}\nexports.handler = ${handler.text}`;

  /**
   * Serialize a function, {@link func}, write a Statement to the closure and return
   * an identifier pointing to the serialized closure.
   */
  async function serializeClosure(
    func: Function,
    props: {
      /**
       * The value of the internal [[BoundThis]] property if this function is a native bound function.
       */
      this?: any;
      /**
       * Name of the variable to use when emitting this closure.
       *
       * @default - a unique name is generated.
       */
      variableName?: string;
    } = {}
  ): Promise<ts.Identifier> {
    const funcString = func.toString();

    if (isNativeFunction(funcString)) {
      if (isBoundFunction(func)) {
        // this is a function created with .bind(self)
        const internals = await getFunctionInternals(func);
        if (internals?.targetFunction) {
          return serializeClosure(internals.targetFunction, {
            this: internals.boundThis,
          });
        }
      }
      // @ts-expect-error
      return funcString;
    } else {
      let parsedCode = ts.createSourceFile(
        "",
        funcString,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS
      );

      /**
       * Run transformers on the closure AST before closure analysis.
       */
      if (args.preProcess && args.preProcess.length > 0) {
        const preProcessedCode = ts.transform(parsedCode, args.preProcess)
          .transformed[0];
        if (ts.isSourceFile(preProcessedCode)) {
          parsedCode = preProcessedCode;
        } else {
          throw new Error(`preProcess did not return a SourceFile`);
        }
      }

      const substitutesAsync: Promise<CapturedValue>[] = [];

      let funcAST = getClosure(parsedCode);

      if (funcAST === undefined) {
        throw new Error(`SourceFile did not contain a FunctionDeclaration`);
      }

      if (args.preProcess) {
        funcAST = transform(funcAST, args.preProcess);
      }

      // collect all ids used within the closure
      // we will use to ensure there are no name conflicts when when we re-write nodes
      const ids = new Set<string>();
      ts.forEachChild(funcAST, function walk(node: ts.Node): void {
        if (ts.isIdentifier(node)) {
          ids.add(node.text);
        }
        ts.forEachChild(node, walk);
      });

      funcAST = transform(funcAST, [
        (ctx) =>
          function visit(node: ts.Node): ts.Node {
            if (isThisExpression(node)) {
            } else if (isSuperExpression(node)) {
            } else if (
              ts.isIdentifier(node) &&
              isFreeVariable(node, funcAST!)
            ) {
              substitutesAsync.push(
                (async () => {
                  const val = await getFreeVariable(func, node.text, false);

                  return {
                    lexicalName: node.text,
                    outerNode: await serializeValue(val, ids),
                  };
                })()
              );
            }
            return ts.visitEachChild(node, visit, ctx);
          },
      ]);

      const substitutes = await Promise.all(substitutesAsync);

      if (args.postProcess?.length) {
        funcAST = transform(funcAST, args.postProcess);
      }

      if (args.postProcess) {
        // re-write the closure, pointing references to captured variables to serialized values
        parsedCode = ts.transform(parsedCode, args.postProcess)
          .transformed[0] as ts.SourceFile;
      }

      // unique name of the generated closure
      const closureName = props.variableName ?? nextVarName();
      valueCache.set(func, ts.factory.createIdentifier(closureName));

      emit(
        [
          await makeFunctionStatement(
            parsedCode.statements[0],
            closureName,
            new Map(substitutes.map((sub) => [sub.lexicalName, sub.outerNode]))
          ),
        ],
        parsedCode
      );

      return ts.factory.createIdentifier(closureName);

      async function makeFunctionStatement(
        stmt: ts.Statement,
        closureName: string,
        lexicalScope: Map<string, ts.Expression>
      ) {
        /*
        const _f1 = ((...lexicalScope) => function functionName(...functionArgs) {

        })(inputLexicalScope);
        */

        const names = new Set(lexicalScope.keys());

        function makeName(seed: string): string {
          let tmp = seed;
          let i = 0;
          while (names.has(tmp)) {
            tmp = `${seed}${i}`;
          }
          names.add(tmp);
          return tmp;
        }

        const boundThisName = makeName("_self");
        const boundThis =
          "this" in props ? await serializeValue(props.this, ids) : undefined;

        let superName: string | undefined;
        let superValue: ts.Expression | undefined;
        if (ts.isClassDeclaration(funcAST!) || ts.isClassExpression(funcAST!)) {
          const prototype = Object.getPrototypeOf(func);
          if (prototype !== Function.prototype) {
            // try and find the ts.Identifier of the extends clause and use that name
            // e.g. class A extends B {} // finds B
            // this is purely for aesthetic purposes - an attempt to keep the class expression identical to the source code
            const extendsClause = funcAST.heritageClauses
              ?.flatMap((clause) =>
                clause.token === ts.SyntaxKind.ExtendsKeyword
                  ? clause.types
                  : []
              )
              .find(
                (
                  type
                ): type is typeof type & {
                  expression: ts.Identifier;
                } => ts.isIdentifier(type.expression)
              )?.expression.text;
            superName = makeName(extendsClause ?? "_super");
            superValue = await serializeValue(prototype, ids);
          }
        }

        const innerClosure = boundThis
          ? ts.factory.createCallExpression(
              ts.factory.createPropertyAccessExpression(
                innerClosureExpr(),
                "bind"
              ),
              undefined,
              [ts.factory.createIdentifier(boundThisName)]
            )
          : innerClosureExpr();

        const lexicalScopeArgs = Array.from(lexicalScope.keys()).map((name) =>
          ts.factory.createParameterDeclaration(
            undefined,
            undefined,
            undefined,
            name,
            undefined
          )
        );

        const initClosure = ts.factory.createCallExpression(
          ts.factory.createArrowFunction(
            undefined,
            undefined,
            [
              boundThis ? [createParameterDeclaration(boundThisName)] : [],
              superName ? [createParameterDeclaration(superName)] : [],
              lexicalScopeArgs,
            ].flat(),
            undefined,
            undefined,
            innerClosure
          ),
          undefined,
          [
            boundThis ? [boundThis] : [],
            superValue ? [superValue] : [],
            Array.from(lexicalScope.values()),
          ].flat()
        );

        return ts.factory.createVariableStatement(
          undefined,
          ts.factory.createVariableDeclarationList(
            [
              ts.factory.createVariableDeclaration(
                closureName,
                undefined,
                undefined,
                initClosure
              ),
            ],
            ts.NodeFlags.Const
          )
        );

        function innerClosureExpr():
          | ts.ClassExpression
          | ts.FunctionExpression
          | ts.ArrowFunction {
          if (ts.isClassDeclaration(stmt) || ts.isClassExpression(stmt)) {
            return ts.factory.createClassExpression(
              stmt.decorators,
              stmt.modifiers,
              stmt.name,
              stmt.typeParameters,
              superName
                ? [
                    ts.factory.createHeritageClause(
                      ts.SyntaxKind.ExtendsKeyword,
                      [
                        ts.factory.createExpressionWithTypeArguments(
                          ts.factory.createIdentifier(superName),
                          undefined
                        ),
                      ]
                    ),
                  ]
                : undefined,
              stmt.members
            );
          } else if (ts.isFunctionDeclaration(stmt) && stmt.body) {
            return ts.factory.createFunctionExpression(
              stmt.modifiers,
              stmt.asteriskToken,
              stmt.name,
              undefined,
              stmt.parameters,
              stmt.type,
              stmt.body
            );
          } else if (ts.isExpressionStatement(stmt)) {
            const expr = stmt.expression;
            if (ts.isFunctionExpression(expr)) {
              return ts.factory.createFunctionExpression(
                expr.modifiers,
                expr.asteriskToken,
                ts.factory.createIdentifier(closureName),
                undefined,
                expr.parameters,
                expr.type,
                expr.body
              );
            } else if (ts.isArrowFunction(expr)) {
              return expr;
            } else {
              debugger;
              throw new Error(`invalid ExpressionStatement`);
            }
          } else {
            debugger;
            throw new Error(`invalid Statement`);
          }
        }
      }

      async function serializeValue(
        value: any,
        exclude: Set<string>
      ): Promise<ts.Expression> {
        if (args.preSerializeValue) {
          value = args.preSerializeValue(value);
        }
        if (value === undefined) {
          return ts.factory.createIdentifier("undefined");
        } else if (value === null) {
          return ts.factory.createIdentifier("null");
        } else if (typeof value === "boolean") {
          return value ? ts.factory.createTrue() : ts.factory.createFalse();
        } else if (typeof value === "number") {
          return ts.factory.createNumericLiteral(value);
        } else if (typeof value === "string") {
          return ts.factory.createStringLiteral(value);
        } else if (typeof value === "bigint") {
          return ts.factory.createBigIntLiteral(value.toString(10));
        }

        if (!valueCache.has(value)) {
          const variableName = nextVarName(exclude);
          valueCache.set(value, ts.factory.createIdentifier(variableName));
          return doSerialize(variableName);
        } else {
          return valueCache.get(value)!;
        }

        async function doSerialize(variableName: string) {
          if (typeof value === "function") {
            return serializeClosure(value, {
              variableName,
            });
          } else if (Array.isArray(value)) {
            const elements = [];
            for (const item of value) {
              elements.push(await serializeValue(item, exclude));
            }
            return ts.factory.createArrayLiteralExpression(elements);
          } else if (typeof value === "object") {
            const prototype = Object.getPrototypeOf(value);
            let objectClass;
            if (typeof prototype?.constructor === "function") {
              if (prototype.constructor !== Function) {
                objectClass = await serializeValue(
                  prototype.constructor,
                  exclude
                );
              } else {
                // ordinary function
                prototype;
              }
            }

            const props = [];
            for (const [k, v] of Object.entries(value)) {
              props.push(
                ts.factory.createPropertyAssignment(
                  k,
                  await serializeValue(v, exclude)
                )
              );
            }

            emit(
              [
                ts.factory.createVariableStatement(
                  undefined,
                  ts.factory.createVariableDeclarationList([
                    ts.factory.createVariableDeclaration(
                      variableName,
                      undefined,
                      undefined,
                      ts.factory.createObjectLiteralExpression(props)
                    ),
                  ])
                ),
                ...(objectClass
                  ? [
                      ts.factory.createExpressionStatement(
                        ts.factory.createCallExpression(
                          ts.factory.createPropertyAccessExpression(
                            ts.factory.createIdentifier("Object"),
                            "setPrototypeOf"
                          ),
                          undefined,
                          [
                            ts.factory.createIdentifier(variableName),
                            ts.factory.createPropertyAccessExpression(
                              objectClass,
                              "prototype"
                            ),
                          ]
                        )
                      ),
                    ]
                  : []),
              ],
              parsedCode
            );
            return ts.factory.createIdentifier(variableName);
          }

          return ts.factory.createIdentifier("undefined");
        }
      }
    }
  }
}

/**
 * Gets the Function AST from a SourceFile consisting of a single statement
 * containing either:
 * 1. a ts.FunctionDeclaration
 * 2. a ts.ExpressionStatement(ts.FunctionExpression | ts.ArrowFunction)
 */
function getClosure(
  code: ts.SourceFile
):
  | ts.ClassDeclaration
  | ts.ClassExpression
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | undefined {
  const stmt = code.statements[0];
  return ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)
    ? stmt
    : ts.isExpressionStatement(stmt) &&
      (ts.isFunctionExpression(stmt.expression) ||
        ts.isArrowFunction(stmt.expression) ||
        ts.isClassExpression(stmt.expression))
    ? stmt.expression
    : undefined;
}

function isFreeVariable(
  node: ts.Identifier,
  scope:
    | ts.ClassDeclaration
    | ts.ClassExpression
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction
): boolean {
  const parent = node.parent;

  if (ts.isExpressionWithTypeArguments(parent)) {
    return false;
  }
  return (
    (!(
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isPropertyAccessExpression(parent) ||
      ts.isPropertyAccessChain(parent)
    ) ||
      parent.name !== node) &&
    !isInScope(node.text, parent, scope)
  );
}

function isInScope(
  id: string,
  parent: ts.Node | undefined,
  scope: ts.Node
): boolean {
  if (parent === undefined || ts.isSourceFile(parent)) {
    return false;
  } else if (
    ts.isBlock(parent) &&
    parent.statements.find(
      (stmt) =>
        ts.isFunctionDeclaration(stmt) &&
        stmt.name &&
        ts.isIdentifier(stmt.name) &&
        stmt.name.text === id
    ) !== undefined
  ) {
    // there exists a function declaration with the name, id, within a surrounding block
    // since they will be hoisted, we consider this in scope
    return true;
  } else if (
    (ts.isFunctionLike(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isConstructorDeclaration(parent)) &&
    parent.parameters
      .map((param) => param.name)
      .find(function findName(
        binding: ts.BindingName | ts.BindingElement | ts.ArrayBindingElement
      ): boolean {
        parent;
        if (ts.isIdentifier(binding)) {
          return binding.text === id;
        } else if (ts.isBindingElement(binding)) {
          return findName(binding.name);
        } else if (ts.isObjectBindingPattern(binding)) {
          return binding.elements.find(findName) !== undefined;
        } else if (ts.isArrayBindingPattern(binding)) {
          return binding.elements.find(findName) !== undefined;
        } else {
          return false;
        }
      }) !== undefined
  ) {
    return true;
  }

  return isInScope(id, parent.parent, scope);
}

function isNativeFunction(funcString: string) {
  return funcString === "function () { [native code] }";
}

function isBoundFunction(func: Function): func is Function & {
  name: `bound ${string}`;
} {
  return func.name.startsWith("bound ");
}

function transform(
  funcAST:
    | ts.ClassDeclaration
    | ts.ClassExpression
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction,
  transformers: ts.TransformerFactory<ts.Node>[]
) {
  return ts.transform(funcAST, transformers).transformed[0] as
    | ts.ClassDeclaration
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction;
}

function isThisExpression(node: ts.Node): node is ts.ThisExpression {
  return node.kind === ts.SyntaxKind.ThisKeyword;
}

function isSuperExpression(node: ts.Node): node is ts.SuperExpression {
  return node.kind === ts.SyntaxKind.SuperKeyword;
}

function createParameterDeclaration(name: string) {
  return ts.factory.createParameterDeclaration(
    undefined,
    undefined,
    undefined,
    name
  );
}

async function getFunctionId(
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

export interface FunctionInternals {
  boundThis?: any;
  boundArgs?: any;
  targetFunction?: any;
  prototype?: any;
}

async function getFreeVariable(
  func: Function,
  freeVariable: string,
  throwOnFailure: boolean
): Promise<any> {
  // First, find the runtime's internal id for this function.
  const functionId = await getFunctionId(func);

  // Now, query for the internal properties the runtime sets up for it.
  const { internalProperties } = await inspectProperties(
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

async function getValueForObjectId(
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

async function inspectProperties(
  objectId: inspector.Runtime.RemoteObjectId,
  ownProperties: boolean | undefined
) {
  const session = <GetPropertiesSession>await inspectorSession;
  const post = util.promisify(session.post);

  // This cast will become unnecessary when we move to TS 3.1.6 or above.  In that version they
  // support typesafe '.call' calls.
  const retType = await post.call(session, "Runtime.getProperties", {
    objectId,
    ownProperties,
  });
  if (retType.exceptionDetails) {
    throw new Error(
      `Error calling "Runtime.getProperties(${objectId}, ${ownProperties})": ` +
        retType.exceptionDetails.text
    );
  }

  return {
    internalProperties: retType.internalProperties || [],
    properties: retType.result,
  };
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
async function getFunctionInternals(
  func: Function
): Promise<FunctionInternals | undefined> {
  if (!func.name.startsWith("bound ")) {
    return undefined;
  }
  const functionId = await getFunctionId(func);
  const { internalProperties } = await inspectProperties(functionId, true);

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

const scriptIdToUrlMap = new Map<string, string>();

const inspectorSession = createInspectorSession();

async function createInspectorSession() {
  const inspectorSession = new inspector.Session();

  inspectorSession.connect();

  // Enable debugging support so we can hear about the Debugger.scriptParsed event. We need that
  // event to know how to map from scriptId's to file-urls.
  await new Promise<inspector.Debugger.EnableReturnType>((resolve, reject) => {
    inspectorSession.post("Debugger.enable", (err, res) =>
      err ? reject(err) : resolve(res)
    );
  });

  inspectorSession.addListener("Debugger.scriptParsed", (event) => {
    const { scriptId, url } = event.params;
    scriptIdToUrlMap.set(scriptId, url);
  });

  return inspectorSession;
}

interface InflightContext {
  contextId: number;
  functions: Record<string, any>;
  currentFunctionId: number;
  calls: Record<string, any>;
  currentCallId: number;
}
// Isolated singleton context accessible from the inspector.
// Used instead of `global` object to support executions with multiple V8 vm contexts as, e.g., done by Jest.
const inflightContext = createInflightContext();

async function createInflightContext(): Promise<InflightContext> {
  const context: InflightContext = {
    contextId: 0,
    functions: {},
    currentFunctionId: 0,
    calls: {},
    currentCallId: 0,
  };
  const session = <ContextSession>await inspectorSession;
  const post = util.promisify(session.post);

  // Create own context with known context id and functionsContext as `global`
  await post.call(session, "Runtime.enable");
  const contextIdAsync = new Promise<number>((resolve) => {
    session.once("Runtime.executionContextCreated", (event) => {
      resolve(event.params.context.id);
    });
  });
  vm.createContext(context);
  context.contextId = await contextIdAsync;
  await post.call(session, "Runtime.disable");

  return context;
}

// We want to call util.promisify on inspector.Session.post. However, due to all the overloads of
// that method, promisify gets confused.  To prevent this, we cast our session object down to an
// interface containing only the single overload we care about.
type PostSession<TMethod, TParams, TReturn> = {
  post(
    method: TMethod,
    params?: TParams,
    callback?: (err: Error | null, params: TReturn) => void
  ): void;
};

type EvaluationSession = PostSession<
  "Runtime.evaluate",
  inspector.Runtime.EvaluateParameterType,
  inspector.Runtime.EvaluateReturnType
>;
type GetPropertiesSession = PostSession<
  "Runtime.getProperties",
  inspector.Runtime.GetPropertiesParameterType,
  inspector.Runtime.GetPropertiesReturnType
>;
type CallFunctionSession = PostSession<
  "Runtime.callFunctionOn",
  inspector.Runtime.CallFunctionOnParameterType,
  inspector.Runtime.CallFunctionOnReturnType
>;
type ContextSession = {
  post(
    method: "Runtime.disable" | "Runtime.enable",
    callback?: (err: Error | null) => void
  ): void;
  once(
    event: "Runtime.executionContextCreated",
    listener: (
      message: inspector.InspectorNotification<inspector.Runtime.ExecutionContextCreatedEventDataType>
    ) => void
  ): void;
};

// function getPropertyAccessChainRoot(
//   node: ts.PropertyAccessExpression | ts.PropertyAccessChain
// ): ts.Identifier | ts.ThisExpression | ts.SuperExpression | undefined {
//   const expr = node.expression;
//   if (
//     ts.isIdentifier(expr) ||
//     isThisExpression(expr) ||
//     isSuperExpression(expr)
//   ) {
//     return expr;
//   } else if (
//     ts.isPropertyAccessExpression(expr) ||
//     ts.isPropertyAccessChain(expr)
//   ) {
//     return getPropertyAccessChainRoot(expr);
//   }
//   return undefined;
// }

// function accessProperty(
//   val: any,
//   node: ts.PropertyAccessExpression | ts.PropertyAccessExpression
// ): any {
//   val = val?.[node.name.text];
//   if (
//     ts.isPropertyAccessExpression(node.parent) ||
//     ts.isPropertyAccessChain(node.parent)
//   ) {
//     return accessProperty(val, node.parent);
//   }
//   return val;
// }

// https://github.com/v8/v8/blob/9723c929f3a1dd12aa4f846203be0b286681829a/src/runtime/runtime-function.cc#L17
export const FunctionGetScriptSource = new Function(
  "func",
  "return %FunctionGetScriptSource(func);"
);

export const FunctionGetScriptId = new Function(
  "func",
  "return %FunctionGetScriptId(func);"
);
export const FunctionGetSourceCode = new Function(
  "func",
  "return %FunctionGetSourceCode(func);"
);
export const FunctionGetScriptSourcePosition = new Function(
  "func",
  "return %FunctionGetScriptSourcePosition(func);"
);

// function busyWaitPromise<T>(promise: Promise<T>): T {
//   let result: {
//     ok?: T;
//     error?: any;
//   } = {};

//   while (!("ok" in result || "error" in result)) {
//     // https://github.com/nodejs/node/issues/40054#issuecomment-917643826
//     vm.runInNewContext(
//       "promise.then((ok) => (result.ok = ok )).catch((error) => (result.error = error))",
//       { promise, result },
//       {
//         microtaskMode: "afterEvaluate",
//       }
//     );
//   }
//   if (result.error) {
//     throw result.error;
//   } else {
//     return result.ok!;
//   }
// }
