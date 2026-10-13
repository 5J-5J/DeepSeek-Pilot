# DeepSeek Pilot · 场景样例 / Examples

[简体中文 README](../README.md) · [English README](../README.en.md)

以下使用虚构数据，可用于理解功能和准备本地演示，不是产品截图、真实账号记录或模型输出承诺。自动化验证应使用离线模拟与隔离浏览器的本地页面；不要为了演示脚本主动向真实账号发送消息。

These fictional examples explain the product and provide a script for local demos. They are not screenshots, account records or promises about model output. Automated verification should use offline fixtures and local pages in isolated browser profiles, without sending messages through a real account.

## 01 · 作品集从想法到上线 / From idea to portfolio launch

**目标 / Goal:** 用多个会话推进同一项目，减少重复交代背景。Work across several chats without repeatedly restating project context.

| 步骤 / Step | 操作 / Action | 检查点 / Checkpoint |
| --- | --- | --- |
| 1 | 创建「个人作品集」项目，目标为展示三个设计案例。Create a portfolio project whose goal is to present three design case studies. | 项目树显示新项目。The project appears in the tree. |
| 2 | 手动归入定位、内容结构两个会话。Manually assign positioning and content-structure chats. | 两个会话属于同一项目；不依赖自动归类。Both belong to the project without automatic classification. |
| 3 | 检查旧会话整理后的项目记忆；必要时人工维护。Inspect the processed project memories and edit them if needed. | 「首版静态页面」「三个案例」是示例目标，不保证模型逐字提取。Static v1 and three case studies are example facts, not guaranteed verbatim extraction. |
| 4 | 新建项目会话，首条发送前开启项目记忆。Start a new project chat with project memory enabled before its first message. | 在带入内容中核对目标与生效记忆。Inspect the goal and active memories included in the message. |

示例问题 / Example question:

> 按已经确定的范围，帮我列出上线前检查清单。不要新增功能。
>
> Make a pre-launch checklist for the agreed scope. Do not add features.

## 02 · 同一个人，不同项目 / One person, different projects

**目标 / Goal:** 保留长期偏好，同时区分项目约束。Keep lasting preferences while separating project-specific constraints.

| 范围 / Scope | 虚构记忆 / Fictional memory |
| --- | --- |
| 个人 / Personal | 用中文回答，结论优先。Respond in Chinese, conclusion first. |
| 项目 A：作品集 / Portfolio | 首版只做静态页面。Static pages only for v1. |
| 项目 B：阅读计划 / Reading plan | 每周阅读两篇论文。Read two papers per week. |

分别在两个项目开启新会话，首条消息前启用项目记忆。检查个人偏好可用于两者，项目 A 的约束不会作为项目 B 的项目记忆带入。没有可用记忆时先在管理页维护示例条目。

Start a new chat in each project with project memory enabled before sending. Check that the personal preference can apply to both, while project A's constraint is not injected as project B's project memory. If no memories exist, maintain the fictional entries in the manager first.

**边界 / Boundary:** 关闭显示开关不会停止发送记忆；中途开启项目记忆不会在第二条消息补发。A display switch does not stop transmission, and enabling project memory later does not inject it into the second message.

## 03 · 长对话接续 / Continue a long conversation

**目标 / Goal:** 展示现有接续与失败处理，而非承诺无限记忆。Illustrate existing continuation and failure handling, not unlimited memory.

```text
配置上下文预算 / Set context budget
        ↓
本地模拟预算条件满足 / Simulate budget threshold locally
        ↓
接续进入串行队列 / Queue continuation
        ↓
新会话首条消息带入适用记忆 / Include applicable memory in new chat
```

在本地模拟中分别展示成功和无法确认发送的分支。后一种应保留草稿与核对提醒，而不是盲目重发。预算是插件的接续阈值，不是对模型实际上下文容量的保证。

In local fixtures, show both success and an unconfirmed-send case. The latter should preserve the draft and a verification notice instead of blindly resending. The configured budget is an extension threshold, not a guarantee of the model's context capacity.

继承内容预览、新旧会话互跳仍属计划，演示不要画成当前已有界面。

Inheritance previews and old/new-chat navigation remain planned; do not depict them as existing UI.
