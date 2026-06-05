import type { Hello } from "./world2.ts";
function hello(name: string): Hello {
  return `hello ${name}` as unknown as Hello;
}

hello("inline");

const base = () => "/cool/";
const myWorker = new Worker(base + "./world2.ts");
myWorker.onmessage = (e) => {
  console.log("Message received from world2");
};
