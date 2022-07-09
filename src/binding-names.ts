import ts from "typescript";
import { assertNever } from "./util";

export function getBindingNames(
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
