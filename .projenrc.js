const { typescript } = require('projen');
const { NpmAccess } = require('projen/lib/javascript');
const project = new typescript.TypeScriptProject({
  defaultReleaseBranch: 'main',
  name: '@functionless/nodejs-closure-serializer',
  deps: [
    'normalize-package-data',
    'read-package-tree',
    'semver',
    'ts-node',
    'typescript',
    'upath',
  ] /* Runtime dependencies of this module. */,
  description:
    'A fork of the nodejs closure serializer in @pulumi/pulumi' /* The description is just a string that helps people understand the purpose of the package. */,
  devDeps: [
    '@types/node',
    '@types/normalize-package-data',
    '@types/read-package-tree',
    '@types/semver',
    '@typescript-eslint/eslint-plugin',
    '@typescript-eslint/parser',
    'eslint',
    'eslint-plugin-header',
    'eslint-plugin-import',
    'mockpackage@file:test/mockpackage',
  ] /* Build dependencies for this module. */,
  // packageName: undefined,  /* The "name" in package.json. */
  tsconfig: {
    compilerOptions: {
      skipLibCheck: true,
      target: 'ES2016',
      module: 'commonjs',
      moduleResolution: 'node',
    },
  },
  tsconfigDev: {
    exclude: ['test/tsClosureCases.spec.ts'],
  },
  jestOptions: {
    jestConfig: {
      collectCoverage: false,
      coveragePathIgnorePatterns: ['/test/', '/node_modules/'],
      globals: {
        'ts-jest': {
          isolatedModules: true,
        },
      },
    },
  },
  releaseToNpm: true,
  npmAccess: NpmAccess.PUBLIC,
});

const packageJson = project.tryFindObjectFile('package.json');

packageJson.addOverride('jest.globals.ts-jest.isolatedModules', true);

project.synth();
