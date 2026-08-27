import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const luffyPlugin = {
  rules: {
    "iframe-safe-cookies": {
      meta: {
        type: "problem",
        messages: {
          unsafe:
            "跨源 iframe 里浏览器会拦掉默认 sameSite=lax 的 cookie, 登录状态会丢。" +
            '写会话 cookie 必须 import { IFRAME_SAFE_COOKIE_OPTS } from "@/lib/iframe-safe-cookie" ' +
            "并展开进 cookies.set 的选项, 或直接用 setSessionCookie helper。",
        },
      },
      create(ctx) {
        if (ctx.filename.includes("iframe-safe-cookie")) return {};
        const sourceCode = ctx.sourceCode;

        function isCookiesCallee(callee) {
          return (
            (callee?.type === "Identifier" && callee.name === "cookies") ||
            (callee?.type === "MemberExpression" &&
              callee.property?.name === "cookies")
          );
        }
        /** cookies() / await cookies() */
        function isCookiesExpr(node) {
          if (!node) return false;
          if (node.type === "CallExpression" && isCookiesCallee(node.callee))
            return true;
          if (
            node.type === "AwaitExpression" &&
            node.argument?.type === "CallExpression" &&
            isCookiesCallee(node.argument.callee)
          )
            return true;
          return false;
        }
        /** Identifier 是否绑定自 cookies()（按 ESLint scope/variable，非文件级名字串） */
        function isCookiesBinding(idNode) {
          if (idNode?.type !== "Identifier") return false;
          let scope = sourceCode.getScope(idNode);
          while (scope) {
            const variable = scope.set.get(idNode.name);
            if (variable) {
              return variable.defs.some((def) => {
                if (def.type !== "Variable" || !def.node?.init) return false;
                return isCookiesExpr(def.node.init);
              });
            }
            scope = scope.upper;
          }
          return false;
        }
        function isCookieReceiver(obj) {
          if (!obj) return false;
          // (await cookies()).set / cookies().set
          if (isCookiesExpr(obj)) return true;
          // res.cookies.set / response.cookies.set
          if (
            obj.type === "MemberExpression" &&
            obj.property?.name === "cookies"
          )
            return true;
          // const store = await cookies(); store.set(...)
          if (obj.type === "Identifier") return isCookiesBinding(obj);
          return false;
        }
        function hasSafeOpts(optsArg) {
          return (
            optsArg?.type === "ObjectExpression" &&
            optsArg.properties.some(
              (p) =>
                p.type === "SpreadElement" &&
                p.argument?.name === "IFRAME_SAFE_COOKIE_OPTS",
            )
          );
        }
        return {
          CallExpression(node) {
            const c = node.callee;
            if (c?.type !== "MemberExpression" || c.property?.name !== "set")
              return;
            if (!isCookieReceiver(c.object)) return;
            if (!hasSafeOpts(node.arguments[2])) {
              ctx.report({ node, messageId: "unsafe" });
            }
          },
        };
      },
    },
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "佳旺仓库系统/**",
    "scripts/**/*.cjs",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    plugins: { luffy: luffyPlugin },
    rules: {
      "luffy/iframe-safe-cookies": "error",
      // React 19's compiler advisory rejects established data-loading effects;
      // these flows are covered by runtime tests and are not compiler errors.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
  // 业务代码禁止 import 仅 devDependencies 的包 (如 sharp); 配置/脚本本身吃 eslint 等 dev 依赖, 不套此规则.
  // no-unresolved 补齐 pnpm 下「未安装包 resolve 失败则 no-extraneous 静默跳过」的空洞.
  {
    files: ["app/**/*.{js,jsx,ts,tsx}", "lib/**/*.{js,jsx,ts,tsx}"],
    rules: {
      "import/no-extraneous-dependencies": ["error", { devDependencies: false }],
      "import/no-unresolved": "error",
    },
  },
]);

export default eslintConfig;
