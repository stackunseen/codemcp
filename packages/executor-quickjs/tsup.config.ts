import { packageConfig } from "../../tsup.base.js";

export default packageConfig(["src/index.ts", "src/worker.ts"], ["src/index.ts"]);
