// Copyright 2016-2018, Pulumi Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/* eslint-disable */

// Make sure we are listening for v8 events as they're necessary to get things like file locations
// for serialization errors.  We need to do this first, before we even get around to running tests.
import * as v8Hooks from "../src/closure/v8Hooks";
import { describe, test, beforeAll, jest, expect } from "@jest/globals";

jest.setTimeout(10000);

// only start running these tests once we've initialized the code in v8Hooks.
describe("after hooks", () => {
    let done = false;
    beforeAll(async  () => {
        await v8Hooks.isInitializedAsync();
        done = true;
    });

    require("./tsClosureCases");

    test("invoke", () => {
        expect(done).toBeTruthy();
    })
});