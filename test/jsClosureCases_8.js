"use strict";
// Copyright 2016-2018, Pulumi Corporation.  All rights reserved.

const cases = [];
cases.push({
    title: "Async anonymous function closure (js)",
    // eslint-disable-next-line
    func: async function (a) { await a; },
    snapshot: true
});

cases.push({
    title: "Async anonymous function closure - extra space (js)",
    // eslint-disable-next-line
    func: async  function (a) { await a; },
    snapshot: true
});

cases.push({
    title: "Async named function closure (js)",
    // eslint-disable-next-line
    func: async function foo(a) { await a; },
    snapshot: true,
});

cases.push({
    title: "Async arrow function closure (js)",
    // eslint-disable-next-line
    func: async (a) => { await a; },
    snapshot: true,
});

// cases.push({
//     title: "Function captures V8 intrinsic (js)",
//     func: () => { %AbortJS(0) },
//     error: `Error serializing function 'func': jsClosureCases_8.js(0,0)

// function 'func': jsClosureCases_8.js(0,0): which could not be serialized because
//   the function could not be parsed: (...)

// Function code:
//   () => { %AbortJS(0) }`
// });


module.exports.cases = cases;

