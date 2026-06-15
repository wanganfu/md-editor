import { marked } from "marked";
import { markedMathExtension } from "../src/markedMath.ts";

marked.use(markedMathExtension());
marked.setOptions({ breaks: true, gfm: true });

const cases = [
  ["standalone $$ line", "$$E=mc^2$$", true],
  ["inline $$ in text", "文字 $$E=mc^2$$ 文字", false],
  ["multiline $$", "$$\nE=mc^2\n$$", true],
  ["standalone \\[", "\\[F=ma\\]", true],
  ["inline \\[ in text", "见 \\[F=ma\\] 处", false],
  ["multiline \\[", "\\[\nF=ma\n\\]", true],
  ["inline $", "欧拉 $e^{i\\pi}+1=0$ 式", true],
  ["align block", "\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}", true],
  ["$$ with align", "$$\n\\begin{align}\nE &= mc^2\n\\end{align}\n$$", true],
];

for (const [name, md, expectMath] of cases) {
  const html = marked.parse(md);
  const hasKatex = html.includes("katex");
  const ok = hasKatex === expectMath;
  console.log(ok ? "OK" : "FAIL", name, hasKatex ? "rendered" : "not rendered");
}
