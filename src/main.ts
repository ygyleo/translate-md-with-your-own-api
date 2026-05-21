import {
  App,
  ItemView,
  MarkdownView,
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
  buildAnthropicMessagesUrl,
  buildOpenAiChatCompletionsUrl,
  translateMarkdown,
  TranslationProgress
} from "./translation";

const VIEW_TYPE_TRANSLATOR = "translate-md-with-your-own-api-view";

type ApiProvider = "openai" | "anthropic";

interface TranslatorSettings {
  apiBaseUrl: string;
  apiKeySecretName: string;
  autoTranslate: boolean;
  maxChunkChars: number;
  model: string;
  provider: ApiProvider;
  targetLanguage: string;
  translateOnModify: boolean;
}

const PROVIDER_DEFAULTS: Record<ApiProvider, { apiBaseUrl: string; model: string }> = {
  openai: {
    apiBaseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini"
  },
  anthropic: {
    apiBaseUrl: "https://api.anthropic.com",
    model: "claude-3-5-haiku-latest"
  }
};

const DEFAULT_SETTINGS: TranslatorSettings = {
  apiBaseUrl: PROVIDER_DEFAULTS.openai.apiBaseUrl,
  apiKeySecretName: "",
  autoTranslate: true,
  maxChunkChars: 6000,
  model: PROVIDER_DEFAULTS.openai.model,
  provider: "openai",
  targetLanguage: "简体中文",
  translateOnModify: true
};

interface CompletionRequest {
  maxTokens?: number;
  system: string;
  temperature?: number;
  user: string;
}

interface OpenAiChatCompletionResponse {
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

interface AnthropicMessagesResponse {
  content?: Array<{
    text?: string;
    type?: string;
  }>;
  error?: {
    message?: string;
    type?: string;
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
      name: "打开翻译侧边栏",
      callback: () => {
        this.activateView();
      }
    });

    this.addCommand({
      id: "translate-active-note",
      name: "翻译当前 Markdown",
      callback: () => {
        this.translateActiveFile(true);
      }
    });

