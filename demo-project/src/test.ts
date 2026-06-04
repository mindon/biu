// test.ts
export const greeting = "test-NEW";
console.log("test loaded NEW");

import { demo } from "./demo.ts#nothing";
console.log(demo);

import * as tiny from "@levischuck/tiny-cbor";
console.log(tiny);

import warning from "tiny-warning";
console.log(warning);
