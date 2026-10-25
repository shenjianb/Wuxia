# 战斗执行现状

```mermaid
flowchart TD
  P["组合输入松键<br/>src/main.js:2002"] --> Q["缓存与可打断检查<br/>src/main.js:1944"]
  N["NPC 决策与目标方向<br/>src/main.js:3027"] --> B["角色出招入口<br/>src/main.js:1565"]
  Q --> B
  B --> S["筛选与权重／缺省选择<br/>src/combat-move-manager.js:276"]
  S --> A["锁方向、播放动作<br/>src/main.js:1572"]
  S --> D["无动作逻辑攻击<br/>src/main.js:1989"]
  A --> H["窗口与碰撞检测<br/>src/main.js:1681"]
  H --> E["强度、击退、硬直<br/>src/main.js:1789"]
  E --> C["受击取消目标攻击<br/>src/main.js:1850"]
  A --> F["结束与恢复<br/>src/main.js:1618"]
  D --> F
  Q --> X["主动中断／替换<br/>src/main.js:1638"]
  X --> B
```

玩家输入与 NPC 的目标计算是合理差异。两者共用角色出招入口，但动作完成、命中调用、冷却和返回值处理分别维护。

副作用：动画播放与混合、角色位置／朝向、攻击缓存和命中记录变化。无动作逻辑攻击没有命中效果；NPC 自身冷却仍应归 AI 调度。

依据：`src/main.js:1536–1665,1681–1911,1944–2093,3027–3098,3363–3415`；`src/combat-controls.js:1–61`；`src/combat-move-manager.js:246–283`。

静态核对，不代替逐动画、逐碰撞的运行时验证。
