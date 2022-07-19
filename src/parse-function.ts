import ts from "typescript";

export type FunctionNode =
  | ts.ClassDeclaration
  | ts.ClassExpression
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction;

export function parseFunction(
  funcString: string
): [closure: FunctionNode, sourceFile: ts.SourceFile] {
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
    // Gets the Function AST from a SourceFile consisting of a single statement containing either:
    // 1. a ts.FunctionDeclaration
    // 2. a ts.ExpressionStatement(ts.FunctionExpression | ts.ArrowFunction)
    const stmt = sf.statements[0];
    if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
      return [stmt, sf];
    } else if (ts.isExpressionStatement(stmt)) {
      if (
        ts.isFunctionExpression(stmt.expression) ||
        ts.isArrowFunction(stmt.expression) ||
        ts.isClassExpression(stmt.expression)
      ) {
        return [stmt.expression, sf];
      }
    }
    throw new Error(
      `Failed to parse function to Class, Function or ArrowFunction: ${funcString}`
    );
  } else {
    // this is a method which incorrectly parses as the following
    // [CallExpression, Block]
    // [Identifier(async), CallExpression, Block]
    // [*, CallExpression, Block]

    // append the `function` keyword so that it parses correctly
    return parseFunction(`function ${funcString}`);
  }
}
