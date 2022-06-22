const { chmodSync } = require("fs");
const { typescript, TextFile } = require("projen");
const { NpmAccess } = require("projen/lib/javascript");

/**
 * Adds githooks into the .git/hooks folder during projen synth.
 *
 * @see https://git-scm.com/docs/githooks
 */
class GitHooksPreCommitComponent extends TextFile {
  constructor(project) {
    super(project, ".git/hooks/pre-commit", {
      lines: ["#!/bin/sh", "npx -y lint-staged"],
    });
  }

  postSynthesize() {
    chmodSync(this.path, "755");
  }
}

const project = new typescript.TypeScriptProject({
  defaultReleaseBranch: "main",
  name: "@functionless/nodejs-closure-serializer",
  deps: [
    "normalize-package-data",
    "read-package-tree",
    "semver",
    "ts-node",
    "typescript",
    "upath",
  ] /* Runtime dependencies of this module. */,
  description:
    "A fork of the nodejs closure serializer in @pulumi/pulumi" /* The description is just a string that helps people understand the purpose of the package. */,
  devDeps: [
    "@types/node",
    "@types/normalize-package-data",
    "@types/read-package-tree",
    "@types/semver",
    "@typescript-eslint/eslint-plugin",
    "@typescript-eslint/parser",
    "eslint",
    "eslint-plugin-header",
    "eslint-plugin-import",
    "mockpackage@file:test/mockpackage",
  ] /* Build dependencies for this module. */,
  // packageName: undefined,  /* The "name" in package.json. */
  tsconfig: {
    compilerOptions: {
      skipLibCheck: true,
      target: "ES2016",
      module: "commonjs",
      moduleResolution: "node",
    },
  },
  tsconfigDev: {
    exclude: ["test/tsClosureCases.spec.ts"],
  },
  jestOptions: {
    jestConfig: {
      collectCoverage: false,
      coveragePathIgnorePatterns: ["/test/", "/node_modules/"],
      globals: {
        "ts-jest": {
          isolatedModules: true,
        },
      },
    },
  },
  releaseToNpm: true,
  npmAccess: NpmAccess.PUBLIC,
  eslintOptions: {
    lintProjenRc: true,
  },
  prettier: true,
  prettierOptions: {},
});

new GitHooksPreCommitComponent(project);

const packageJson = project.tryFindObjectFile("package.json");

packageJson.addOverride("lint-staged", {
  "*.{tsx,jsx,ts,js}": ["eslint --fix"],
});

packageJson.addOverride("jest.globals.ts-jest.isolatedModules", true);

project.eslint.addRules({
  quotes: "off",
  "comma-dangle": "off",
  "quote-props": "off",
  "@typescript-eslint/indent": "off",
  "@typescript-eslint/no-shadow": "off",
  "@typescript-eslint/member-ordering": "off",
  "brace-style": "off",
  "@typescript-eslint/explicit-member-accessibility": "off",
});

project.synth();
