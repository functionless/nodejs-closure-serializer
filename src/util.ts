import ts from "typescript";

export function assertNever(a: never): never {
  throw new Error(`unreachable code block reached with value: ${a}`);
}

export function nameGenerator(prefix: string) {
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

/**
 * Creates a hoisted variable using the `var` keyword with no `initializer`.
 *
 * ```ts
 * var {@link name};
 * ```
 * @param name name of the variable
 * @returns a ts.VariableStatement for the variable.
 */
export function createVarStatement(name: string) {
  return ts.factory.createVariableStatement(
    undefined,
    ts.factory.createVariableDeclarationList(
      [
        ts.factory.createVariableDeclaration(
          name,
          undefined,
          undefined,
          undefined
        ),
      ],
      // default is `var`
      ts.NodeFlags.None
    )
  );
}

export function createParameterDeclaration(name: string) {
  return ts.factory.createParameterDeclaration(
    undefined,
    undefined,
    undefined,
    name
  );
}

export function createPropertyChain(
  first: string,
  ...rest: [string, ...string[]]
) {
  return rest.reduce(
    (expr, name) => ts.factory.createPropertyAccessExpression(expr, name),
    ts.factory.createIdentifier(first) as ts.Expression
  );
}
