# Wuxia Web3D 项目入口

## 用途与读取顺序

本文件提供稳定的项目工作约定；近期事实集中在 [PROJECT_STATUS.md](PROJECT_STATUS.md)，具体领域知识保留在项目本地 skills。

- 新任务或上下文恢复时，先读 `PROJECT_STATUS.md` 和 `.agents/SKILLS_POLICY.md`，建立本次任务所需的项目概览。
- 涉及动画、移动、战斗、碰撞、NPC 或相关编辑器时，读取 `.agents/skills/wuxia-web3d-animation/SKILL.md` 及其 `references/current-animation-framework.md`。这是现有的综合领域入口，无需另建重复的“总 skill”。
- 其他 skills 按任务需要选用；不要为了了解项目而加载全部技能或翻阅全部历史。
- 同一段连续讨论中复用已读资料；用户要求最新进展、摘要版本变化或任务涉及尚未核对的实现时，再定向刷新。

## 事实与讨论的边界

- 状态摘要是有版本的工作概览，不是实时同步，也不是代码的替代品。将已核实事实、设计设想和未知事项分开表达。
- 仅做方案讨论、评估或分析时，按用户的讨论范围回答，不把讨论中的方案自动落实为功能修改。
- 用户要求具体实现时，以当前代码和配置核对相关部分，再执行其授权范围内的修改；无需重新确认已明确授权的常规工作。
- 不假设能够读取其他对话的完整记录，也不假设不同任务使用同一份工作目录。
- 摘要与当前代码不一致时，注明差异，以本次核实的实现为准，并在授权的文档维护范围内修正摘要。

## 实现与资料维护

- 保留现有 Vite、Three.js WebGPU 和独立编辑器结构；改动聚焦当前需求。
- 动画与战斗约定以项目本地动画 skill 为入口，不以同名全局 skill 的旧快照替代本地版本。
- 模型 GLB 与动画 GLB 分离；Root Motion 和代码移动保持清晰的控制归属，避免对同一动作叠加位移。
- 改动 Root 过滤、姿态锚定、位移提取或脚部锁定时，同步运行时与动作编辑器的语义。
- 招式优先通过招式管理数据配置；调整公共战斗逻辑时同时检查玩家与 NPC 路径。
- 项目 skills 的新增或更新遵循 `.agents/SKILLS_POLICY.md`，存放于 `.agents/skills/`。
- 保留其他任务已有的未提交改动。文档整理不顺带修改玩法、资源或编辑器配置。

## 验证

- `npm run dev`：本地开发；`npm run build`：JS、CSS 或配置修改后的构建检查。
- FBX 或资源转换流程改动：按现有流程运行 `npm run assets:glb`，然后 `npm run build`。
- 动画或战斗表现需要在相关编辑器和运行时验证；构建通过不代表手感或动作衔接已经验证。
- WebGPU 无头截图可能呈黑色，结合浏览器错误和 `window.__DEMO_READY`、`window.__DEMO_ERROR`、`window.__DEMO_STATE` 判断。
- 仅修改 Markdown 时检查内容、引用路径与差异，无需为此运行资源转换或构建。

## 阶段交接

- 完成一个已授权开发阶段时，由实际执行修改的任务同步维护 `PROJECT_STATUS.md` 中受影响的部分。
- 摘要保留：更新时间、核对的代码版本和未提交改动范围、当前能力、近期变更、待定方案、已知问题、实际验证结果及下一步。
- 明确区分“代码存在”“构建通过”“已在运行时验证”和“仅为设想”；未执行的检查写明未执行。
- 有持续价值的规则写入相关本地 skill；短期进展写入状态摘要，避免将本文件变成流水账。
- 未完成任务或无写权限时，在交接中说明已完成内容和未同步事项，不声称摘要已更新。

## 开发入口

- 运行时：`src/main.js`；动作编辑器：`src/motion-editor.js`。
- 招式：`src/combat-move-manager.js`、`src/move-manager.js`、`public/assets/combat/move_manager.json`。
- 碰撞：`src/combat-collision-utils.js`、`src/model-editor.js`、`public/assets/models/model_config.json`。
- NPC：`src/npc-ai-runtime.js`、`src/npc-editor.js`、`src/behavior-editor.js`。
- 资源流程：`tools/build_glb_assets.py`、`tools/merge_base_characters.py`；编辑器保存接口：`vite.config.js`。
