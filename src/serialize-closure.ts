import v8 from "v8";
v8.setFlagsFromString("--allow-natives-syntax");

import ts from "typescript";
import { getFreeVariables, FreeVariable } from "./free-variable";
import { getFunctionIdentifiers, getFunctionInternals } from "./function";
import { parseFunctionString } from "./parse-function";
import {
  createParameterDeclaration,
  createVarStatement,
  isBoundFunction,
  isNativeFunction,
  nameGenerator,
  transform,
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
  const emptyFile = ts.createSourceFile(
    "",
    "function () {}",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );

  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

  function emit(stmts: ts.Statement[], file: ts.SourceFile = emptyFile) {
    statements.push(
      ...stmts.map((stmt) =>
        printer.printNode(ts.EmitHint.Unspecified, stmt, file).trim()
      )
    );
  }

  const nextVarName = nameGenerator("v");

  const statements: string[] = [];
  // caches a map of distinct value to a ts.Expression that references the serialized value
  const valueCache = new Map<any, ts.Expression>();

  const handler = await serializeFunction(func);

  return `${statements.join("\n")}\nexports.handler = ${handler.text}${
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
        const internals = await getFunctionInternals(func);
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
      const closureName = props.variableName ?? nextVarName();

      // cache a reference to this value
      valueCache.set(func, ts.factory.createIdentifier(closureName));

      let parsedCode = parseFunctionString(funcString);

      if (serializeProps.preProcess?.length) {
        // Run pre-process transformers on the closure AST prior to closure analysis.
        const preProcessedCode = ts.transform(
          parsedCode,
          serializeProps.preProcess
        ).transformed[0];
        if (ts.isSourceFile(preProcessedCode)) {
          parsedCode = preProcessedCode;
        } else {
          throw new Error(`preProcess did not return a SourceFile`);
        }
      }

      // parsed TypeScript code wraps the closure in a SourceFile(Statement).
      // that Statement may be a FunctionDeclaration, ClassDeclaration, or a VariableStmt(FunctionLikeExpression)
      let funcAST = getClosureFromSourceFile(parsedCode);
      if (funcAST === undefined) {
        throw new Error(`SourceFile did not contain a FunctionDeclaration`);
      }

      if (serializeProps.preProcess) {
        // allow callers to pre-process the AST before serialization
        funcAST = transform(funcAST, serializeProps.preProcess);
      }

      // walk the AST and resolve any free variables - i.e. any ts.Identifiers that point
      // to a value outside of the closure's scope.
      const freeVariables = (
        await Promise.all(getFreeVariables(func, funcAST))
      ).filter((a): a is Exclude<typeof a, undefined> => a !== undefined);

      // when naming variables,
      const illegalNames = new Set([
        ...freeVariables.map(({ variableName }) => variableName),
        // collect all ids used within the closure
        // we will use this to ensure there are no name conflicts with hoisted closure variables
        ...getFunctionIdentifiers(funcAST!),
      ]);

      // hoist free variable declarations
      for (const freeVariable of freeVariables) {
        const serializedFreeVariable = await serializeValue(freeVariable, {
          illegalNames,
        });
      }

      if (serializeProps.postProcess?.length) {
        // allow user to apply AST post-processing to the serialized closure
        funcAST = transform(funcAST, serializeProps.postProcess);
      }

      // emit a statement to the bundle that instantiates this closure
      emit(
        [
          await createClosureStatement(
            closureName,
            parsedCode.statements[0],
            freeVariables
          ),
        ],
        parsedCode
      );

      // return an Identifier pointing to the serialized and initialized closure
      return ts.factory.createIdentifier(closureName);

      /**
       * Serializes a JavaScript value into the bundle.
       *
       * See https://twitter.com/samgoodwin89/status/1545618799482642433?s=20&t=AxGG-nfqH_KQHzmkEBKZ8g
       * for a diagram explaining the algorithmic flow.
       *
       * ## General Form
       *
       * A Function is emitted in the following general form:
       * ```ts
       * export const f1 = ((...freeVariables) => function Foo() {
       *   // syntax
       * })(_self, ...freeVariables)
       * f1.prototype = (serialized Foo.prototype)
       * // (add static properties)
       * f1.staticProp == staticValue
       * // .. etc.
       * // (add static prototype)
       * Object.setPrototype(f1, Function);
       *
       * ```
       *
       * Objects are emitted as a literal, followed by a bunch of statements setting values on the object.
       * ```ts
       * export const v1 = Object.create(BaseType.prototype);
       * v1.constructor = f1;
       * v1.prop = value1;
       * v2.prop = value2;
       * // ..
       * vn.prop = valueN;
       * ```
       *
       * ## Algorithm
       *
       * Say we are serializing the following code.
       * ```ts
       * function Foo() {
       *   this.bar = "bar";
       * }
       *
       * Foo.prototype.getBar = function() {
       *   return this.bar;
       * }
       *
       * const foo = new Foo();
       * ```
       *
       * There are three primary cases to handle when serializing a value:
       *
       * ### Case 1: starting from the function, `Foo`.
       *
       * 1. Emit the function declaration, `Foo`.
       * ```ts
       * export const f1 = (() => function Foo() {
       *   this.bar = "value";
       * })()
       * ```
       *
       * 2. Create an empty object for the `Foo.prototype`
       * ```ts
       * export const o1 = Object.create(Object.prototype);
       *
       * // this could be simplified to an object literal in most cases
       * export const o1 = {};
       *
       * // in general form for any type hierarchy:
       * export const oN = Object.create(SubType.prototype);
       * 3. Add the `constructor: Foo` property to `Foo.prototype`
       * ```ts
       * o1.constructor = f1;
       * ```
       * 4. Add the `prototype: Foo.prototype` to `Foo`
       * ```ts
       * f1.prototype = o1;
       * ```
       * 5. Add all of `Foo.prototype`'s Own Properties
       * ```ts
       * o1.prop1 = value1;
       * // .. etc.
       * ```
       * 6. Add all of the `Foo` Function's Own Properties
       *
       * ### Case 2: starting from an `object`, `foo`.
       *
       * 1. Serialize the `.constructor` property (which will run the Case 1 - Starting with a Function)
       * ```ts
       * const f1 = (() => function Foo() {
       *   this.bar = "value";
       * })/
       * ```
       * 2. `Object.create` an empty object using the `.constructor.prototype` as its prototype
       * ```ts
       * const o1 = Object.create(f1.prototype);
       * ```
       * 3. Set all of the Own Properties
       * ```ts
       * o1.prop = value;
       * // ..
       * ```
       *
       * ### Case 3: starting from a reference to the method, `getBar`.
       *
       * Simply emit the function and capture any free variables.
       *
       * ```ts
       * const f1 = (() => function getBar() {
       *   return this.bar;
       * })
       * ```
       *
       * There is nothing we can do about the `this` reference. This is ok, because calling a reference to
       * this function without first calling `.bind` would break anyway (without serialization)
       * because `this` would be `undefined`.
       *
       * ### Case 4: handling a circular reference where an object's property points to itself
       *
       * Nothing needs to be done because an empty object is always created before adding Own Properties.
       * ```ts
       * const obj = {}
       * obj.prop = obj;
       * ```
       *
       * ### Case 5: circular prototype chains
       *
       * Circular prototype chains are illegal.
       *
       * ```ts
       * const a = {}, b = {};
       * Object.setPrototypeOf(a, b);
       *
       * // TypeError: Cyclic __proto__ value
       * Object.setPrototypeOf(b, a);
       * ```
       *
       * @param value
       * @param serializeValueProps
       * @returns
       * @see
       */
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

        // primitive types should never be cached, simply return their literal values
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
        // TODO: RegExp, Date, etc.
        // TODO: what other primitive types do we need to handle?

        if (!valueCache.has(value)) {
          // first time seeing this value, we will write it out as a value in the top-level scope of the closure
          const variableName = nextVarName(serializeValueProps?.illegalNames);

          emit([
            // emit a `var` for the closured value - so that the hoisted value can be referenced ahead of declaration
            createVarStatement(variableName),
          ]);

          if (typeof value === "function") {
            if (value === Object) {
              return ts.factory.createIdentifier("Object");
            } else if (value === Function) {
              return ts.factory.createIdentifier("Function");
            } else if (value === String) {
              return ts.factory.createIdentifier("String");
            } else if (value === Array) {
              return ts.factory.createIdentifier("Array");
            } else if (value === Number) {
              return ts.factory.createIdentifier("Number");
            }

            return serializeFunction(value, {
              variableName,
            });
          } else if (typeof value === "object") {
            const ownConstructor = value.hasOwnProperty("constructor")
              ? value.constructor
              : undefined;

            const constructor = await serializeValue(
              ownConstructor,
              serializeValueProps
            );

            const prototype = Object.getPrototypeOf(value);
            const objectClass = prototype
              ? await serializeValue(prototype, serializeValueProps)
              : undefined;

            const properties = [];
            for (const ownPropertyName of Object.keys(value)) {
              if (!serializeValueProps?.omitProperties?.has(ownPropertyName)) {
                properties.push(
                  ts.factory.createPropertyAssignment(
                    ownPropertyName,
                    await serializeValue(
                      value[ownPropertyName],
                      serializeValueProps
                    )
                  )
                );
              }
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
                      ts.factory.createObjectLiteralExpression(properties)
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
                            objectClass,
                          ]
                        )
                      ),
                    ]
                  : []),
              ],
              parsedCode
            );
            return ts.factory.createIdentifier(variableName);
          } else if (Array.isArray(value)) {
            const elements = [];
            for (const item of value) {
              elements.push(await serializeValue(item, serializeValueProps));
            }
            return ts.factory.createArrayLiteralExpression(elements);
          }

          return ts.factory.createIdentifier("undefined");
        } else {
          return valueCache.get(value)!;
        }
      }

      async function createClosureStatement(
        closureName: string,
        stmt: ts.Statement,
        freeVariables: FreeVariable[]
      ) {
        const lexicalScope = new Set(
          freeVariables.map((freeVariable) => freeVariable.variableName)
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

        const freeVariableArgs = freeVariables.map((freeVariable) =>
          ts.factory.createParameterDeclaration(
            undefined,
            undefined,
            undefined,
            freeVariable.variableName,
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
            freeVariables.map((freeVariable) => freeVariable.variableValue),
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
    }
  }
}

/**
 * Gets the Function AST from a SourceFile consisting of a single statement
 * containing either:
 * 1. a ts.FunctionDeclaration
 * 2. a ts.ExpressionStatement(ts.FunctionExpression | ts.ArrowFunction)
 */
export function getClosureFromSourceFile(
  code: ts.SourceFile
):
  | ts.ClassDeclaration
  | ts.ClassExpression
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | undefined {
  const stmt = code.statements[0];
  if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
    return stmt;
  } else if (ts.isExpressionStatement(stmt)) {
    if (
      ts.isFunctionExpression(stmt.expression) ||
      ts.isArrowFunction(stmt.expression) ||
      ts.isClassExpression(stmt.expression)
    ) {
      return stmt.expression;
    }
  }
  return undefined;
}
