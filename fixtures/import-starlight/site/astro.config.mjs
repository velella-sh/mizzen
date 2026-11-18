import starlight from "@astrojs/starlight";

export default {
  integrations: [starlight({ title: "Starlight site" })],
  srcDir: "./src",
};
