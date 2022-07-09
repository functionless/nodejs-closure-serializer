import ts from "typescript";

export function parseFunctionString(funcString: string): ts.SourceFile {
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
