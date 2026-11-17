import { h } from "preact";
import type { Component } from "../../../src/contracts/index.ts";

// Exercise component resolution and props without depending on a theme's presentation.
const component: Component = ({ html, props }) =>
  h("section", { "data-props": JSON.stringify(props), dangerouslySetInnerHTML: { __html: html } });

export default component;
