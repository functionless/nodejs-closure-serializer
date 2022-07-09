import ts from "typescript";

export function isNativeFunction(funcString: string) {
  return funcString.indexOf("[native code]") !== -1;
}

export function isBoundFunction(func: Function): func is Function & {
  name: `bound ${string}`;
} {
  return func.name.startsWith("bound ");
}

export function isThisExpression(node: ts.Node): node is ts.ThisExpression {
  return node.kind === ts.SyntaxKind.ThisKeyword;
}

export function isSuperExpression(node: ts.Node): node is ts.SuperExpression {
  return node.kind === ts.SyntaxKind.SuperKeyword;
}
