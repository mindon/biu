export const TIMESTAMP = 905800005;

const base = new URL(import.meta.url).pathname;
const myWorker = new Worker(base + "../worker.ts");
myWorker.onmessage = (e) => {
  console.log("Message received from worker");
};
