import {
  App,
  ItemView,
  MarkdownRenderer,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  SecretComponent,
  Setting,
  setIcon,
  TFile,
  WorkspaceLeaf
} from "obsidian";
import {
  buildChatCompletionsUrl,
  translateMarkdown
} from "./translation";

const VIEW_TYPE_TRANSLATOR = "translate-md-with-your-own-api-view";

interface TranslatorSettings {
  apiBaseUrl: string;
  apiKeySecretName: string;
  autoTranslate: boolean;
  maxChunkChars: number;
  model: string;
  targetLanguage: string;
  translateOnModify: boolean;
}

const DEFAULT_SETTINGS: TranslatorSettings = {
  apiBaseUrl: "https://api.openai.com/v1",
  apiKeySecretName: "",
  autoTranslate: true,
  maxChunkChars: 6000,
  model: "gpt-4o-mini",
  targetLanguage: "Chinese (Simplified)",
  translateOnModify: true
};

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
    text?: string;
  }>;
  error?: {
    message?: string;
  };
}

export default class LlmMarkdownTranslatorPlugin extends Plugin {
  settings: TranslatorSettings = { ...DEFAULT_SETTINGS };
  private activeRunId = 0;
  private lastFingerprint = "";
  private translateTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_TRANSLATOR,
      (leaf) => new TranslationView(leaf, this)
    );

    this.addSettingTab(new TranslatorSettingTab(this.app, this));

    this.addCommand({
      id: "open-translator-pane",
      name: "Open translator pane",
      callback: () => {
        this.activateView();
      }
    });

    this.addCommand({
      id: "translate-active-note",
      name: "Translate active note",
      callback: () => {
        this.translateActiveFile(true);
      }
    });

    this.addRibbonIcon("languages", "Translate active note", () => {
      this.translateActiveFile(true);
    });

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.workspace.on("active-leaf-change", () => {
          if (this.settings.autoTranslate) {
            this.queueTranslateActiveFile(false);
          }
        })
      );

      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          const activeFile = this.app.workspace.getActiveFile();
          if (
            this.settings.autoTranslate &&
            this.settings.translateOnModify &&
            file instanceof TFile &&
            activeFile instanceof TFile &&
            file.path === activeFile.path
          ) {
            this.queueTranslateActiveFile(false);
          }
        })
      );

      if (this.settings.autoTranslate) {
        this.queueTranslateActiveFile(false);
      }
    });
  }

  onunload(): void {
    if (this.translateTimer !== null) {
      window.clearTimeout(this.translateTimer);
      this.translateTimer = null;
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(await this.loadData())
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateView(): Promise<TranslationView | null> {
    let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(VIEW_TYPE_TRANSLATOR)[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
    }

    if (!leaf) {
      new Notice("Unable to open the translator pane.");
      return null;
    }

    await leaf.setViewState({
      type: VIEW_TYPE_TRANSLATOR,
      active: false
    });
    this.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof TranslationView ? leaf.view : null;
  }

  queueTranslateActiveFile(force: boolean): void {
    if (this.translateTimer !== null) {
      window.clearTimeout(this.translateTimer);
    }

    this.translateTimer = window.setTimeout(() => {
      this.translateTimer = null;
      this.translateActiveFile(force);
    }, 600);
  }

  async translateActiveFile(force: boolean): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") {
      if (force) {
        new Notice("Open a Markdown file before translating.");
      }
      return;
    }

    const sourceMarkdown = await this.app.vault.cachedRead(file);
    const fingerprint = this.getFingerprint(file, sourceMarkdown);
    if (!force && fingerprint === this.lastFingerprint) {
      return;
    }

    const view = await this.activateView();
    if (!view) {
      return;
    }

    view.showLoading(file);
    const runId = ++this.activeRunId;

    try {
      const apiKey = await this.resolveApiKey();
      if (!apiKey) {
        view.showStatus(
          "Select or create an API key secret in the plugin settings.",
          file
        );
        return;
      }

      const translatedMarkdown = await translateMarkdown(sourceMarkdown, {
        targetLanguage: this.settings.targetLanguage,
        maxChunkChars: this.settings.maxChunkChars,
        translateChunk: (markdown, targetLanguage) =>
          this.translateChunk(markdown, targetLanguage, apiKey)
      });

      if (runId !== this.activeRunId) {
        return;
      }

      this.lastFingerprint = fingerprint;
      await view.showMarkdown(file, translatedMarkdown);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      view.showStatus(`Translation failed: ${message}`, file);
      new Notice(`Translation failed: ${message}`);
    }
  }

  private async translateChunk(
    markdown: string,
    targetLanguage: string,
    apiKey: string
  ): Promise<string> {
    const response = await requestUrl({
      url: buildChatCompletionsUrl(this.settings.apiBaseUrl),
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.settings.model,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: [
              "You are a careful Markdown translator.",
              "Translate only human-readable prose into the target language.",
              "Keep Markdown syntax, heading levels, lists, tables, blockquotes, placeholders, HTML tags, file paths, URLs, commands, identifiers, math, and code exactly unchanged.",
              "Do not wrap the answer in a code block.",
              "Return only the translated Markdown."
            ].join(" ")
          },
          {
            role: "user",
            content: `Target language: ${targetLanguage}\n\nMarkdown:\n<<<MARKDOWN\n${markdown}\nMARKDOWN`
          }
        ]
      })
    });

    if (response.status < 200 || response.status >= 300) {
      const body = response.text || JSON.stringify(response.json ?? {});
      throw new Error(`API returned HTTP ${response.status}: ${body.slice(0, 300)}`);
    }

    const json = response.json as ChatCompletionResponse;
    if (json.error?.message) {
      throw new Error(json.error.message);
    }

    const content = json.choices?.[0]?.message?.content ?? json.choices?.[0]?.text;
    if (!content) {
      throw new Error("API response did not include translated content.");
    }

    return unwrapMarkdownFence(content);
  }

  private async resolveApiKey(): Promise<string | null> {
    const secretName = this.settings.apiKeySecretName.trim();
    if (!secretName) {
      return null;
    }

    const value = this.app.secretStorage.getSecret(secretName);
    return value?.trim() || null;
  }

  private getFingerprint(file: TFile, content: string): string {
    return [
      file.path,
      this.settings.targetLanguage,
      this.settings.model,
      this.settings.apiBaseUrl,
      hashString(content)
    ].join("\n");
  }
}

