import { packageConfig } from "../../tsup.base.js";

export default packageConfig(["src/index.ts", "src/cli.ts"], ["src/index.ts"]);
