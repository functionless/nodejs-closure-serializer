import v8 from "v8";
v8.setFlagsFromString("--allow-natives-syntax");

import ts from "typescript";
import { getBoundFunction } from "./bound-function";
import { FreeVariables, getClosure } from "./free-variables";
import { FunctionNode, parseFunction } from "./parse-function";
import { transformFunction } from "./transform-function";
import {
  createParameterDeclaration,
  createPropertyChain,
  isBoundFunction,
  isNativeFunction,
  nameGenerator,
} from "./util";

export interface SerializeFunctionProps {
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

  /**
   * If this is a function which, when invoked, will produce the actual entrypoint function.
   * Useful for when serializing a function that has high startup cost that only wants to be
   * run once. The signature of this function should be:  () => (provider_handler_args...) => provider_result
   *
   * This will then be emitted as: `exports.[exportName] = serialized_func_name();`
   *
   * In other words, the function will be invoked (once) and the resulting inner function will
   * be what is exported.
   *
   * @default false
   */
  isFactoryFunction?: boolean;
}

/**
 * Serialize any `Function` into a string containing the text of a JavaScript module that, when evaluated,
 * will export a single function, `handle`, that when called, will execute that function
 *
 * This functionality enables arbitrary JS Functions to be serialized for remote execution without
 * losing all of the context of the closure, such as references to variables captured by the closure.
 *
 * @param func function to serialize
 * @param serializeProps
 * @returns
 */
