import { Map as iMap } from "immutable";
import ts from "typescript";
import { lookupCapturedVariableValueAsync } from "./v8";
import { getFunctionInternals } from "./v8_v11andHigher";

export interface SerializeFunctionArgs {
  preProcess?: ts.TransformerFactory<ts.Node>[];
  postProcess?: ts.TransformerFactory<ts.Node>[];
}

export async function serializeClosure(
  func: Function,
  args: Partial<SerializeFunctionArgs> = {}
): Promise<string> {
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

  function emit(node: ts.Statement, file: ts.SourceFile) {
    statements.push(
      printer.printNode(ts.EmitHint.Unspecified, node, file).trim()
    );
  }

  function nameGenerator(prefix: string) {
    let i = 0;
    return () => `${prefix}${(i += 1)}`;
  }

  const nextVarName = nameGenerator("v");
  const nextFunctionName = nameGenerator("f");

  const anyToken = Symbol();

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
    bound: {
      this?: any;
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

      const lexicalScope = new Map<string, ts.Expression>();

      const funcAST = getFunction(parsedCode);

      if (funcAST) {
        await evalFunction(funcAST, iMap());
      } else {
        throw new Error(`SourceFile did not contain`);
      }

      if (args.postProcess) {
        // re-write the closure, pointing references to captured variables to serialized values
        parsedCode = ts.transform(parsedCode, args.postProcess)
          .transformed[0] as ts.SourceFile;
      }

      // unique name of the generated closure
      const closureName = nextFunctionName();

      emit(
        await makeFunctionStatement(
          parsedCode.statements[0],
          closureName,
          lexicalScope
        ),
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

        let boundThisName = "_self";
        let i = 0;
        while (names.has(boundThisName)) {
          boundThisName = `_self${(i += 1)}`;
        }

        const boundThis =
          "this" in bound ? await serializeValue(bound.this) : undefined;

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
            boundThis
              ? [
                  ts.factory.createParameterDeclaration(
                    undefined,
                    undefined,
                    undefined,
                    boundThisName
                  ),
                  ...lexicalScopeArgs,
                ]
              : lexicalScopeArgs,
            undefined,
            undefined,
            innerClosure
          ),
          undefined,
          boundThis
            ? [boundThis, ...Array.from(lexicalScope.values())]
            : Array.from(lexicalScope.values())
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

        function innerClosureExpr(): ts.FunctionExpression | ts.ArrowFunction {
          if (ts.isFunctionDeclaration(stmt) && stmt.body) {
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
              throw new Error(`invalid ExpressionStatement`);
            }
          } else {
            throw new Error(`invalid Statement`);
          }
        }
      }

      async function evalFunction(
        func: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
        env: Env
      ) {
        if (func.body) {
          return evalBody(func.body, env);
        }
        return undefined;
      }

      async function evalBody(
        node: ts.ConciseBody,
        env: Env
      ): Promise<[any, iMap<string, any>]> {
        if (ts.isBlock(node)) {
          for (const stmt of node.statements) {
            if (ts.isExpressionStatement(stmt)) {
              await evalExpr(stmt.expression, env);
            } else if (ts.isVariableDeclaration(stmt)) {
              env = bindVariableDeclaration(stmt, env);
            } else if (ts.isVariableDeclarationList(stmt)) {
              env = stmt.declarations.reduce(
                (env, decl) => bindVariableDeclaration(decl, env),
                env
              );
            } else if (ts.isReturnStatement(stmt)) {
              if (stmt.expression === undefined) {
                return [undefined, env];
              }
              return evalExpr(stmt.expression, env);
            }
          }
          throw new Error(`unsupported`);
        }
        return evalExpr(node, env);
      }

      async function evalExpr(
        expr: ts.Expression,
        env: Env
      ): Promise<[any, iMap<string, any>]> {
        if (ts.isIdentifier(expr)) {
          if (env.has(expr.text)) {
            return [env.get(expr.text)!, env];
          } else {
            // declared outside of scope
            const capturedVal = await lookupCapturedVariableValueAsync(
              func,
              expr.text,
              true
            );
            // serialize the captured value and reference it by name
            const valueName = await serializeValue(capturedVal);
            if (valueName === undefined) {
              throw new Error(`value failed to serialize`);
            }
            lexicalScope.set(expr.text, valueName);
            return [capturedVal, env];
          }
        } else if (
          ts.isPropertyAccessExpression(expr) ||
          ts.isPropertyAccessChain(expr)
        ) {
          const [val, updatedEnv] = await evalExpr(expr.expression, env);
          if (ts.isIdentifier(expr.name)) {
            return [val?.[expr.name.text], updatedEnv];
          } else {
            // private identifier
            console.warn("private identifiers are not supported");
          }
          return [val, updatedEnv];
        } else if (
          ts.isElementAccessExpression(expr) ||
          ts.isElementAccessChain(expr)
        ) {
          const [val, envAfterEvalExpr] = await evalExpr(expr.expression, env);
          const [arg, envAfterEvalArg] = await evalExpr(
            expr.argumentExpression,
            envAfterEvalExpr
          );

          return [val?.[arg], envAfterEvalArg];
        } else if (ts.isCallExpression(expr)) {
          const [callTarget, callEnv] = await evalExpr(expr.expression, env);
          env = callEnv;
          if (typeof callTarget !== "function") {
            throw new Error(`value is not callable`);
          }
          const args = [];
          for (const arg of expr.arguments) {
            const [argVal, argEnv] = await evalExpr(arg, env);
            env = argEnv;
            args.push(argVal);
          }
          return [await callTarget(...args), env];
        } else if (ts.isParenthesizedExpression(expr)) {
          return evalExpr(expr.expression, env);
        } else if (ts.isArrowFunction(expr)) {
          return [
            async (...args: any[]): Promise<any> =>
              evalFunction(
                expr,
                expr.parameters.reduce(
                  (env, param, i) => bindNames(param.name, args[i], env),
                  env
                )
              ),
            env,
          ];
        } else if (ts.isArrayLiteralExpression(expr)) {
          let result = [];
          for (const element of expr.elements) {
            if (ts.isSpreadElement(element)) {
              const [val, _env] = await evalExpr(element.expression, env);
              env = _env;
              if (val && Array.isArray(val)) {
                result.push(...val);
              }
            } else {
              const [val, _env] = await evalExpr(element, env);
              env = _env;
              result.push(val);
            }
          }
          return [result, env];
        } else if (ts.isObjectLiteralExpression(expr)) {
          const obj: any = {};
          for (const prop of expr.properties) {
            if (ts.isPropertyAssignment(prop)) {
              const [name, envAfterNameEval] = await evalPropertyName(
                prop.name,
                env
              );
              env = envAfterNameEval;
              const [val, envAfterValEval] = await evalExpr(
                prop.initializer,
                env
              );
              env = envAfterValEval;
              obj[name] = val;
            } else if (ts.isSpreadAssignment(prop)) {
              const [val, envAfterValEval] = await evalExpr(
                prop.expression,
                env
              );
              env = envAfterValEval;
              if (val !== undefined && typeof val === "object") {
                for (const [k, v] of Object.entries(val)) {
                  obj[k] = v;
                }
              }
            }
          }
          return [obj, env];
        } else if (ts.isStringLiteral(expr)) {
          return [expr.text, env];
        } else if (ts.isNumericLiteral(expr)) {
          if (expr.text.includes(".")) {
            return [parseFloat(expr.text), env];
          } else {
            return [parseInt(expr.text, 10), env];
          }
        } else if (ts.isTemplateExpression(expr)) {
          const parts = [expr.head.text];
          for (const span of expr.templateSpans) {
            const [val, _env] = await evalExpr(span.expression, env);
            env = _env;
            parts.push(val);
            if (span.literal) {
              parts.push(span.literal.text);
            }
          }
          return [parts.join(""), env];
        } else if (ts.isBinaryExpression(expr)) {
          const op = expr.operatorToken.kind;
          if (op === ts.SyntaxKind.EqualsToken) {
            const [right, rightEnv] = await evalExpr(expr.right, env);
            env = rightEnv;
            if (ts.isIdentifier(expr.left)) {
              return [right, rightEnv.set(expr.left.text, right)];
            } else if (ts.isPropertyAccessExpression(expr.left)) {
              const left = await _evalExpr(expr.left);
              if (ts.isIdentifier(expr.left.name)) {
                left[expr.left.name.text] = right;
              } else {
                console.warn("private members not supported");
              }
              return [left, env];
            } else if (ts.isElementAccessExpression(expr.left)) {
              const left = await _evalExpr(expr.left.expression);
              const arg = await _evalExpr(expr.left.argumentExpression);
              left[arg] = right;
              return [right, env];
            } else {
              debugger;
              throw new Error(`unsupported syntax`);
            }
          } else if (
            op === ts.SyntaxKind.EqualsEqualsToken ||
            op === ts.SyntaxKind.EqualsEqualsEqualsToken
          ) {
            const left = await _evalExpr(expr.left);
            const right = await _evalExpr(expr.right);

            return op === ts.SyntaxKind.EqualsEqualsToken
              ? [left == right, env]
              : [left === right, env];
          } else if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
            const left = await _evalExpr(expr.left);
            if (!left) {
              // early termination
              return [left, env];
            }
            const right = await _evalExpr(expr.right);

            return left && right;
          } else if (op === ts.SyntaxKind.BarBarToken) {
            const left = await _evalExpr(expr.left);
            if (left) {
              // early termination
              return [left, env];
            }
            const right = await _evalExpr(expr.right);

            return left || right;
          } else if (op === ts.)
        }

        return [undefined, env];

        async function _evalExpr(expr: ts.Expression): Promise<any> {
          const [result, newEnv] = await evalExpr(expr, env);
          env = newEnv;
          return [result];
        }
      }

      async function evalPropertyName(
        name: ts.PropertyName,
        env: Env
      ): Promise<[any, iMap<string, any>]> {
        if (ts.isComputedPropertyName(name)) {
          return evalExpr(name.expression, env);
        } else if (ts.isIdentifier(name)) {
          return [name.text, env];
        } else {
          return evalExpr(name, env);
        }
      }

      function bindVariableDeclaration(decl: ts.VariableDeclaration, env: Env) {
        if (decl.initializer) {
          return bindNames(decl.name, evalExpr(decl.initializer, env), env);
        }
        return env;
      }

      async function serializeValue(value: any): Promise<ts.Expression> {
        if (!valueCache.has(value)) {
          const expr = await doSerialize();
          valueCache.set(value, expr);
          return expr;
        } else {
          return valueCache.get(value)!;
        }

        async function doSerialize() {
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
          } else if (Array.isArray(value)) {
            const elements = [];
            for (const item of value) {
              elements.push(await serializeValue(item));
            }
            return ts.factory.createArrayLiteralExpression(elements);
          } else if (typeof value === "object") {
            const props = [];
            for (const [k, v] of Object.entries(value)) {
              props.push(
                ts.factory.createPropertyAssignment(k, await serializeValue(v))
              );
            }
            const variableName = nextVarName();
            const objectLiteral = ts.factory.createVariableStatement(
              undefined,
              ts.factory.createVariableDeclarationList([
                ts.factory.createVariableDeclaration(
                  variableName,
                  undefined,
                  undefined,
                  ts.factory.createObjectLiteralExpression(props)
                ),
              ])
            );
            emit(objectLiteral, parsedCode);
            return ts.factory.createIdentifier(variableName);
          } else if (typeof value === "function") {
            return serializeClosure(value);
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
function getFunction(
  code: ts.SourceFile
):
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | undefined {
  const stmt = code.statements[0];
  return ts.isFunctionDeclaration(stmt)
    ? stmt
    : ts.isExpressionStatement(stmt) &&
      (ts.isFunctionExpression(stmt.expression) ||
        ts.isArrowFunction(stmt.expression))
    ? stmt.expression
    : undefined;
}

/**
 * Represents the lexical environment during program evaluation.
 *
 * Maps lexical names to values.
 */
type Env = iMap<string, any>;

function bindNames(name: ts.BindingName, value: any, env: Env): Env {
  if (ts.isIdentifier(name)) {
    return env.set(name.text, value);
  } else if (ts.isArrayBindingPattern(name)) {
    if (!Array.isArray(value)) {
      throw new Error(`array binding pattern must operate on an array value`);
    }
    return name.elements.reduce((env, element, i) => {
      if (ts.isOmittedExpression(element)) {
        return env;
      } else if (ts.isBindingElement(element)) {
        return bindNames(element.name, value[i], env);
      } else {
        return assertNever(element);
      }
    }, env);
  } else if (ts.isObjectBindingPattern(name)) {
    if (value === undefined || typeof value !== "object") {
      throw new Error(`object binding pattern must operate on an object value`);
    }
    return name.elements.reduce((env, element) => {
      if (ts.isOmittedExpression(element)) {
        return env;
      } else if (
        ts.isBindingElement(element) &&
        ts.isIdentifier(element.name)
      ) {
        return bindNames(element.name, value[element.name.text], env);
      } else {
        throw new Error(`unsupported syntax`);
      }
    }, env);
  } else {
    return assertNever(name);
  }
}

function assertNever(_a: never): never {
  throw new Error(`unreachable block reached`);
}

function isInScope(id: string, scope: ts.Node | undefined): boolean {
  if (scope === undefined || ts.isSourceFile(scope)) {
    return false;
  } else if (
    ts.isBlock(scope) &&
    scope.statements.find(
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
  } else {
    scope;
  }

  return isInScope(id, scope.parent);
}

function isNativeFunction(funcString: string) {
  return funcString === "function () { [native code] }";
}

function isBoundFunction(func: Function): func is Function & {
  name: `bound ${string}`;
} {
  return func.name.startsWith("bound ");
}
