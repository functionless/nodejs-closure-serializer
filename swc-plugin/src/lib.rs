// unstable API, but is the most efficient way to filter a vec in place
// https://github.com/rust-lang/rust/issues/43244
#![feature(drain_filter)]

use swc_common::Mark;
use swc_ecma_visit::{Fold, VisitMut};
use swc_plugin::{ast::*, plugin_transform, TransformPluginProgramMetadata};
use wrap_closure::WrapClosure;

mod free_variables;
mod lexical_scope;
mod wrap_closure;

#[plugin_transform]
pub fn wrap_closures(mut program: Program, _metadata: TransformPluginProgramMetadata) -> Program {
  program.visit_mut_with(&mut WrapClosure::new());

  program
}

pub fn wrap(top_level_mark: Mark) -> impl Fold + VisitMut {
  as_folder(WrapClosure::new())
}
