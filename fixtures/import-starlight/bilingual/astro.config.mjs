import starlight from "@astrojs/starlight";

export default {
  base: "/beacon",
  i18n: { defaultLocale: "en", locales: ["en", "fa"] },
  integrations: [starlight({ title: "Beacon", sidebar: [{ label: "Guides", autogenerate: { directory: "guide" } }] })],
  srcDir: "./src",
};
