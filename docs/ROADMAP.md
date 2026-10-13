# DeepSeek Pilot · Roadmap

[简体中文 README](../README.md) · [English README](../README.en.md)

更新 / Updated: **2026-10-13** · Version: **0.9.0**

此处整理当前计划，不代表发布日期承诺。详细问题、代码入口和验收场景见[开发优化阶段计划](开发优化阶段计划.md)。自动归类目前关闭，恢复前需要独立验证。

This is the intended sequence, not a release-date commitment. The detailed implementation plan is linked above in Chinese. Automatic classification is disabled and requires separate validation before re-enabling.

| 阶段 / Stage | 状态 / Status | 交付目标 / Intended outcome |
| --- | --- | --- |
| 1 · 清理保护 / Cleanup protections | 已完成 / Complete | 区分辅助会话与手动收纳，保护来源不明的记录。Distinguish generated auxiliary chats from manually collected chats; protect unknown-origin records. |
| 2 · 记忆状态 / Memory visibility | 待开发 / Planned | 显示将带入、已带入的记忆及真实内容预览。Show pending and actual injected memory with content previews. |
| 3 · 会话控制 / Per-chat controls | 待开发 / Planned | 分别控制记忆带入和学习，提供独立归类开关。Control memory injection and learning per chat; add a separate classification switch. |
| 4 · 更新反馈 / Update feedback | 待开发 / Planned | 最近更新结果、变更明细、来源入口和待核对操作。Expose update results, changes, source links and actionable verification steps. |
| 5 · 接续体验 / Continuation UX | 待开发 / Planned | 提前提示、继承预览、新旧会话跳转及草稿恢复入口。Add advance notices, inheritance previews, linked chats and draft recovery access. |
| 6 · 管理效率 / Management | 待开发 / Planned | 项目与会话筛选、记忆搜索、批量移动、完整管理页和首次使用说明。Add filters, memory search, bulk moves, full-page management and onboarding. |

阶段 2 的先前实现已撤销，当前状态是待开发；阶段 5 改进已有接续功能，不代表当前完全没有接续。

An earlier stage-2 implementation was reverted and is not currently shipped. Stage 5 improves existing continuation rather than introducing it from scratch.

## 发布准备 / Release preparation

- [x] 统一 DeepSeek Pilot 展示名称 / Adopt the DeepSeek Pilot display name.
- [x] 中英文 README、虚构场景样例和公开路线图 / Bilingual READMEs, fictional examples and public roadmap.
- [ ] 维护者选定许可证并添加 LICENSE / Maintainer selects a license and adds LICENSE.
- [ ] 确认是否同步重命名 GitHub 仓库及更新远程地址 / Decide whether to rename the GitHub repository and update remote URLs.
- [ ] 发布前完成目标版本回归并准备版本说明与安装包 / Run release regression checks and prepare release notes and an installable archive.

以上发布准备不代表这些事项已获得验证或已发布浏览器商店版本。

These preparation items do not imply a validated release or browser-store availability.
