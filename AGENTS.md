# AGENTS.md

<INSTRUCTIONS>
用中文输出思考过程；
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

## PowerShell + Python 代码生成注意事项

- **禁止 PowerShell 内联 Python 处理中文/Unicode 文件**。python -c "..." 和 @'...'@ | python 在 PowerShell 中通过管道传递时使用 GBK 控制台编码，会损坏非 ASCII 字符。替代方案：
  - 用 [System.IO.File]::WriteAllText(path, , [System.Text.UTF8Encoding]::new(False)) 先把 Python 脚本写入磁盘，再 python script.py 执行。
  - 或用 $env:PYTHONIOENCODING='utf-8'; python -c "..."。
- **在 Python 中生成 JS 代码时避免普通字符串的转义损耗**。\' 在 Python 普通字符串（非 raw）中会变成 '（丢失反斜杠）。JS 中需要字面 \'（反斜杠+引号）的场景，用 chr(92) + chr(39) 拼接，或用 Python 原始字符串 '''...'''。
- **每次修改 JS 文件后立即运行 
ode --check file.js** 验证语法，避免累积多层错误。
- **pply_patch 工具有严格的 @@ 上下文格式要求**，不适合大段多行替换。复杂替换优先用 PowerShell [System.IO.File] 读写 + Python 字符串操作。
- **操作前后用 git checkout -- file 快速回退**。当脚本部分执行成功但写入失败时，文件可能处于半修改状态，直接回退比修复更高效。
- **tag.js 的 window 绑定机制**：该模块无 xport 语句，所有 59 个 unction tagXxx 均依赖文件尾的 window.tagXxx = tagXxx; 绑定。新增函数后必须同步更新绑定（可运行自动脚本）。getSubPool/saveSubPool/_refreshPool/_adminSave 等非 	ag* 前缀的函数不需要 window 绑定，因为它们只在模块内部通过闭包引用。