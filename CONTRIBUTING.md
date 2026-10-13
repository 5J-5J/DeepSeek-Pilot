# Contributing to DeepSeek Pilot

[简体中文](README.md) · [English](README.en.md)

## 提交问题 / Report an issue

请提供扩展版本、Chrome 版本、复现步骤、期望与实际行为。可以附脱敏截图或日志；不要提交账号信息、认证数据、真实聊天内容或浏览器配置目录。

Include the extension and Chrome versions, reproduction steps, and expected/actual behavior. Redact screenshots and logs; do not submit account details, authentication data, private chats or browser profile directories.

## 修改与验证 / Make and verify changes

1. 查看 README 中的未来开发目标与现有代码，明确改动范围。Review the README future goals and existing code to define the scope.
2. 修改 `core/` 中对应模块，不引入无关重构。Change the relevant modules in `core/`, keeping unrelated refactors separate.
3. 运行相关离线测试与 `git diff --check`。Run relevant offline checks and `git diff --check`.
4. PR 说明行为变化、验证命令与限制；同步更新两种语言的用户文档。Describe behavior changes, verification and limitations in the PR, and update both README languages.

```sh
node tests/classification-disabled-test.mjs
node tests/session-memory-test.mjs
node tests/automation-cleanup-test.mjs
node tests/request-body-test.mjs
node tests/memory-display-test.mjs
git diff --check
```

界面相关修改可运行 `node tests/settings-ui-test.mjs` 和 `node tests/sidebar-ui-test.mjs`，需本机 Chrome，使用临时配置和本地模拟页面。不要不加区分地执行所有测试文件，部分文件用于真实站点侦查。

For UI changes, `node tests/settings-ui-test.mjs` and `node tests/sidebar-ui-test.mjs` use local Chrome with temporary profiles and local fixtures. Do not blindly execute every test file: some are real-site reconnaissance tools.

默认不得主动访问真实 DeepSeek、调用登录接口或发送真实消息；真实账号验证仅在用户明确要求且账号可用时进行。

Do not access real DeepSeek, call login endpoints or send real messages for testing by default. Real-account testing requires an explicit user request and an available account.

## 发布说明 / Release note

目前许可证待维护者选择；不要假定代码已经获得 MIT 或其他开源授权。This repository's license is pending maintainer selection; do not assume MIT or another open-source grant.

## 本地设计文档 / Local design documents

`docs/` 仅供本地使用，已从 Git 跟踪中移除并忽略。公开安装说明、功能目标和贡献步骤直接维护在根目录文档，展示素材放在 `assets/`。

`docs/` is local-only and excluded from Git tracking. Keep public installation steps, feature goals and contribution instructions in root-level documents, and artwork in `assets/`.
