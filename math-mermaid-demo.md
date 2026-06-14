# LaTeX 公式与 Mermaid 图表演示

> 用于测试 MD Editor 的数学公式与图表渲染能力。

---

## 一、行内公式

欧拉公式 $e^{i\pi} + 1 = 0$ 被誉为数学中最美的等式。

勾股定理可写为 \(a^2 + b^2 = c^2\)，其中 \(c\) 为斜边。

矩阵乘法：$\mathbf{C} = \mathbf{A}\mathbf{B}$，其中 $\mathbf{A} \in \mathbb{R}^{m \times n}$。

---

## 二、陈列公式（独立成行）

### 2.1 积分与求和

$$
\int_{-\infty}^{\infty} e^{-x^2}\, dx = \sqrt{\pi}
$$

$$
\sum_{k=1}^{n} k^2 = \frac{n(n+1)(2n+1)}{6}
$$

### 2.2 方程组（align 环境）

\begin{align}
\nabla \times \mathbf{E} &= -\frac{\partial \mathbf{B}}{\partial t} \\
\nabla \times \mathbf{B} &= \mu_0 \mathbf{J} + \mu_0 \varepsilon_0 \frac{\partial \mathbf{E}}{\partial t} \\
\nabla \cdot \mathbf{E} &= \frac{\rho}{\varepsilon_0} \\
\nabla \cdot \mathbf{B} &= 0
\end{align}

### 2.3 带编号的方程（equation + split）

\begin{equation}
\begin{split}
\mathcal{L} &= \frac{1}{2}(\partial_\mu \phi)(\partial^\mu \phi) - \frac{1}{2}m^2 \phi^2 - \frac{\lambda}{4!}\phi^4 \\
&= \int d^4x \left[ \frac{1}{2}(\partial_\mu \phi)^2 - V(\phi) \right]
\end{split}
\end{equation}

### 2.4 矩阵与行列式

> 矩阵换行请使用 `\\`（两个反斜杠），列之间用 `&` 分隔。

$$
\det(\mathbf{A}) = \sum_{\sigma \in S_n} \mathrm{sgn}(\sigma) \prod_{i=1}^{n} a_{i,\sigma(i)}
$$

$$
\begin{pmatrix}
\cos\theta & -\sin\theta & 0 \\
\sin\theta & \cos\theta & 0 \\
0 & 0 & 1
\end{pmatrix}
\begin{pmatrix} x \\ y \\ 1 \end{pmatrix}
=
\begin{pmatrix}
x\cos\theta - y\sin\theta \\
x\sin\theta + y\cos\theta \\
1
\end{pmatrix}
$$

$$
\begin{vmatrix}
a & b \\
c & d
\end{vmatrix} = ad - bc
$$

### 2.5 分段函数（cases）

$$
f(x) = \begin{cases}
x^2 & \text{if } x \geq 0 \\
-x & \text{if } x < 0
\end{cases}
$$

### 2.6 极限与导数

$$
\lim_{n \to \infty} \left(1 + \frac{1}{n}\right)^n = e
$$

$$
\frac{\partial^2 u}{\partial t^2} = c^2 \nabla^2 u
$$

### 2.7 使用 \[ \] 分隔符

\[
\hat{H}\lvert \psi \rangle = E \lvert \psi \rangle, \quad
\langle \psi \vert \psi \rangle = 1
\]

---

## 三、Mermaid 图表

### 3.1 流程图（Flowchart）

```mermaid
flowchart TD
    A([开始]) --> B{是否登录?}
    B -->|是| C[加载用户数据]
    B -->|否| D[跳转登录页]
    D --> E[验证凭证]
    E -->|成功| C
    E -->|失败| F[显示错误]
    F --> D
    C --> G[渲染编辑器]
    G --> H([结束])
```

### 3.2 时序图（Sequence Diagram）

```mermaid
sequenceDiagram
    participant U as 用户
    participant E as 编辑器
    participant M as Marked
    participant K as KaTeX

    U->>E: 输入 Markdown
    E->>M: 触发预览更新
    M->>K: 渲染 LaTeX 公式
    K-->>M: 返回 HTML
    M-->>E: 生成预览 HTML
    E-->>U: 显示渲染结果
```

### 3.3 类图（Class Diagram）

```mermaid
classDiagram
    class Document {
        +String content
        +String filePath
        +Boolean isModified
        +save()
        +open()
    }
    class Preview {
        +render()
        +updateTheme()
    }
    class MathRenderer {
        +renderInline()
        +renderDisplay()
    }
    Document --> Preview : 触发更新
    Preview --> MathRenderer : 解析公式
```

### 3.4 状态图（State Diagram）

```mermaid
stateDiagram-v2
    [*] --> 编辑
    编辑 --> 预览 : 切换视图
    预览 --> 编辑 : 切换视图
    编辑 --> 分屏 : 分屏模式
    分屏 --> 编辑 : 仅编辑
    分屏 --> 预览 : 仅预览
    编辑 --> 已保存 : Ctrl+S
    已保存 --> 编辑 : 继续编辑
```

### 3.5 甘特图（Gantt Chart）

```mermaid
gantt
    title MD Editor 开发计划
    dateFormat  YYYY-MM-DD
    section 核心功能
    Markdown 编辑       :done,    a1, 2026-01-01, 30d
    实时预览            :done,    a2, after a1, 20d
    section 扩展
    LaTeX 公式支持      :done,    b1, 2026-03-01, 14d
    Mermaid 图表        :done,    b2, after b1, 10d
    section 发布
    打包与测试          :active,  c1, 2026-04-01, 21d
```

### 3.6 饼图（Pie Chart）

```mermaid
pie showData
    title 编辑器功能使用占比
    "Markdown 编辑" : 45
    "实时预览" : 30
    "文件管理" : 15
    "主题切换" : 10
```

### 3.7 思维导图（Mindmap）

```mermaid
mindmap
  root((MD Editor))
    编辑
      工具栏
      快捷键
      分屏
    渲染
      GFM
      KaTeX
      Mermaid
    文件
      打开/保存
      文件夹浏览
      历史记录
```

---

## 四、混合示例

下面同时包含公式与文字说明：

薛定谔方程

\begin{equation}
i\hbar \frac{\partial}{\partial t}\Psi(\mathbf{r}, t)
= \left[ -\frac{\hbar^2}{2m}\nabla^2 + V(\mathbf{r}, t) \right] \Psi(\mathbf{r}, t)
\end{equation}

数据处理流程如下：

```mermaid
flowchart LR
    A[原始 Markdown] --> B[预处理数学区域]
    B --> C[Marked 解析]
    C --> D[KaTeX 渲染]
    C --> E[Mermaid 渲染]
    D --> F[预览 HTML]
    E --> F
```

贝叶斯定理：

$$
P(A \mid B) = \frac{P(B \mid A)\, P(A)}{P(B)}
$$

---

*文档生成于 MD Editor 测试 — 可在编辑器中打开此文件验证渲染效果。*
