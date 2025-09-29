import { createRequire } from "module";
import { resolve } from "path";
import { register } from "ts-node";

register({
  transpileOnly: true,
  compilerOptions: {
    module: "ESNext",
    target: "ES2020",
  },
});

const require = createRequire(import.meta.url);
require(resolve("./src/server.ts"));
