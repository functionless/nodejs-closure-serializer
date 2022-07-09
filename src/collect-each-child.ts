import { Set as iSet } from "immutable";
import ts from "typescript";

/**
 * Visit each child and {@link collect} a list of {@link T}.
 *
 * @param node AST node to visit the children of
 * @param collect function for analyzing and extracting data from a child AST node.
 */
export function collectEachChild<T>(
  node: ts.Node,
  collect: (node: ts.Node) => T[]
): T[];

/**
 * Visit each child and {@link collect} a list of {@link T} using the current {@link lexicalScope}.
 *
 * @param node the AST node to walk each child of
 * @param lexicalScope the current lexical scope (names bound to values at this point in the AST)
 * @param extract a function to extract data from the node
 * @returns all of the extracted items, T.
 */
export function collectEachChild<T>(
  node: ts.Node,
  lexicalScope: iSet<string>,
  extract: (node: ts.Node, lexicalScope: iSet<string>) => T[]
): T[];

export function collectEachChild<T>(
  node: ts.Node,
  lexicalScopeOrExtract:
    | iSet<string>
    | ((node: ts.Node, lexicalScope?: iSet<string>) => T[]),
  maybeExtract?: (node: ts.Node, lexicalScope: iSet<string>) => T[]
): T[] {
  const lexicalScope = maybeExtract
    ? (lexicalScopeOrExtract as iSet<string>)
    : undefined;
  const extract =
    maybeExtract ??
    (lexicalScopeOrExtract as (
      node: ts.Node,
      lexicalScope?: iSet<string>
    ) => T[]);
  const items: T[] = [];
  ts.forEachChild(node, (n) => {
    items.push(...extract(n, lexicalScope!));
  });
  return items;
}