class TranslationView extends ItemView {
  private copyButtonEl: HTMLButtonElement | null = null;
  private languageInputEl: HTMLInputElement | null = null;
  private previewEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private translatedMarkdown = "";

  constructor(leaf: WorkspaceLeaf, private readonly plugin: LlmMarkdownTranslatorPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_TRANSLATOR;
  }

  getDisplayText(): string {
    return "LLM translation";
  }

  getIcon(): string {
    return "languages";
  }

  async onOpen(): Promise<void> {
    this.build();
    this.showEmpty();
  }

  showLoading(file: TFile): void {
    this.ensureBuilt();
    this.translatedMarkdown = "";
    this.copyButtonEl?.setAttr("disabled", "true");
    this.titleEl?.setText(file.path);
    this.statusEl?.setText(`Translating to ${this.plugin.settings.targetLanguage}...`);
    this.previewEl?.empty();
    this.previewEl?.createDiv({
      cls: "translate-md-api-empty",
      text: "Translation is running."
    });
  }

  showStatus(message: string, file?: TFile): void {
    this.ensureBuilt();
    if (file) {
      this.titleEl?.setText(file.path);
    }
    this.statusEl?.setText(message);
    this.previewEl?.empty();
    this.previewEl?.createDiv({
      cls: "translate-md-api-empty",
      text: message
    });
  }

  async showMarkdown(file: TFile, markdown: string): Promise<void> {
    this.ensureBuilt();
    this.translatedMarkdown = markdown;
    this.copyButtonEl?.removeAttribute("disabled");
    this.titleEl?.setText(file.path);
    this.statusEl?.setText(`Translated to ${this.plugin.settings.targetLanguage}`);
    this.previewEl?.empty();

    if (!this.previewEl) {
      return;
    }

    await MarkdownRenderer.render(
      this.app,
      markdown,
      this.previewEl,
      file.path,
      this
    );
  }