    this.addRibbonIcon("languages", "翻译当前 Markdown", () => {
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
    const loadedData = await this.loadData();
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loadedData
    };
    let shouldSave = false;

    if (this.settings.targetLanguage === "Chinese (Simplified)") {
      this.settings.targetLanguage = DEFAULT_SETTINGS.targetLanguage;
      shouldSave = true;
    }
    if (!loadedData?.provider) {
      shouldSave = true;
    }

    if (shouldSave) {
      await this.saveSettings();
    }
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
      new Notice("无法打开翻译侧边栏。");
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
        new Notice("请先打开一个 Markdown 文件。");
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
          "请先在插件设置里选择或创建 API Key。",
          file
        );
        return;
      }

      const translatedMarkdown = await translateMarkdown(sourceMarkdown, {
        targetLanguage: this.settings.targetLanguage,
        maxChunkChars: this.settings.maxChunkChars,
        onProgress: async (progress) => {
          if (runId !== this.activeRunId) {
            throw new TranslationCancelledError();
          }
          await view.showPartialMarkdown(file, progress);
        },
        translateChunk: (markdown, targetLanguage) =>
          this.translateChunk(markdown, targetLanguage, apiKey)
      });

      if (runId !== this.activeRunId) {
        return;
      }

      this.lastFingerprint = fingerprint;
      await view.showMarkdown(file, translatedMarkdown);
    } catch (error) {
      if (error instanceof TranslationCancelledError) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      view.showStatus(`翻译失败：${message}`, file);
      new Notice(`翻译失败：${message}`);
    }
  }

  async testApiConnection(): Promise<string> {
    const apiKey = await this.resolveApiKey();
    if (!apiKey) {
      throw new Error("请先选择或创建 API Key。");
    }

    const response = await this.requestCompletion(
      {
        maxTokens: 16,
        system: "You are a connection test. Reply with exactly OK.",
        temperature: 0,
        user: "Reply with OK."
      },
      apiKey
    );

    return response.trim();
  }

  private async translateChunk(
    markdown: string,
    targetLanguage: string,
    apiKey: string
  ): Promise<string> {
    const content = await this.requestCompletion(
      {
        maxTokens: estimateTranslationTokens(markdown),
        system: [
          "You are a careful Markdown translator.",
          "Translate only human-readable prose into the target language.",
          "Keep Markdown syntax, heading levels, lists, tables, blockquotes, placeholders, HTML tags, file paths, URLs, commands, identifiers, math, and code exactly unchanged.",
          "Do not wrap the answer in a code block.",
          "Return only the translated Markdown."
        ].join(" "),
        temperature: 0.1,
        user: `Target language: ${targetLanguage}\n\nMarkdown:\n<<<MARKDOWN\n${markdown}\nMARKDOWN`
      },
      apiKey
    );

    return unwrapMarkdownFence(content);
  }

  private async requestCompletion(request: CompletionRequest, apiKey: string): Promise<string> {
    if (this.settings.provider === "anthropic") {
      return this.requestAnthropicMessage(request, apiKey);
    }
    return this.requestOpenAiChatCompletion(request, apiKey);
  }

  private async requestOpenAiChatCompletion(
    request: CompletionRequest,
    apiKey: string
  ): Promise<string> {
    const response = await requestUrl({
      url: buildOpenAiChatCompletionsUrl(this.settings.apiBaseUrl),
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.settings.model,
        temperature: request.temperature ?? 0.1,
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        messages: [
          {
            role: "system",
            content: request.system
          },
          {
            role: "user",
            content: request.user
          }
        ]
      })
    });

    if (response.status < 200 || response.status >= 300) {
      const body = response.text || JSON.stringify(response.json ?? {});
      throw new Error(`API 返回 HTTP ${response.status}：${body.slice(0, 300)}`);
    }

    const json = response.json as OpenAiChatCompletionResponse;
    if (json.error?.message) {
      throw new Error(json.error.message);
    }

    const content = json.choices?.[0]?.message?.content ?? json.choices?.[0]?.text;
    if (!content) {
      throw new Error("API 响应里没有可用内容。");
    }

    return content;
  }

  private async requestAnthropicMessage(
    request: CompletionRequest,
    apiKey: string
  ): Promise<string> {
    const response = await requestUrl({
      url: buildAnthropicMessagesUrl(this.settings.apiBaseUrl),
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "x-api-key": apiKey
      },
      body: JSON.stringify({
        max_tokens: request.maxTokens ?? 4096,
        messages: [
          {
            role: "user",
            content: request.user
          }
        ],
        model: this.settings.model,
        system: request.system,
        temperature: request.temperature ?? 0.1
      })
    });

    if (response.status < 200 || response.status >= 300) {
      const body = response.text || JSON.stringify(response.json ?? {});
      throw new Error(`API 返回 HTTP ${response.status}：${body.slice(0, 300)}`);
    }

    const json = response.json as AnthropicMessagesResponse;
    if (json.error?.message) {
      throw new Error(json.error.message);
    }

    const content = json.content
      ?.filter((block) => block.type === "text" || block.text)
      .map((block) => block.text ?? "")
      .join("");

    if (!content) {
      throw new Error("API 响应里没有可用内容。");
    }

    return content;
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
      this.settings.provider,
      this.settings.targetLanguage,
      this.settings.model,
      this.settings.apiBaseUrl,
      hashString(content)
    ].join("\n");
  }

  syncSourceScroll(file: TFile | null, ratio: number): void {
    if (!file || !Number.isFinite(ratio)) {
      return;
    }

    const clampedRatio = Math.max(0, Math.min(1, ratio));
    const markdownView = this.findMarkdownView(file);
    if (!markdownView) {
      return;
    }

    const scrollTarget = findBestScrollElement(markdownView.contentEl);
    if (!scrollTarget) {
      return;
    }

    const maxScrollTop = scrollTarget.scrollHeight - scrollTarget.clientHeight;
    if (maxScrollTop <= 0) {
      return;
    }

    scrollTarget.scrollTop = maxScrollTop * clampedRatio;
  }

  private findMarkdownView(file: TFile): MarkdownView | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
        return leaf.view;
      }
    }
    return null;
  }
}

