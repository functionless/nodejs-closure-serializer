use nodejs_closure_serializer::wrap;
use std::path::PathBuf;
use swc_common::{chain, Mark};
use swc_ecma_transforms_base::resolver;

use swc_ecma_parser::{EsConfig, Syntax};
use swc_ecma_transforms_testing::{test, test_fixture};
use swc_ecma_visit::Fold;

#[testing::fixture("tests/fixture/**/input.js")]
fn exec(input: PathBuf) {
  let output = input.with_file_name("output.js");
  test_fixture(
    Syntax::Es(EsConfig {
      ..Default::default()
    }),
    &|_| test_runner(),
    &input,
    &output,
  );
}

fn test_runner() -> impl Fold {
  let mark = Mark::fresh(Mark::root());

  chain!(resolver(Mark::new(), mark, false), wrap(mark))
}