  private build(): void {
    this.contentEl.empty();
    this.contentEl.addClass("translate-md-api-view");

    const toolbar = this.contentEl.createDiv({ cls: "translate-md-api-toolbar" });
    this.titleEl = toolbar.createDiv({ cls: "translate-md-api-title" });

    const language = toolbar.createDiv({ cls: "translate-md-api-language" });
    language.createEl("span", { text: "Target" });
    this.languageInputEl = language.createEl("input", {
      type: "text",
      value: this.plugin.settings.targetLanguage
    });
    this.languageInputEl.addEventListener("change", async () => {
      const value = this.languageInputEl?.value.trim();
      if (!value) {
        return;
      }
      this.plugin.settings.targetLanguage = value;
      await this.plugin.saveSettings();
      this.plugin.translateActiveFile(true);
    });

    const refreshButton = toolbar.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "Refresh translation" }
    });
    setIcon(refreshButton, "refresh-cw");
    refreshButton.addEventListener("click", () => {
      this.plugin.translateActiveFile(true);
    });

    this.copyButtonEl = toolbar.createEl("button", {
      cls: "clickable-icon",
      attr: {
        "aria-label": "Copy translated Markdown",
        disabled: "true"
      }
    });
    setIcon(this.copyButtonEl, "copy");
    this.copyButtonEl.addEventListener("click", () => {
      this.copyTranslatedMarkdown();
    });

    this.statusEl = this.contentEl.createDiv({ cls: "translate-md-api-status" });
    this.previewEl = this.contentEl.createDiv({ cls: "translate-md-api-preview markdown-rendered" });
  }

  private showEmpty(): void {
    this.ensureBuilt();
    this.titleEl?.setText("No translated note yet");
    this.statusEl?.setText("Open a Markdown note or run the translate command.");
    this.previewEl?.empty();
    this.previewEl?.createDiv({
      cls: "translate-md-api-empty",
      text: "The translated preview will appear here."
    });
  }

  private ensureBuilt(): void {
    if (!this.previewEl || !this.statusEl || !this.titleEl) {
      this.build();
    }
  }

  private async copyTranslatedMarkdown(): Promise<void> {
    if (!this.translatedMarkdown) {
      new Notice("No translated Markdown to copy yet.");
      return;
    }

    await navigator.clipboard.writeText(this.translatedMarkdown);
    new Notice("Translated Markdown copied.");
  }
}

class TranslatorSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: LlmMarkdownTranslatorPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Translate MD with Your Own API" });

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Select or create a SecretStorage entry for your API key.")
      .addComponent((el) =>
        new SecretComponent(this.app, el)
          .setValue(this.plugin.settings.apiKeySecretName)
          .onChange(async (value) => {
            this.plugin.settings.apiKeySecretName = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API base URL")
      .setDesc("Use an OpenAI-compatible base URL or full chat completions URL.")
      .addText((text) =>
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(this.plugin.settings.apiBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.apiBaseUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Any chat model supported by your configured API.")
      .addText((text) =>
        text
          .setPlaceholder("gpt-4o-mini")
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Target language")
      .setDesc("The language used for automatic translations.")
      .addText((text) =>
        text
          .setPlaceholder("Chinese (Simplified)")
          .setValue(this.plugin.settings.targetLanguage)
          .onChange(async (value) => {
            this.plugin.settings.targetLanguage = value.trim() || DEFAULT_SETTINGS.targetLanguage;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto translate active note")
      .setDesc("Translate Markdown files automatically when they become active.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoTranslate)
          .onChange(async (value) => {
            this.plugin.settings.autoTranslate = value;
            await this.plugin.saveSettings();
            if (value) {
              this.plugin.queueTranslateActiveFile(true);
            }
          })
      );

    new Setting(containerEl)
      .setName("Retranslate after edits")
      .setDesc("Refresh the translation when the active Markdown note changes.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.translateOnModify)
          .onChange(async (value) => {
            this.plugin.settings.translateOnModify = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Maximum chunk size")
      .setDesc("Lower this if your API has a small context window.")
      .addText((text) =>
        text
          .setPlaceholder("6000")
          .setValue(String(this.plugin.settings.maxChunkChars))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed)) {
              this.plugin.settings.maxChunkChars = Math.max(1000, parsed);
              await this.plugin.saveSettings();
            }
          })
      );
  }
}

function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

function unwrapMarkdownFence(content: string): string {
  const trimmed = content.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return match ? match[1] : content;
}
