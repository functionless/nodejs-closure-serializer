var v1 = { internal: "value" };
const f1 = (_self => function foo() {
    return ((val) => `${val} ${this.internal}`)("hello");
}.bind(_self))(v1);
exports.handler = f1