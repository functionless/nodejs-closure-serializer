use crate::{lexical_scope::LexicalScope, wrap_closure::WrapClosure};
use swc_ecma_visit::Visit;
use swc_plugin::ast::*;

pub enum ArrowOrFunction<'a> {
  ArrowFunction(&'a ArrowExpr),
  Function(&'a Function),
}

pub struct FreeVariable {
  pub name: JsWord,
  pub id: u32,
}

pub fn discover_free_variables(func: ArrowOrFunction, outer: &LexicalScope) -> Vec<FreeVariable> {
  let mut scanner = FreeVariableScanner {
    outer,
    inner: LexicalScope::new(),
  };

  match func {
    ArrowOrFunction::ArrowFunction(arrow) => arrow.visit_with(&mut scanner),
    ArrowOrFunction::Function(function) => function.visit_with(&mut scanner),
  }

  Vec::new()
}

pub struct FreeVariableScanner<'a> {
  outer: &'a LexicalScope,
  inner: LexicalScope,
}

impl Visit for FreeVariableScanner<'_> {}
