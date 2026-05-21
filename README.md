# Translate MD with Your Own API

Translate MD with Your Own API is an Obsidian plugin that translates the active Markdown note through your own OpenAI-compatible LLM API and renders the translated result in a right-side pane.

## Features

- Automatically detects and translates the active `.md` note when you open or switch notes.
- Defaults to `Chinese (Simplified)` and lets you choose any target language.
- Renders the translated Markdown in a side pane without modifying the source note.
- Preserves fenced code blocks, YAML frontmatter, math blocks, inline code, URLs, links, images, wiki links, and HTML tags.
- Uses Obsidian SecretStorage for API keys instead of storing the key in plugin `data.json`.

## Configure

1. Open Obsidian Settings.
2. Go to Community plugins, enable Translate MD with Your Own API.
3. Open the plugin settings.
4. Create or select an API key secret.
5. Set your OpenAI-compatible API base URL and model.
6. Open a Markdown note. The translated preview appears in the right pane.

The API base URL can be either a root OpenAI-compatible URL such as `https://api.openai.com/v1` or a full chat completions endpoint such as `https://example.com/v1/chat/completions`.

## Privacy

This plugin sends the active note content to the API endpoint that you configure. Translation is only performed for Markdown files and only when auto-translate is enabled or you run the translate command. The plugin does not send data to any built-in service controlled by this repository.

Your API key is stored through Obsidian SecretStorage under the secret name you select in settings.

## Development

```bash
npm install
npm run dev
```

For manual testing, copy `main.js`, `manifest.json`, and `styles.css` into:

```text
VaultFolder/.obsidian/plugins/translate-md-with-your-own-api/
```

Then reload Obsidian and enable the plugin.

## Release

```bash
npm run release:check
npm version patch
git push --follow-tags
```

The GitHub release tag must exactly match the version in `manifest.json`, for example `1.0.0`. Attach `main.js`, `manifest.json`, and `styles.css` to the release.
