# Closure Serializer

This is a **fork** of the [Pulumi](https://www.pulumi.com/) Closure Serializer. [`@pulumi/pulumi`](https://github.com/pulumi/pulumi/tree/master/sdk/nodejs/runtime/closure).

## Motivation

[Functionless](https://github.com/functionless/functionless) allows developers to write cloud applications (using [`aws-cdk`](https://aws.amazon.com/cdk/)) with pure typescript.

```ts
const sfn = new StepFunction(stack, "sfn", () => {
  /* something in the state machine */
  return "result";
});

new Function(stack, "func", async () => {
  return sfn();
});
```

> More on `Function` in the doc: https://functionless.org/docs/concepts/function

Pulumi's closure serializer helped us bootstrap this experience by doing the heavy lifting of runtime data serialization.

However, Pulumi's serializer had a few short comings:

1. Coupled to the whole `@pulumi/pulumi` npm package
2. Limited extensibility
3. Makes use of Pulumi resources (Logging and Secrets) in the serializer

## Changes from [Pulumi](https://github.com/pulumi/pulumi/tree/master/sdk/nodejs/runtime/closure)

- Bug Fix: Symbol Support
- Removed: Pulumi Secret support
- Removed: Pulumi Logging support
- Change: `serialize` function support replacement of runtime data to be serialized on top of avoiding serialization
- Change: [Do not serialize functions and constructors that are not invoked](https://github.com/functionless/nodejs-closure-serializer/pull/8)
- Change: Anonymous functions can be injected at runtime through the serialize callback.
- Change: Allow for TypeScript TransformerFactory functions to be applied to serialized closures.
- Change: Replace the `with` syntax with simple `let` statements.

## Forked from

https://github.com/pulumi/pulumi/releases/tag/v3.33.2
