# Skills Policy

For this project, create and update Codex skills only under:

```text
D:\Wuxia_Web\.agents\skills\<skill-name>\SKILL.md
```

Do not create project-specific skills under the global Codex skills directory.

Use project-level skills for:

- Animation framework notes
- FBX/GLB pipeline knowledge
- Root Motion and In-Place movement conventions
- Combat system architecture
- Asset workflow conventions
- Debugging procedures

When creating a new project skill, use lowercase hyphen-case names and include any detailed notes under that skill's `references` directory.

Use relevant project skills once at the start of a new conversation or after a context reset when the task touches that skill's area. Do not re-invoke the same skill for every message in an already-oriented conversation.

For important handoffs, explicitly invoke the skill in the first prompt, for example:

```text
Use $wuxia-web3d-animation and read the project-level skill before working on D:\Wuxia_Web.
```

Do not rely only on automatic trigger-based loading for vague prompts such as "continue" or "fix this".
