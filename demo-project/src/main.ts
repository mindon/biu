// main.ts
import { greeting } from "./test.ts?query";
console.log(greeting);

import { TIMESTAMP } from "./hey/world.ts";
console.log(TIMESTAMP);

import { faker } from "@faker-js/faker@v7.1.0";
console.log(faker);

import "./hey/auto-inline";

const myWorker = new Worker("/worker.ts");
myWorker.onmessage = (e) => {
  console.log("Message received from worker", e.data);
};

import "/simple.js";

// import "./not-exists.ts";
// import "/not-exists.js";
