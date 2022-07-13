use im::HashMap;
use swc_plugin::{ast::*, utils::StmtLike};

/**
 * A mapping of [reference name](JsWord) to the [unique id](u32) of that reference.
 */
type Names = HashMap<JsWord, u32>;

#[derive(Clone)]
pub struct Scope {
  /**
   * Variables visible at this point in the tree.
   */
  block: Names,
  /**
   * A Stack of variables including hoisted functions and variable declarations
   *
   * i.e. declarations captured by looking ahead in the tree.
   *
   * ```ts
   * let i = 0;
   * // local: [i]
   * // hoisted: [i, foo]
   * function foo() {
   *  let j = 0;
   *  // local: [i, foo, j]
   *  // hoisted: [i, foo, j, bar]
   *
   *  function bar() {}
   * }
   * ```
   */
  function: Names,
}

impl Scope {
  fn new() -> Scope {
    Scope {
      block: Names::new(),
      function: Names::new(),
    }
  }
}

type Stack = Vec<Scope>;

#[derive(Eq, PartialEq, Clone, Copy)]
pub enum Hoist {
  /**
   * Functions can see all of names in their parent scopes.
   */
  Function,
  /**
   * A Block can only see hoisted function declarations and variable declarations.
   */
  Block,
}

pub struct LexicalScope {
  stack: Stack,
}

impl LexicalScope {
  fn load_hoisted_lexical_scope(&mut self, stmts: &Vec<BlockStmt>) {}
}

impl LexicalScope {
  pub fn new() -> Self {
    LexicalScope {
      stack: vec![Scope::new()],
    }
  }

  pub fn lookup_local(&self, name: &JsWord) -> Option<u32> {
    self
      .stack
      .last()
      .and_then(|scope| scope.block.get(name).map(|u| *u))
  }

  pub fn lookup_hoisted(&self, name: &JsWord) -> Option<u32> {
    self
      .stack
      .last()
      .and_then(|frame| frame.function.get(name).map(|u| *u))
  }

  /**
   * Push a Scope onto the Stack.
   */
  pub fn push(&mut self, hoist: Hoist) {
    let scope = match self.stack.last() {
      Some(parent) => {
        // it is safe to re-use frame.function because HashMap is immutable
        let inherit = parent.block.clone().union(parent.function.clone());
        match hoist {
          Hoist::Function => Scope {
            // cloning is cheap O(1), so take advantage of it
            block: inherit.clone(),
            function: inherit.clone(),
          },
          Hoist::Block => Scope {
            function: inherit.clone(),
            block: parent.block.clone(),
          },
        }
      }
      None => Scope::new(),
    };
    self.stack.push(scope);
  }

  pub fn pop(&mut self) -> Scope {
    match self.stack.pop() {
      Some(popped) => popped,
      None => panic!("stack underflow"),
    }
  }

  pub fn get_names(&self, hoist: Hoist) -> &Names {
    match self.stack.last() {
      Some(popped) => match hoist {
        Hoist::Block => &popped.block,
        Hoist::Function => &popped.function,
      },
      None => panic!("stack underflow"),
    }
  }

  pub fn get_names_mut(&mut self, hoist: Hoist) -> &mut Names {
    match self.stack.last_mut() {
      Some(popped) => match hoist {
        Hoist::Block => &mut popped.block,
        Hoist::Function => &mut popped.function,
      },
      None => panic!("stack underflow"),
    }
  }

  /**
   * Binds the name of an [ident](Ident) to the current [lexical scope](LexicalScope).
   */
  pub fn bind_ident(&mut self, ident: &Ident, hoist: Hoist) {
    let id = self.get_unique_id(&ident);

    if hoist == Hoist::Function {
      let block = self.get_names_mut(Hoist::Block);
      *block = block.update(ident.sym.clone(), id);
    }
    let names = self.get_names_mut(hoist);
    *names = names.update(ident.sym.clone(), id);
  }

