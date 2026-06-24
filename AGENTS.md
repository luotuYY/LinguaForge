# AGENTS.md

<INSTRUCTIONS>
用中文输出思考过程；
注意编写脚本、代码时中文的编码问题
</INSTRUCTIONS>

## 前端模块化要求

TxtLlmHub 前端已从全局变量模式迁移为 ES 模块架构：

- 所有 JS 文件位于 static/js/，通过 `main.js` 作为唯一入口点按依赖顺序导入。
- 每个模块通过 `export { ... }` 显式声明对外接口，通过 `import { ... } from './xxx.js'` 声明依赖。
- 现有依赖图（无循环依赖）：
  ```
  particles  utils
                ↑
             state
            ↑     ↑
          render  tag / dedup
            ↑
           api
            ↑
           app  →  main.js
  ```
- HTML `onclick` 属性通过各模块底部的 `window.xxx = xxx` 绑定保持向后兼容。
- **新增 JS 文件**：必须遵循此模块模式 —— 显式 `import`/`export`，严禁添加新的全局变量；如需 HTML onclick 访问，在模块底部添加 window 绑定。
- **修改现有模块**：新增函数必须加入 export 列表和 window 绑定；删除函数必须同步移除两处。