export async function serializeFunction(
  func: Function,
  serializeProps: SerializeFunctionProps = {}
): Promise<string> {
  // @ts-ignore
  const emptyFile = ts.createSourceFile(
    "",
    "function () {}",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );

  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

  const nextVarName = nameGenerator("v");

  /**
   * JavaScript Statements that will be executed first
   */
  const pre: string[] = [];
  /**
   * JavaScript Statements that will be executed
   */
  const post: string[] = [];

  // caches a map of distinct value to a ts.Expression that references the serialized value
  const emitCache = new Map<any, ts.Expression>();

  const handler = await serializeFunction(func);

  return `${pre.concat(post).join("\n")}\nexports.handler = ${handler.text}${
    serializeProps.isFactoryFunction ? "()" : ""
  }`;

  /**
   * Serialize a function, {@link func}, write a Statement to the closure and return
   * an identifier pointing to the serialized closure.
   */
  async function serializeFunction(
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
        // This is a function created with `.bind(self)`. We then use the inspector API
        // to discover the value of the internal property, `[[BoundThis]]`, serialize that
        // function and then re-construct the `.bind` call in the remote code.
        const internals = getBoundFunction(func);
        if (internals?.["[[TargetFunction]]"]) {
          return serializeFunction(internals["[[TargetFunction]]"], {
            this: internals["[[BoundThis]]"],
          });
        }
      }
      // TODO: check if this is a native function by inspecting the `gypfile` property in
      // `package.json`, then compile those native libraries and link them to the serialized module.
      debugger;
      throw new Error(`Cannot handle native function: ${funcString}`);
    } else {
      // unique name of the generated closure
      const closureName = ts.factory.createIdentifier(
        props.variableName ?? nextVarName()
      );

      // cache a reference to this value
      emitCache.set(func, closureName);

      let [functionNode, sourceFile] = parseFunction(funcString);

      if (serializeProps.preProcess?.length) {
        // Run pre-process transformers on the closure AST prior to closure analysis.
        functionNode = transformFunction(
          functionNode,
          serializeProps.preProcess
        );
      }

      const closure = getClosure(func);

      // walk the AST and resolve any free variables - i.e. any ts.Identifiers that point
      // to a value outside of the closure's scope.
      const freeVariables = closure?.captured ?? {};

      // when naming variables,
      const illegalNames = new Set(Object.keys(freeVariables));

      if (serializeProps.postProcess?.length) {
        // allow user to apply AST post-processing to the serialized closure
        functionNode = transformFunction(
          functionNode,
          serializeProps.postProcess
        );
      }

      // emit a statement to the bundle that instantiates this closure
      await emitClosure(closureName, functionNode, freeVariables);

      // Function.prototype
      emitPre(
        // set the prototype on the Function
        // var o1 = {};
        // f1.prototype = o1
        ts.factory.createExpressionStatement(
          ts.factory.createBinaryExpression(
            ts.factory.createPropertyAccessExpression(closureName, "prototype"),
            ts.factory.createToken(ts.SyntaxKind.EqualsToken),
            await serializeValue(func.prototype)
          )
        )
      );

      // Function[[Prototype]]
      const funcPrototype = Object.getPrototypeOf(func);
      if (funcPrototype !== Function.prototype) {
        // this is a custom prototype, set with Object.setPrototypeOf(), maintain this relationship
        emitPre(
          // Object.setPrototypeOf(f1, f2)
          ts.factory.createExpressionStatement(
            ts.factory.createCallExpression(
              createPropertyChain("Object", "setPrototypeOf"),
              undefined,
              [await serializeValue(funcPrototype)]
            )
          )
        );
      }

      // return an Identifier pointing to the serialized and initialized closure
      return closureName;

      function emitPre(...stmts: ts.Statement[]) {
        emit(pre, stmts);
      }

      function emitPost(...stmts: ts.Statement[]) {
        emit(post, stmts);
      }

      function emit(to: string[], stmts: ts.Statement[]) {
        to.push(
          ...stmts.map((stmt) =>
            printer.printNode(ts.EmitHint.Unspecified, stmt, sourceFile).trim()
          )
        );
      }

      async function serializeValue(
        value: any,
        serializeValueProps?: {
          illegalNames: Set<string>;
          /**
           * Names of properties to omit when serializing objects.
           */
          omitProperties?: Set<string>;
        }
      ): Promise<ts.Expression> {
        if (serializeProps.preSerializeValue) {
          // allow callers to swap a value prior to serialization so that custom logic such
          // as omitting properties can be implemented within libraries.
          value = serializeProps.preSerializeValue(value);
        }

        // TODO: RegExp, Date, etc.
        // TODO: what other primitive types do we need to handle?

        if (emitCache.has(value)) {
          return emitCache.get(value)!;
        } else {
          if (value === undefined) {
            return ts.factory.createIdentifier("undefined");
          } else if (value === null) {
            return ts.factory.createIdentifier("null");
          } else if (value === true) {
            return ts.factory.createTrue();
          } else if (value === false) {
            return ts.factory.createFalse();
          } else if (typeof value === "number") {
            return ts.factory.createNumericLiteral(value);
          } else if (typeof value === "string") {
            return ts.factory.createStringLiteral(value);
          } else if (typeof value === "bigint") {
            return ts.factory.createBigIntLiteral(value.toString(10));
          } else if (typeof value === "symbol") {
            // TODO
          } else if (typeof value === "function") {
            return serializeFunction(value);
          } else if (typeof value === "object") {
            const variableName = ts.factory.createIdentifier(
              nextVarName(serializeValueProps?.illegalNames)
            );
            emitCache.set(value, variableName);

            if (Array.isArray(value)) {
              // initialize an empty array in the pre-phase
              emitPre(
                // var o1 = [];
                ts.factory.createVariableStatement(
                  undefined,
                  ts.factory.createVariableDeclarationList([
                    ts.factory.createVariableDeclaration(
                      variableName,
                      undefined,
                      undefined,
                      ts.factory.createArrayLiteralExpression()
                    ),
                  ])
                )
              );

              // push all of the values into the array in the post-phase
              emitPost(
                // array.push(i0, i1, .., iN)
                ts.factory.createExpressionStatement(
                  ts.factory.createCallExpression(
                    ts.factory.createPropertyAccessExpression(
                      variableName,
                      "push"
                    ),
                    undefined,
                    await Promise.all(
                      value.map((value) =>
                        serializeValue(value, serializeValueProps)
                      )
                    )
                  )
                )
              );
            } else {
              // emit an empty object literal
              // var o1 = {};
              emitPre(
                ts.factory.createVariableStatement(
                  undefined,
                  ts.factory.createVariableDeclarationList([
                    ts.factory.createVariableDeclaration(
                      variableName,
                      undefined,
                      undefined,
                      ts.factory.createObjectLiteralExpression()
                    ),
                  ])
                )
              );

              for (const ownPropName of Object.getOwnPropertyNames(value)) {
                const ownProp = value[ownPropName];

                // after all functions and objects are emitted, set the property
                emitPost(
                  ts.factory.createExpressionStatement(
                    ts.factory.createCallExpression(
                      createPropertyChain("Object", "defineProperty"),
                      undefined,
                      [
                        variableName,
                        await serializeValue(ownPropName),
                        await serializeValue(ownProp),
                      ]
                    )
                  )
                );
              }
            }

            const prototype = Object.getPrototypeOf(value);
            if (
              prototype !== Array.isArray(value)
                ? Array.prototype
                : Object.prototype
            ) {
              // if the prototype of the object is not the expected prototype
              // i.e. if the prototype has been modified wih Object.setPrototypeOf
              // then serialize that prototype and re-set it.
              emitPost(
                ts.factory.createExpressionStatement(
                  ts.factory.createCallExpression(
                    createPropertyChain("Object", "setPrototypeOf"),
                    undefined,
                    [variableName, await serializeValue(prototype)]
                  )
                )
              );
            }

            return variableName;
          }

          return ts.factory.createIdentifier("undefined");
        }
      }

      async function emitClosure(
        closureName: ts.Identifier,
        expr: FunctionNode,
        freeVariables: FreeVariables
      ): Promise<void> {
        const lexicalScope = new Set(
          Object.entries(freeVariables).map(([varName]) => varName)
        );

        /**
         * Function for creating names that do not collide with the free variable names.
         *
         * @param desiredName the ideal name that may or may not be unique
         * @returns the `desiredName` if it is unique, or increments a tail number until it is unique.
         */
        function makeLexicallyUniqueName(desiredName: string): string {
          let tmp = desiredName;
          let i = 0;
          while (lexicalScope.has(tmp)) {
            tmp = `${desiredName}${i}`;
          }
          lexicalScope.add(tmp);
          return tmp;
        }

        const boundThisName = makeLexicallyUniqueName("_self");
        const boundThis =
          "this" in props
            ? await serializeValue(props.this, {
                illegalNames,
              })
            : undefined;

        let superName: string | undefined;
        let superValue: ts.Expression | undefined;
        if (ts.isClassDeclaration(expr!) || ts.isClassExpression(expr!)) {
          const prototype = Object.getPrototypeOf(func);
          if (prototype !== Function.prototype) {
            // try and find the ts.Identifier of the extends clause and use that name
            // e.g. class A extends B {} // finds B
            // this is purely for aesthetic purposes - an attempt to keep the class expression identical to the source code
            const extendsClause = expr.heritageClauses
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
            superName = makeLexicallyUniqueName(extendsClause ?? "_super");
            superValue = await serializeValue(prototype, {
              illegalNames,
            });
          }
        }

        /*
        const _f1 = ((...lexicalScope) => function functionName(...functionArgs) {

        })(inputLexicalScope);
        */

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

        const freeVariableArgs = Object.entries(freeVariables).map(
          ([varName]) =>
            ts.factory.createParameterDeclaration(
              undefined,
              undefined,
              undefined,
              varName,
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
              freeVariableArgs,
            ].flat(),
            undefined,
            undefined,
            innerClosure
          ),
          undefined,
          [
            boundThis ? [boundThis] : [],
            superValue ? [superValue] : [],
            Object.entries(freeVariables).map(([, varValue]) => varValue),
          ].flat()
        );

        emitPre(
          ts.factory.createVariableStatement(
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
              ts.NodeFlags.None
            )
          )
        );

        function innerClosureExpr():
          | ts.ClassExpression
          | ts.FunctionExpression
          | ts.ArrowFunction {
          if (ts.isClassDeclaration(expr) || ts.isClassExpression(expr)) {
            return ts.factory.createClassExpression(
              expr.decorators,
              expr.modifiers,
              expr.name,
              expr.typeParameters,
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
              expr.members
            );
          } else if (ts.isFunctionDeclaration(expr) && expr.body) {
            return ts.factory.createFunctionExpression(
              expr.modifiers,
              expr.asteriskToken,
              expr.name,
              undefined,
              expr.parameters,
              expr.type,
              expr.body
            );
          } else if (ts.isFunctionExpression(expr)) {
            return ts.factory.createFunctionExpression(
              expr.modifiers,
              expr.asteriskToken,
              closureName,
              undefined,
              expr.parameters,
              expr.type,
              expr.body
            );
          } else if (ts.isArrowFunction(expr)) {
            return expr;
          } else {
            debugger;
            throw new Error(`invalid FunctionNode`);
          }
        }
      }
    }
  }
}