class TranslationView extends ItemView {
  private copyButtonEl: HTMLButtonElement | null = null;
  private currentSourceFile: TFile | null = null;
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
    return "Markdown 翻译";
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
    this.currentSourceFile = file;
    this.translatedMarkdown = "";
    this.copyButtonEl?.setAttr("disabled", "true");
    this.titleEl?.setText(file.path);
    this.statusEl?.setText(`正在翻译为${this.plugin.settings.targetLanguage}...`);
    this.previewEl?.empty();
    this.previewEl?.createDiv({
      cls: "translate-md-api-empty",
      text: "正在翻译。"
    });
  }

  async showPartialMarkdown(file: TFile, progress: TranslationProgress): Promise<void> {
    this.ensureBuilt();
    this.currentSourceFile = file;
    this.translatedMarkdown = progress.markdown;
    if (progress.markdown) {
      this.copyButtonEl?.removeAttribute("disabled");
    }
    this.titleEl?.setText(file.path);
    this.statusEl?.setText(this.getProgressText(progress));
    await this.renderMarkdown(file, progress.markdown);
  }

  showStatus(message: string, file?: TFile): void {
    this.ensureBuilt();
    if (file) {
      this.currentSourceFile = file;
    }
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
    this.currentSourceFile = file;
    this.translatedMarkdown = markdown;
    this.copyButtonEl?.removeAttribute("disabled");
    this.titleEl?.setText(file.path);
    this.statusEl?.setText(`已翻译为${this.plugin.settings.targetLanguage}`);
    await this.renderMarkdown(file, markdown);
  }

  private async renderMarkdown(file: TFile, markdown: string): Promise<void> {
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

  private getProgressText(progress: TranslationProgress): string {
    if (progress.totalRequests === 0) {
      return "没有找到需要翻译的正文，已显示保留后的 Markdown。";
    }
    return [
      `正在翻译为${this.plugin.settings.targetLanguage}`,
      `API 分块 ${progress.completedRequests}/${progress.totalRequests}`,
      `Markdown 片段 ${progress.completedParts}/${progress.totalParts}`
    ].join(" · ");
  }

  private build(): void {
    this.contentEl.empty();
    this.contentEl.addClass("translate-md-api-view");

    const toolbar = this.contentEl.createDiv({ cls: "translate-md-api-toolbar" });
    this.titleEl = toolbar.createDiv({ cls: "translate-md-api-title" });

    const language = toolbar.createDiv({ cls: "translate-md-api-language" });
    language.createEl("span", { text: "目标语言" });
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
      attr: { "aria-label": "重新翻译" }
    });
    setIcon(refreshButton, "refresh-cw");
    refreshButton.addEventListener("click", () => {
      this.plugin.translateActiveFile(true);
    });

    this.copyButtonEl = toolbar.createEl("button", {
      cls: "clickable-icon",
      attr: {
        "aria-label": "复制翻译后的 Markdown",
        disabled: "true"
      }
    });
    setIcon(this.copyButtonEl, "copy");
    this.copyButtonEl.addEventListener("click", () => {
      this.copyTranslatedMarkdown();
    });

    this.statusEl = this.contentEl.createDiv({ cls: "translate-md-api-status" });
    this.previewEl = this.contentEl.createDiv({ cls: "translate-md-api-preview markdown-rendered" });
    this.previewEl.addEventListener("scroll", () => {
      this.syncSourceScrollFromPreview();
    });
  }

  private showEmpty(): void {
    this.ensureBuilt();
    this.titleEl?.setText("还没有翻译内容");
    this.statusEl?.setText("打开 Markdown 文件，或运行翻译命令。");
    this.previewEl?.empty();
    this.previewEl?.createDiv({
      cls: "translate-md-api-empty",
      text: "翻译预览会显示在这里。"
    });
  }

  private ensureBuilt(): void {
    if (!this.previewEl || !this.statusEl || !this.titleEl) {
      this.build();
    }
  }

  private async copyTranslatedMarkdown(): Promise<void> {
    if (!this.translatedMarkdown) {
      new Notice("还没有可复制的翻译内容。");
      return;
    }

    await navigator.clipboard.writeText(this.translatedMarkdown);
    new Notice("已复制翻译后的 Markdown。");
  }

  private syncSourceScrollFromPreview(): void {
    if (!this.previewEl) {
      return;
    }

    const maxScrollTop = this.previewEl.scrollHeight - this.previewEl.clientHeight;
    if (maxScrollTop <= 0) {
      return;
    }

    this.plugin.syncSourceScroll(this.currentSourceFile, this.previewEl.scrollTop / maxScrollTop);
  }
}

class TranslatorSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: LlmMarkdownTranslatorPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("自配 API 翻译 Markdown")
      .setHeading();

    new Setting(containerEl)
      .setName("API 类型")
      .setDesc("选择翻译请求使用的接口协议。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("openai", "OpenAI 兼容")
          .addOption("anthropic", "Anthropic")
          .setValue(this.plugin.settings.provider)
          .onChange(async (value) => {
            const previousProvider = this.plugin.settings.provider;
            const nextProvider = value as ApiProvider;
            this.plugin.settings.provider = nextProvider;
            this.applyProviderDefaults(previousProvider, nextProvider);
            await this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("模型名称")
      .setDesc("填写所选服务商支持的完整模型名。")
      .addText((text) =>
        text
          .setPlaceholder(this.getModelPlaceholder())
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc(this.getBaseUrlDescription())
      .addText((text) =>
        text
          .setPlaceholder(this.getBaseUrlPlaceholder())
          .setValue(this.plugin.settings.apiBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.apiBaseUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("选择或创建一个用于保存 API Key 的安全密钥项。")
      .addComponent((el) =>
        new SecretComponent(this.app, el)
          .setValue(this.plugin.settings.apiKeySecretName)
          .onChange(async (value) => {
            this.plugin.settings.apiKeySecretName = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("测试 API")
      .setDesc("用当前 API 类型、模型名称、Base URL 和 API Key 发送一次很小的测试请求。")
      .addButton((button) =>
        button
          .setButtonText("测试 API")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("测试中...");
            try {
              const result = await this.plugin.testApiConnection();
              new Notice(`API 测试成功：${result.slice(0, 80) || "OK"}`);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              new Notice(`API 测试失败：${message}`);
            } finally {
              button.setButtonText("测试 API");
              button.setDisabled(false);
            }
          })
      );

    new Setting(containerEl)
      .setName("目标语言")
      .setDesc("自动翻译时使用的目标语言。")
      .addText((text) =>
        text
          .setPlaceholder("简体中文")
          .setValue(this.plugin.settings.targetLanguage)
          .onChange(async (value) => {
            this.plugin.settings.targetLanguage = value.trim() || DEFAULT_SETTINGS.targetLanguage;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("自动翻译当前文件")
      .setDesc("切换到 Markdown 文件时自动翻译。")
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
      .setName("编辑后重新翻译")
      .setDesc("当前 Markdown 文件变更后刷新翻译。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.translateOnModify)
          .onChange(async (value) => {
            this.plugin.settings.translateOnModify = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("最大分块字符数")
      .setDesc("如果你的 API 上下文窗口较小，可以调低这个值。")
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

  private applyProviderDefaults(previousProvider: ApiProvider, nextProvider: ApiProvider): void {
    const previousDefaults = PROVIDER_DEFAULTS[previousProvider];
    const nextDefaults = PROVIDER_DEFAULTS[nextProvider];

    if (
      !this.plugin.settings.apiBaseUrl ||
      this.plugin.settings.apiBaseUrl === previousDefaults.apiBaseUrl
    ) {
      this.plugin.settings.apiBaseUrl = nextDefaults.apiBaseUrl;
    }

    if (!this.plugin.settings.model || this.plugin.settings.model === previousDefaults.model) {
      this.plugin.settings.model = nextDefaults.model;
    }
  }

  private getBaseUrlDescription(): string {
    if (this.plugin.settings.provider === "anthropic") {
      return "填写 Anthropic 根地址、/v1 地址，或完整的 /v1/messages 地址。";
    }
    return "填写 OpenAI 兼容的根地址，或完整的 /chat/completions 地址。";
  }

  private getBaseUrlPlaceholder(): string {
    return PROVIDER_DEFAULTS[this.plugin.settings.provider].apiBaseUrl;
  }

  private getModelPlaceholder(): string {
    return PROVIDER_DEFAULTS[this.plugin.settings.provider].model;
  }
}

class TranslationCancelledError extends Error {
  constructor() {
    super("Translation was cancelled.");
    this.name = "TranslationCancelledError";
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

function estimateTranslationTokens(markdown: string): number {
  return Math.min(8192, Math.max(1024, Math.ceil(markdown.length / 2)));
}

function findBestScrollElement(root: HTMLElement): HTMLElement | null {
  const candidates = [
    root,
    ...Array.from(
      root.querySelectorAll<HTMLElement>(
        ".markdown-preview-view, .markdown-source-view .cm-scroller, .cm-scroller, .view-content"
      )
    )
  ];

  let best: HTMLElement | null = null;
  let bestRange = 0;
  for (const candidate of candidates) {
    const range = candidate.scrollHeight - candidate.clientHeight;
    if (range > bestRange) {
      best = candidate;
      bestRange = range;
    }
  }

  return bestRange > 0 ? best : null;
}
