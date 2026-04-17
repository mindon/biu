import {
  css,
  html,
} from "https://cdn.jsdelivr.net/gh/lit/dist@3/core/lit-core.min.js";

const hello = "world";

export const world = css`
  a {
    color: red;
  }
  b {
    color: #00f;
  }
`;

export const demo = html`
  <div>
    ${hello}
    <b>world</b>
  </div>
`;
