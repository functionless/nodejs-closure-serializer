import fs from "fs";
import Module from "module";
import ts from "typescript";

(global as any).wrapClosure = (closure: Function) => closure;

const originalRequire = Module.prototype.require;

Module.prototype.require = function (this: Module, moduleName: string) {
  const m = Module;
  m;
  // @ts-ignore
  const fileName = Module._resolveFilename(moduleName, this);
  if (fileName in this.require.cache) {
    return this.require.cache[fileName];
  } else if (fileName.endsWith(".js")) {
    const text = fs.readFileSync(fileName).toString("utf-8");

    const transpiled = ts.transpileModule(text, {
      fileName,
      moduleName,
      transformers: {
        after: [
          (ctx) => (sourceFile) => {
            return ts.visitEachChild(
              sourceFile,
              function transform(node) {
                if (ts.isFunctionDeclaration(node) && node.name && node.body) {
                  return ts.factory.createVariableStatement(
                    undefined,
                    ts.factory.createVariableDeclarationList(
                      [
                        ts.factory.createVariableDeclaration(
                          node.name,
                          undefined,
                          undefined,
                          wrapClosure(
                            ts.factory.createFunctionExpression(
                              node.modifiers,
                              node.asteriskToken,
                              node.name,
                              node.typeParameters,
                              node.parameters,
                              node.type,
                              node.body
                            )
                          )
                        ),
                      ],
                      // var - to mimick hoisting
                      ts.NodeFlags.None
                    )
                  );
                } else if (
                  ts.isFunctionExpression(node) ||
                  ts.isArrowFunction(node)
                ) {
                  return wrapClosure(node);
                }
                return node;
              },
              ctx
            );
          },
        ],
      },
    });

    const moduleText = `${transpiled.outputText}${
      transpiled.sourceMapText ? `\n${transpiled.sourceMapText}` : ""
    }`;

    try {
      // @ts-ignore
      const mod = module._compile(moduleText, fileName);
      return (this.require.cache[fileName] = mod);
    } catch (err) {
      throw err;
    }
  }

  return originalRequire(moduleName);
} as any;

function wrapClosure(expr: ts.Expression): ts.CallExpression {
  return ts.factory.createCallExpression(
    ts.factory.createPropertyAccessExpression(
      ts.factory.createIdentifier("global"),
      "wrapClosure"
    ),
    undefined,
    [expr]
  );
}
Module.prototype.require.cache = {};

Object.setPrototypeOf(Module.prototype.require, originalRequire);

// For Jest, we will need to build a transformer
// https://jestjs.io/docs/code-transformation
