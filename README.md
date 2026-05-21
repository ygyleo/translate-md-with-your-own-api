# Your Own API Markdown Translator

用你自己的大模型 API 翻译 Obsidian 里的 Markdown。

## 功能

- 支持 OpenAI 兼容 API 和 Anthropic API
- 设置模型名称、Base URL 和 API Key
- 在设置页测试 API 是否可用
- 默认翻译为简体中文，可切换到常用外语
- 在右侧窗口显示译文，可一键显示或隐藏
- 大文件会分批翻译并显示进度
- 尽量保留 Markdown 格式、代码块、链接、数学公式和 frontmatter

## 使用

1. 安装并启用插件。
2. 打开插件设置。
3. 选择 API 类型。
4. 填写模型名称、Base URL 和 API Key。
5. 点击“测试 API”。
6. 打开一个 Markdown 文件，点击左侧语言图标开始翻译。

## 隐私

插件会把当前 Markdown 内容发送到你配置的 API 服务。插件没有内置服务器，也不会把内容发送到本仓库作者的服务。

API Key 使用 Obsidian SecretStorage 保存。

## 发布到 Obsidian 插件库

1. 确保仓库根目录有 `README.md`、`LICENSE`、`manifest.json`。
2. 创建 GitHub release，tag 必须和 `manifest.json` 里的 `version` 一样。
3. 在 release 里上传 `main.js`、`manifest.json`、`styles.css`。
4. 登录 `community.obsidian.md`。
5. 绑定 GitHub 账号。
6. 进入 Plugins，选择 New plugin。
7. 填写 GitHub 仓库地址并提交审核。

---

# Your Own API Markdown Translator

Translate Markdown in Obsidian with your own LLM API.

## Features

- Supports OpenAI-compatible APIs and Anthropic APIs
- Configure model name, Base URL, and API key
- Test the API in settings
- Default target language is Simplified Chinese, with common target languages included
- Show translation in the right pane, with one-click show/hide
- Translate large files in batches and show progress
- Keeps Markdown format, code blocks, links, math, and frontmatter as much as possible

## Usage

1. Install and enable the plugin.
2. Open the plugin settings.
3. Choose the API type.
4. Enter model name, Base URL, and API key.
5. Click "Test API".
6. Open a Markdown file and click the language icon in the left ribbon.

## Privacy

The plugin sends the current Markdown content to the API service you configure. It does not use any built-in server and does not send content to services owned by this repository author.

API keys are stored with Obsidian SecretStorage.

## Publish To Obsidian Community Plugins

1. Make sure the repository has `README.md`, `LICENSE`, and `manifest.json`.
2. Create a GitHub release. The tag must match the `version` in `manifest.json`.
3. Upload `main.js`, `manifest.json`, and `styles.css` to the release.
4. Sign in to `community.obsidian.md`.
5. Link your GitHub account.
6. Go to Plugins and choose New plugin.
7. Enter the GitHub repository URL and submit it for review.
