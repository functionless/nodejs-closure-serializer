exports.handler = __m;

var __boundThis_proto = {};
Object.defineProperty(__f0, "prototype", { value: __boundThis_proto });
Object.defineProperty(__boundThis_proto, "constructor", { configurable: true, writable: true, value: __f0 });
Object.defineProperty(__boundThis_proto, "m", { configurable: true, writable: true, value: __f1 });
Object.defineProperty(__boundThis_proto, "n", { configurable: true, writable: true, value: __f2 });
var __boundThis = Object.create(__boundThis_proto);
function __f0() {
  return (function() {
    return function /*constructor*/() { };
  }).apply(undefined, undefined).apply(this, arguments);
}function __f1() {
  return (function() {
    return function /*m*/() {
                return this.n();
            };
  }).apply(undefined, undefined).apply(this, arguments);
}function __f2() {
  return (function() {
    return function /*n*/() {
                return 0;
            };
  }).apply(undefined, undefined).apply(this, arguments);
}function __m() {
  return (function() {
    let __boundThis = __boundThis;
    let m = __m;

    return function /*m*/() {
                return this.n();
            };
  }).apply(__boundThis, undefined).apply(this, arguments);
}