"use strict";
// Copyright 2016-2018, Pulumi Corporation.  All rights reserved.

const cases = [];
{
    const zeroBigInt = 0n;
    const smallBigInt = 1n;
    const negativeBigInt = -1n;
    const largeBigInt = 11111111111111111111111111111111111111111n;
    const negativeLargeBigInt = -11111111111111111111111111111111111111111n;

    cases.push({
        title: "Captures bigint",
        // eslint-disable-next-line
        func: function () {
          return zeroBigInt + smallBigInt + negativeBigInt + largeBigInt + negativeBigInt + negativeLargeBigInt;
        },
        expectResult: zeroBigInt + smallBigInt + negativeBigInt + largeBigInt + negativeBigInt + negativeLargeBigInt,
        snapshot: true
    });
}

module.exports.cases = cases;
