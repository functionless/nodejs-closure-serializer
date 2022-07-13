use swc_common::{util::take::Take, DUMMY_SP};
use swc_ecma_visit::VisitMut;
use swc_plugin::ast::*;
use swc_plugin::utils::quote_ident;

use crate::free_variables::{discover_free_variables, ArrowOrFunction, FreeVariable};
use crate::lexical_scope::{Hoist, LexicalScope};

pub struct WrapClosure {
  /**
   * The [lexical scope](LexicalScope) of the program at the current point of the AST.
   */
  pub stack: LexicalScope,
}

impl WrapClosure {
  pub fn new() -> WrapClosure {
    WrapClosure {
      stack: LexicalScope::new(),
    }
  }
}

impl VisitMut for WrapClosure {
  // Implement necessary visit_mut_* methods for actual custom transform.
  // A comprehensive list of possible visitor methods can be found here:
  // https://rustdoc.swc.rs/swc_ecma_visit/trait.VisitMut.html

  fn visit_mut_module_items(&mut self, items: &mut Vec<ModuleItem>) {
    self.stack.bind_hoisted_stmts_in_block(items);
    items.iter_mut().for_each(|stmt| stmt.visit_mut_with(self));
  }

  fn visit_mut_block_stmt(&mut self, block: &mut BlockStmt) {
    // we are entering a block, so push a frame onto the stack
    self.stack.push(Hoist::Block);

    self.stack.bind_hoisted_stmts_in_block(&block.stmts);

    // now that all hoisted variables are in scope, walk each of the children
    block.visit_mut_children_with(self);

    // finally, pop the stack frame
    self.stack.pop();
  }

  fn visit_mut_var_decl(&mut self, var: &mut VarDecl) {
    for decl in var.decls.iter_mut() {
      // bind the variable into scope
      self.stack.bind_var_declarator(var.kind, decl);

      if decl.init.is_some() {
        // then visit the initializer with the updated lexical scope
        decl.init.as_deref_mut().unwrap().visit_mut_with(self);
      }
    }
  }

  fn visit_mut_expr(&mut self, expr: &mut Expr) {
    match expr {
      Expr::Arrow(arrow) => {
        *expr = self.wrap_arrow_expr(arrow);
      }
      Expr::Fn(func) => {
        *expr = self.wrap_function(&mut func.function, func.ident.take());
      }
      _ => {}
    }
  }
}
impl WrapClosure {
  fn wrap_function(&mut self, func: &mut Function, ident: Option<Ident>) -> Expr {
    self.stack.push(Hoist::Function);

    func
      .params
      .iter_mut()
      .for_each(|param| self.visit_param(&mut param.pat));

    let block = func.body.as_mut().unwrap();

    // hoist all of the function/var declarations into scope
    self.stack.bind_hoisted_stmts_in_block(&mut block.stmts);

    // process each of the children
    block.visit_mut_children_with(self);

    // discover which identifiers within the closure point to free variables
    let free_variables = discover_free_variables(ArrowOrFunction::Function(func), &self.stack);

    // replace the ArrowExpr with a call to global.wrapClosure to decorate
    // the closure with its free variables
    let call = Expr::Call(wrap_closure_call(
      Box::new(Expr::Fn(FnExpr {
        function: func.take(),
        ident,
      })),
      free_variables,
    ));

    self.stack.pop();

    call
  }

  fn wrap_arrow_expr(&mut self, arrow: &mut ArrowExpr) -> Expr {
    // push a new frame onto the stack for the contents of this function
    self.stack.push(Hoist::Function);

    arrow
      .params
      .iter_mut()
      .for_each(|param| self.visit_param(param));

    let body = &mut arrow.body;
    if body.is_expr() {
      let expr = body.as_mut_expr().unwrap();

      expr.visit_mut_with(self);
    } else {
      let block = body.as_mut_block_stmt().unwrap();

      // hoist all of the function/var declarations into scope
      self.stack.bind_hoisted_stmts_in_block(&mut block.stmts);

      // process each of the children
      block.visit_mut_children_with(self);
    }

    let free_variables =
      discover_free_variables(ArrowOrFunction::ArrowFunction(arrow), &self.stack);

    // replace the ArrowExpr with a call to wrapClosure, wrapping the ArrowExpr with metadata
    let call = Expr::Call(wrap_closure_call(
      Box::new(Expr::Arrow(arrow.take())),
      free_variables,
    ));

    self.stack.pop();

    call
  }

  fn visit_param(&mut self, param: &mut Pat) {
    // bind this argument into lexical scope

    self.stack.bind_pat(param, Hoist::Block);
    match param {
      Pat::Assign(assign) => {
        // this is a parameter with a default value
        // e.g (a, b = a)
        // or  (a, b = () => [a, b])

        // we must transform the initializer with the arguments to its left in scope
        assign.right.as_mut().visit_mut_children_with(self);
      }
      _ => {}
    }
  }
}

/**
 * global.wrapClosure((...args) => { ..stmts }, () => ({ ...metadata }))
 */
fn wrap_closure_call(expr: Box<Expr>, free_variables: Vec<FreeVariable>) -> CallExpr {
  // global.wrapClosure((...args) => { ..stmts }, () => ({ ...metadata }))
  CallExpr {
    span: DUMMY_SP,
    callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
      obj: Box::new(Expr::Ident(quote_ident!("global"))),
      prop: MemberProp::Ident(quote_ident!("wrapClosure")),
      span: DUMMY_SP,
    }))),
    args: vec![
      ExprOrSpread { expr, spread: None },
      ExprOrSpread {
        expr: Box::new(Expr::Arrow(ArrowExpr {
          is_async: false,
          is_generator: false,
          type_params: None,
          span: DUMMY_SP,
          body: BlockStmtOrExpr::Expr(Box::new(Expr::Object(ObjectLit {
            span: DUMMY_SP,
            props: vec![
              create_short_hand_prop("__filename"),
              create_prop(
                "free",
                create_array(free_variables.iter().map(|v| {
                  create_object_lit(vec![create_prop(
                    "name",
                    Expr::Ident(quote_ident!(*v.name)),
                  )])
                })),
              ),
            ],
          }))),
          params: vec![],
          return_type: None,
        })),
        spread: None,
      },
    ], // TODO: inject metadata about free variables
    type_args: None,
  }
}

fn create_object_lit(props: Vec<PropOrSpread>) -> Expr {
  Expr::Object(ObjectLit {
    span: DUMMY_SP,
    props: props,
  })
}

fn create_short_hand_prop(expr: &str) -> PropOrSpread {
  PropOrSpread::Prop(Box::new(Prop::Shorthand(quote_ident!(expr))))
}

fn create_prop(key: &str, value: Expr) -> PropOrSpread {
  PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
    key: PropName::Ident(quote_ident!(key)),
    value: Box::new(value),
  })))
}

fn create_array<I>(items: I) -> Expr
where
  I: Iterator<Item = Expr>,
{
  Expr::Array(ArrayLit {
    span: DUMMY_SP,
    elems: items
      .map(|v| {
        Some(ExprOrSpread {
          expr: Box::new(v),
          spread: None,
        })
      })
      .collect(),
  })
}

// fn create_object_lit(key: &str, value: Expr) -> ObjectLit {
//   ObjectLit {
//     span: DUMMY_SP,
//     props: vec![PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
//       key: PropName::Ident(quote_ident!(key)),
//       value: Box::new(value),
//     })))],
//   }
// }
