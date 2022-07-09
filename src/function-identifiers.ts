import ts from "typescript";
import { collectEachChild } from "./collect-each-child";

/**
 * Find all of the {@link ts.Identifier}s used within the Function.
 */
export function discoverFunctionIdentifiers(
  funcAST:
    | ts.ClassDeclaration
    | ts.ClassExpression
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction
): string[] {
  return collectEachChild(funcAST, function walk(node): string[] {
    if (ts.isIdentifier(node)) {
      return [node.text];
    }
    return collectEachChild(node, walk);
  });
}
