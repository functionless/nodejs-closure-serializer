use std::collections::{HashMap};
use swc_common::{chain, Mark};
use swc_common::util::take::Take;
use swc_ecma_visit::Fold;
use swc_plugin::{ast::*, plugin_transform, TransformPluginProgramMetadata, utils::*};

#[plugin_transform]
pub fn wrap_closures(mut program: Program, _metadata: TransformPluginProgramMetadata) -> Program {
    program.visit_mut_with(&mut ClosureSerializer {
        stack: LexicalScope::new()
    });

    program
}

pub fn wrap(top_level_mark: Mark) -> impl Fold + VisitMut {
    as_folder(ClosureSerializer {
        stack: LexicalScope::new()
    })
}

pub struct ClosureSerializer {
    /**
     * The [lexical scope](LexicalScope) of the program at the current point of the AST.
     */
    stack: LexicalScope
}

impl ClosureSerializer {
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
    fn bind_hoisted_stmts_in_block<T>(&mut self, block: &mut Vec<T>)
    where
        T: StmtLike + VisitMutWith<Self>,
    {
        block.into_iter().for_each(|stmt| {
            // hoist all of the function and var declarations in the module into scope
            match stmt.as_stmt() {
                Some(stmt) => {
                    match stmt {
                        Stmt::Decl(Decl::Var(var)) => {
                            if var.kind == VarDeclKind::Var {
                                for decl in var.decls.iter() {
                                    if decl.init.is_none() {
                                        // var declarations with no initialized are always hoisted
                                        self.stack.bind_pat(&decl.name);
                                    }
                                }
                            }
                        }
                        Stmt::Decl(Decl::Fn(func)) => {
                            self.stack.bind_ident(&func.ident);
                        }
                        _ => {}
                    }
                    // self.scope.hoist_stmt(&stmt);
                },
                _ => {}
            }
        });
    }
}

impl VisitMut for ClosureSerializer {
    // Implement necessary visit_mut_* methods for actual custom transform.
    // A comprehensive list of possible visitor methods can be found here:
    // https://rustdoc.swc.rs/swc_ecma_visit/trait.VisitMut.html

    fn visit_mut_module_items(&mut self, items: &mut Vec<ModuleItem>) {
        self.bind_hoisted_stmts_in_block(items);
        items.iter_mut().for_each(|stmt| stmt.visit_mut_with(self));
    }

    fn visit_mut_block_stmt(&mut self, block: &mut BlockStmt) {
        // we are entering a block, so push a frame onto the stack
        self.stack.push();

        self.bind_hoisted_stmts_in_block(&mut block.stmts);

        // now that all hoisted variables are in scope, walk each of the children
        block.visit_mut_children_with(self);

        // finally, pop the stack frame
        self.stack.pop();
    }

    fn visit_mut_var_decl(&mut self, var: &mut VarDecl) {
        for decl in var.decls.iter_mut() {
            match decl.init.as_deref_mut() {
                Some(init) => {
                    // var x = v;
                    // let x = b;
                    // const x = v;

                    // bind the names to the current lexical scope
                    self.stack.bind_pat(&decl.name);

                    // then visit the initializer with the updated lexical scope
                    init.visit_mut_with(self);
                }
                None if var.kind == VarDeclKind::Var => {
                    // hoisted var - we should ignore as it has already been hoisted at the beginning of the block
                    // var x;
                }
                None => {
                    // let x;

                    // bind the names to the current lexical scope
                    self.stack.bind_pat(&decl.name);
                }
            }
        }
    }

