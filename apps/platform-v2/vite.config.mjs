import { resolve } from "node:path";

const root = resolve(process.cwd(), "apps/platform-v2");

export default {
  root,
  base: "/v2/",
  build: {
    outDir: resolve(process.cwd(), "apps/platform-v2-dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        equipment: resolve(root, "equipment/index.html"),
        kiosk: resolve(root, "kiosk/index.html"),
      },
    },
  },
};
