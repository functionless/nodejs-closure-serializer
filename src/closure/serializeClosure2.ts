import inspector from "inspector";
import util from "util";
import v8 from "v8";
import vm from "vm";
import { Set as iSet } from "immutable";
import ts from "typescript";
v8.setFlagsFromString("--allow-natives-syntax");

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
        if (internals?.targetFunction) {
          return serializeFunction(internals.targetFunction, {
            this: internals.boundThis,
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
        await Promise.all(discoverFreeVariables(funcAST))
      ).filter((a): a is Exclude<typeof a, undefined> => a !== undefined);

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
       * @param props
       * @returns
       * @see
       */
      async function serializeValue(
        value: any,
        props: {
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
          // first time seeing this value, we will write it out as a value in module scope
          const variableName = nextVarName(props.illegalNames);

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

            const constructor = await serializeValue(ownConstructor, props);

            const prototype = Object.getPrototypeOf(value);
            const objectClass = prototype
              ? await serializeValue(prototype, props)
              : undefined;

            const properties = [];
            for (const ownPropertyName of Object.keys(value)) {
              if (!props.omitProperties?.has(ownPropertyName)) {
                properties.push(
                  ts.factory.createPropertyAssignment(
                    ownPropertyName,
                    await serializeValue(value[ownPropertyName], props)
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
              elements.push(await serializeValue(item, props));
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

        // collect all ids used within the closure
        // we will use to ensure there are no name conflicts when when we re-write nodes
        const identifiersInFunction = discoverIdentifiersInCode(funcAST!);

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
                illegalNames: identifiersInFunction,
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
              illegalNames: identifiersInFunction,
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

      /**
       * Find all of the {@link ts.Identifier}s used within the Function.
       */
      function discoverIdentifiersInCode(
        funcAST:
          | ts.ClassDeclaration
          | ts.ClassExpression
          | ts.FunctionDeclaration
          | ts.FunctionExpression
          | ts.ArrowFunction
      ) {
        const identifiersInFunction = new Set<string>();
        ts.forEachChild(funcAST, function walk(node: ts.Node): void {
          if (ts.isIdentifier(node)) {
            identifiersInFunction.add(node.text);
          }
          ts.forEachChild(node, walk);
        });
        return identifiersInFunction;
      }

      interface FreeVariable<T = any> {
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
       * are resolved with {@link getFreeVariable}..
       *
       * @param node TypeScript AST tree node to walk
       * @param lexicalScope accumulated names at this point in the evaluate
       * @returns an array of a Promise resolving each {@link FreeVariable}s referenced by {@link node}
       */
      function discoverFreeVariables(
        /**
         * The current node being visited.
         */
        node: ts.Node,
        /**
         * A Set of all names known at this point in the AST.
         */
        lexicalScope: iSet<string> = iSet()
      ): Promise<FreeVariable | undefined>[] {
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
            discoverFreeVariables
          );
        } else if (ts.isBlock(node)) {
          // first extract all hoisted functions
          lexicalScope = lexicalScope.concat(getBindingNames(node));
          return node.statements.flatMap((stmt) => {
            const freeVariables = discoverFreeVariables(stmt, lexicalScope);
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
            discoverFreeVariables
          );
        } else if (ts.isVariableDeclarationList(node)) {
          return node.declarations.flatMap((variableDecl) =>
            discoverFreeVariables(
              variableDecl,
              lexicalScope.concat(getBindingNames(variableDecl.name))
            )
          );
        } else if (isFreeVariable(node, lexicalScope)) {
          return [
            // capture the free
            (async () => {
              const val = await getFreeVariable(func, node.text, false);

              return {
                variableName: node.text,
                // serialize
                variableValue: val,
              };
            })(),
            ...collectEachChild(node, lexicalScope, discoverFreeVariables),
          ];
        } else {
          return collectEachChild(node, lexicalScope, discoverFreeVariables);
        }
      }

      /**
       * Visit each child and extract values from it by calling {@link extract} with the
       * current {@link lexicalScope}.
       *
       * @param node the AST node to walk each child of
       * @param lexicalScope the current lexical scope (names bound to values at this point in the AST)
       * @param extract a function to extract data from the node
       * @returns all of the extracted items, T.
       */
      function collectEachChild<T>(
        node: ts.Node,
        lexicalScope: iSet<string>,
        extract: (node: ts.Node, lexicalScope: iSet<string>) => T[]
      ): T[] {
        const items: T[] = [];
        ts.forEachChild(node, (n) => {
          items.push(...extract(n, lexicalScope));
        });
        return items;
      }
    }
  }
}

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
const unModifiedGlobalOwnFunctions: [
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

function parseFunctionString(funcString: string): ts.SourceFile {
  const sf = ts.createSourceFile(
    "",
    funcString,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  if (sf.statements.length === 0) {
    throw new Error(`failed to parse function: ${funcString}`);
  } else if (sf.statements.length === 1) {
    return sf;
  } else {
    // this is a method which incorrectly parses as the following
    // [CallExpression, Block]
    // [Identifier(async), CallExpression, Block]
    // [*, CallExpression, Block]

    // append the `function` keyword so that it parses correctly
    return parseFunctionString(`function ${funcString}`);
  }
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

/**
 * Gets the Function AST from a SourceFile consisting of a single statement
 * containing either:
 * 1. a ts.FunctionDeclaration
 * 2. a ts.ExpressionStatement(ts.FunctionExpression | ts.ArrowFunction)
 */
function getClosureFromSourceFile(
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

/**
 * Determines if a ts.Identifier in a Class or Function points to a free variable (i.e. a value outside of its scope).
 */
function isFreeVariable(
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

function isNativeFunction(funcString: string) {
  return funcString.indexOf("[native code]") !== -1;
}

function isBoundFunction(func: Function): func is Function & {
  name: `bound ${string}`;
} {
  return func.name.startsWith("bound ");
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

function createPropertyChain(first: string, ...rest: [string, ...string[]]) {
  return rest.reduce(
    (expr, name) => ts.factory.createPropertyAccessExpression(expr, name),
    ts.factory.createIdentifier(first) as ts.Expression
  );
}

function getBindingNames(
  node:
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
  if (ts.isBlock(node)) {
    // extract all lexical scopes
    return node.statements.flatMap((stmt) =>
      ts.isFunctionDeclaration(stmt) && stmt.name ? [stmt.name.text] : []
    );
  } else if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  ) {
    return node.name ? [node.name.text] : [];
  } else if (ts.isParameter(node)) {
    return getBindingNames(node.name);
  } else if (ts.isIdentifier(node)) {
    return [node.text];
  } else if (
    ts.isArrayBindingPattern(node) ||
    ts.isObjectBindingPattern(node)
  ) {
    return node.elements.flatMap(getBindingNames);
  } else if (ts.isOmittedExpression(node)) {
    return [];
  } else if (ts.isBindingElement(node)) {
    return getBindingNames(node.name);
  } else if (ts.isVariableStatement(node)) {
    return getBindingNames(node.declarationList);
  } else if (ts.isVariableDeclarationList(node)) {
    return node.declarations.flatMap(getBindingNames);
  } else if (ts.isVariableDeclaration(node)) {
    return getBindingNames(node.name);
  }
  return assertNever(node);
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

function assertNever(a: never): never {
  throw new Error(`unreachable code block reached with value: ${a}`);
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
interface PostSession<TMethod, TParams, TReturn> {
  post(
    method: TMethod,
    params?: TParams,
    callback?: (err: Error | null, params: TReturn) => void
  ): void;
}

interface EvaluationSession
  extends PostSession<
    "Runtime.evaluate",
    inspector.Runtime.EvaluateParameterType,
    inspector.Runtime.EvaluateReturnType
  > {}

interface GetPropertiesSession
  extends PostSession<
    "Runtime.getProperties",
    inspector.Runtime.GetPropertiesParameterType,
    inspector.Runtime.GetPropertiesReturnType
  > {}
interface CallFunctionSession
  extends PostSession<
    "Runtime.callFunctionOn",
    inspector.Runtime.CallFunctionOnParameterType,
    inspector.Runtime.CallFunctionOnReturnType
  > {}
interface ContextSession {
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
}

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

// var __extends =
//   (this && this.__extends) ||
//   (function () {
//     var extendStatics = function (d, b) {
//       extendStatics =
//         Object.setPrototypeOf ||
//         ({ __proto__: [] } instanceof Array &&
//           function (d, b) {
//             d.__proto__ = b;
//           }) ||
//         function (d, b) {
//           for (var p in b)
//             if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p];
//         };
//       return extendStatics(d, b);
//     };
//     return function (d, b) {
//       if (typeof b !== "function" && b !== null)
//         throw new TypeError(
//           "Class extends value " + String(b) + " is not a constructor or null"
//         );
//       extendStatics(d, b);
//       function __() {
//         this.constructor = d;
//       }
//       d.prototype =
//         b === null
//           ? Object.create(b)
//           : ((__.prototype = b.prototype), new __());
//     };
//   })();

// var A = /** @class */ (function () {
//   function A() {
//     this.a = "a";
//   }
//   A.foo = function () {};
//   A.prototype.foo = function () {};
//   return A;
// })();
// var B = /** @class */ (function (_super) {
//   __extends(B, _super);
//   function B() {
//     var _this = _super.call(this) || this;
//     _this.b = "b";
//     return _this;
//   }
//   B.foo = function () {};
//   B.prototype.foo = function () {};
//   B.prototype.bar = function () {};
//   return B;
// })(A);
