# 编辑与预览现状

```mermaid
flowchart TD
  L["加载动作／模型／招式文档<br/>vite.config.js:29"] --> M["选择招式和动作<br/>src/move-manager.js:126"]
  L --> A["选择动作与配置<br/>src/motion-editor.js:479"]
  L --> C["选择模型与碰撞体<br/>src/model-editor.js:398"]
  M --> MP["原始片段预览<br/>src/move-manager.js:245"]
  MP --> MT["判定窗口和绑定<br/>src/move-manager.js:203"]
  A --> AF["轨道过滤与 Root 处理<br/>src/motion-editor.js:500"]
  AF --> AP["Root 位移／姿态与时间轴<br/>src/motion-editor.js:522"]
  C --> CP["本地过滤、固定外层预览<br/>src/model-editor.js:458"]
  CP --> CB["碰撞几何编辑<br/>src/model-editor.js:588"]
  MT --> MS["保存招式文档<br/>src/move-manager.js:232"]
  AP --> AS["保存动作文档<br/>src/motion-editor.js:1214"]
  CB --> CS["保存模型文档<br/>src/model-editor.js:1500"]
  MS --> W["独立整文档写入<br/>vite.config.js:61"]
  AS --> W
  CS --> W
```

三个编辑器共用 Three.js 和 GLTFLoader，但预览语义不同：招式预览直接播放原片段；动作预览积分 Root Motion；模型预览固定外层，仅应用自己的轨道过滤。

循环和播放速度也不同：招式预览总循环且按 1 倍时间推进；模型预览读取保存的循环设置；动作预览有独立预览循环状态和目标速度换算。

副作用：草稿／脏标记、预览 mixer、碰撞网格，及三个不同配置文件的整文档保存。当前 API 只检查顶层对象形状，没有跨文件引用和版本检查。

依据：`src/move-manager.js:117–154,203–255`；`src/motion-editor.js:479–574,1196–1236,1359–1379,1531–1738`；`src/model-editor.js:398–549,1500–1521,1621–1707`；`vite.config.js:53–148`。

本图保留编辑工具的不同职责；不建议把交互界面与所有保存文件合为一个模块。