    fn visit_mut_expr(&mut self, expr: &mut Expr) {
        match expr {
            Expr::Arrow(arrow) => {
                // push a new frame onto the stack for the contents of this function
                self.stack.push();

                arrow.params.iter_mut().for_each(|param| {
                    // bind this argument into lexical scope

                    self.stack.bind_pat(param);
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
                });


                if arrow.body.is_expr() {
                  let expr = arrow.body.as_mut_expr().unwrap();

                  expr.visit_mut_with(self);
                } else {
                  let block = arrow.body.as_mut_block_stmt().unwrap();

                  // hoist all of the function/var declarations into scope
                  self.bind_hoisted_stmts_in_block(&mut block.stmts);

                  // process each of the children
                  block.visit_mut_children_with(self);
                }

                // global.wrapClosure((...args) => { ..stmts })
                let call = CallExpr {
                    span: arrow.span,
                    callee: Callee::Expr(Box::new(
                        Expr::Member(MemberExpr {
                            obj: Box::new(Expr::Ident(private_ident!(arrow.span, "global"))),
                            prop: MemberProp::Ident(private_ident!(arrow.span, "wrapClosure")),
                            span: arrow.span
                        })
                    )),
                    args: vec!(ExprOrSpread {
                        expr: Box::new(Expr::Arrow(arrow.take())),
                        spread: None
                    }), // TODO: inject metadata about free variables
                    type_args: None
                };

                // replace the ArrowExpr with a call to wrapClosure, wrapping the ArrowExpr with metadata
                *expr = Expr::Call(call);

                self.stack.pop();
            },
            Expr::Fn(function) => {

            }
            _ => {}
        }
    }
}

/**
 * A mapping of [reference name](JsWord) to the [unique id](u32) of that reference.
 */
type Frame = HashMap<JsWord, u32>;

struct LexicalScope {
    /**
     * Counter for assigning unique identifiers.
     */
    count: u32,
    /**
     * Mapping of a [reference](Id) to its assigned unique id.
     */
    ids: HashMap<Id, u32>,
    /**
     * A list of [stack frames](Frame) for the program at the current point in the tree.
     */
    stack: Vec<Frame>
}

impl LexicalScope {
    pub fn new() -> Self {
        LexicalScope { 
            count: 0,
            ids: HashMap::new(),
            stack: vec!(Frame::new())
        }
    }

    /**
     * Walk backwards through the Scope chain to find the variable id.
     */
    fn lookup(&self, name: &JsWord) -> Option<u32> {
        for scope in self.stack.iter() {
            let val = scope.get(name);
            if val.is_some() {
                return val.cloned();
            }
        }
        Option::None
    }

    fn frame(&mut self) -> &mut Frame {
        self.stack.last_mut().unwrap()
    }

    /**
     * Push a Scope onto the Stack.
     */
    fn push(&mut self) -> &mut Frame {
        self.stack.push(HashMap::new());
        self.stack.last_mut().unwrap()
    }

    fn pop(&mut self) {
        if self.stack.pop().is_none() {
            panic!("stack underflow");
        }
    }

    /**
     * Binds the name of an [ident](Ident) to the current [lexical scope](LexicalScope).
     */
    fn bind_ident(&mut self, ident: &Ident) {
        let id = self.get_unique_id(&ident);
        self.frame().insert(ident.to_id().0, id);
    }

    /**
     * Get (or assign) a [unique id](u32) for an [identifier](Ident).
     * 
     * The ID will be used to uniquely identify a variable (regardless of name shadowing/collisions).
     */
    fn get_unique_id(&mut self, ident: &Ident) -> u32 {
        let id = ident.to_id();
        if !self.ids.contains_key(&id) {
            self.count += 1;
            self.ids.insert(id, self.count);
        }
        *self.ids.get(&ident.to_id()).unwrap()
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
    fn bind_pat(&mut self, pat: &Pat) {
        match pat {
            Pat::Ident(ident) => {
                self.bind_ident(&ident.id);
            },
            Pat::Object(o) => {
                for prop in o.props.iter() {
                    match prop {
                        ObjectPatProp::Assign(a) => {
                            self.bind_ident(&a.key);
                        }
                        ObjectPatProp::KeyValue(kv) => {
                            self.bind_pat(kv.value.as_ref());
                        }
                        _ => {}
                    }
                };
            },
            Pat::Array(a) => {
                for element in a.elems.iter() {
                    if element.is_some() {
                        self.bind_pat(element.as_ref().unwrap());
                    }
                }
            }
            _ => {}
        }
    }
}
