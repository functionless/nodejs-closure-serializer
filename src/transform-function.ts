import ts from "typescript";

export function transformFunction(
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
