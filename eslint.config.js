import { globalIgnores } from "eslint/config";
import baseConfig from "./eslint.config.mjs";

const config = [globalIgnores([".luffy/**"]), ...baseConfig];
export default config;
