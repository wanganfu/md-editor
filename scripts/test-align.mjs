import { createServer } from "vite";
import { marked } from "marked";
import { readFileSync } from "fs";

const server = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});
const { markedMathExtension } = await server.ssrLoadModule("/src/markedMath.ts");
await server.close();

const ext = markedMathExtension();
const userAlign = `\\begin{align}
f(x) &= x^2 + 2x + 1 \\\\
     &= (x+1)^2
\\end{align}`;

const pre = ext.hooks.preprocess(userAlign);
console.log("user formula preprocess:", pre.includes("XMDMATHBLOCK") ? "OK" : "FAIL");
if (!pre.includes("XMDMATHBLOCK")) console.log(pre);

const section = readFileSync(
  "C:/Users/zeroerr/Desktop/md-editor-全功能测试.md",
  "utf8"
);
const slice = section.slice(section.indexOf("### 5.5"), section.indexOf("## 六"));
const preSection = ext.hooks.preprocess(slice);
console.log("section 5.5 preprocess:", preSection.includes("XMDMATHBLOCK") ? "OK" : "FAIL");

marked.use(ext);
marked.setOptions({ breaks: true, gfm: true });
const html = marked.parse(userAlign);
console.log("parse katex:", html.includes("katex"));
console.log("raw begin:", html.includes("\\begin{align}"));
