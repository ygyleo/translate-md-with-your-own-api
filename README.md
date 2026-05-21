# 自配 API 翻译 Markdown

这是一个 Obsidian 翻译插件，可以用你自己的 OpenAI 兼容或 Anthropic 大模型 API 翻译当前 Markdown，并在右侧侧边栏显示译文。

## 功能

- 打开或切换 `.md` 文件时自动检测并翻译。
- 默认翻译为 `简体中文`，也可以改成任意目标语言。
- 支持 OpenAI 兼容的 chat completions API 和 Anthropic messages API。
- 可以在设置页直接测试模型名称、Base URL 和 API Key 是否可用。
- 大 Markdown 文件会自动拆成多次请求，右侧预览会随着每个分块完成逐步显示。
- 右侧译文滚动时，会按比例同步滚动当前 Markdown 原文页面。
- 不修改原文文件，只在侧边栏渲染翻译后的 Markdown。
- 保留代码块、YAML frontmatter、数学块、行内代码、URL、链接、图片、wiki 链接和 HTML 标签。
- API Key 使用 Obsidian SecretStorage 保存，不会明文写入插件 `data.json`。

## 使用前

你需要准备一个 API Key。插件只会请求你在设置里填写的 Base URL。

## 配置

1. 打开 Obsidian 设置。
2. 在第三方插件中启用 `自配 API 翻译 Markdown`。
3. 打开插件设置。
4. 选择 `OpenAI 兼容` 或 `Anthropic`。
5. 填写 `模型名称`、`Base URL` 和 `API Key`。
6. 点击 `测试 API`，确认配置能正常请求。
7. 打开 Markdown 文件，右侧会显示翻译预览。

OpenAI 兼容接口的 Base URL 可以是 `https://api.openai.com/v1` 这样的根地址，也可以是 `https://example.com/v1/chat/completions` 这样的完整 chat completions 地址。Anthropic 的 Base URL 可以是 `https://api.anthropic.com`、`/v1` 地址，或完整的 `/v1/messages` 地址。

## 隐私

插件会把当前 Markdown 内容发送到你配置的 API endpoint。只有启用自动翻译或手动运行翻译命令时才会请求；插件不会把内容发送到本仓库控制的任何内置服务。

API Key 通过 Obsidian SecretStorage 保存。

## 开发

```bash
npm install
npm run dev
```

本地测试时，把 `main.js`、`manifest.json` 和 `styles.css` 放到：

```text
VaultFolder/.obsidian/plugins/translate-md-with-your-own-api/
```

然后重载 Obsidian 并启用插件。

## 发布

```bash
npm run release:check
npm version patch
git push --follow-tags
```

GitHub release 的 tag 必须和 `manifest.json` 里的版本号完全一致，例如 `1.0.0`。release 里需要附上 `main.js`、`manifest.json` 和 `styles.css`。
