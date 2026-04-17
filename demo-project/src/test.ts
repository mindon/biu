// test.ts
export const greeting = "test";
console.log("test loaded");

import { demo } from "./demo.ts#nothing";
console.log(demo);
