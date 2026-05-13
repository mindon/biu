// test.ts
export const greeting = "test-NEW";
console.log("test loaded NEW");

import { demo } from "./demo.ts#nothing";
console.log(demo);