  /**
   * Get (or assign) a [unique id](u32) for an [identifier](Ident).
   *
   * The ID will be used to uniquely identify a variable (regardless of name shadowing/collisions).
   */
  pub fn get_unique_id(&mut self, ident: &Ident) -> u32 {
    ident.to_id().1.to_owned().as_u32()
  }

  /**
   * Binds the names produced by a [binding pattern](Pat) to the current [lexical scope](LexicalScope).
   *
   * ```ts
   * // patterns:
   * a
   * {b}
   * {d: c}
   * [d];
   * ```
   */
  pub fn bind_pat(&mut self, pat: &Pat, hoist: Hoist) {
    match pat {
      // (a, b) => {}
      Pat::Ident(ident) => {
        self.bind_ident(&ident.id, hoist);
      }
      // ({a, b: c}) => {}
      Pat::Object(o) => {
        for prop in o.props.iter() {
          match prop {
            ObjectPatProp::Assign(a) => {
              self.bind_ident(&a.key, hoist);
            }
            ObjectPatProp::KeyValue(kv) => {
              self.bind_pat(kv.value.as_ref(), hoist);
            }
            _ => {}
          }
        }
      }
      // ([a, b]) => {}
      Pat::Array(a) => {
        for element in a.elems.iter() {
          if element.is_some() {
            self.bind_pat(element.as_ref().unwrap(), hoist);
          }
        }
      }
      // (a = value) => {}
      Pat::Assign(assign) => {
        // bind the variable onto the scope
        self.bind_pat(assign.left.as_ref(), hoist);
      }
      _ => {}
    }
  }

  pub fn bind_var_decl(&mut self, var: &VarDecl) {
    var
      .decls
      .iter()
      .for_each(|decl| self.bind_var_declarator(var.kind, decl));
  }

  /**
   * Bind names produced by a [VarDeclarator](VarDeclarator)
   */
  pub fn bind_var_declarator(&mut self, kind: VarDeclKind, decl: &VarDeclarator) {
    match decl.init.as_deref() {
      None if kind == VarDeclKind::Var => {
        // hoisted var - we should ignore as it has already been hoisted at the beginning of the block
        // var x;
        self.bind_pat(&decl.name, Hoist::Function);
      }
      Some(_) => {
        // var x = v;
        // let x = b;
        // const x = v;

        // bind the names to the current lexical scope
        self.bind_pat(&decl.name, Hoist::Block);
      }
      None => {
        // let x;

        // bind the names to the current lexical scope
        self.bind_pat(&decl.name, Hoist::Block);
      }
    }
  }

  pub fn bind_function_params(&mut self, params: &Vec<Pat>) {
    params
      .iter()
      .for_each(|param| self.bind_pat(param, Hoist::Block));
  }

  /**
   * Generic function that will walk all statements in a block and hoist
   * all function declarations and any var declarations that can be hoisted.
   *
   * Stores the names produced by a [stmt](Stmt):
   * 1. function declarations
   * ```ts
   * function foo() {}
   * ```
   * 2. var declarations that have no initializer
   * ```ts
   * var foo;
   * ```
   */
  pub fn bind_hoisted_stmts_in_block<T>(&mut self, block: &[T])
  where
    T: StmtLike,
  {
    block.iter().for_each(|stmt| {
      // hoist all of the function and var declarations in the module into scope
      match stmt.as_stmt() {
        Some(stmt) => {
          match stmt {
            Stmt::Decl(Decl::Var(var)) if var.kind == VarDeclKind::Var => {
              var.decls.iter().for_each(|decl| {
                if decl.init.is_none() {
                  self.bind_var_declarator(VarDeclKind::Var, decl);
                }
              });
            }
            Stmt::Decl(Decl::Fn(func)) => {
              self.bind_ident(&func.ident, Hoist::Function);
            }
            _ => {}
          }
          // self.scope.hoist_stmt(&stmt);
        }
        _ => {}
      }
    });
  }
}
