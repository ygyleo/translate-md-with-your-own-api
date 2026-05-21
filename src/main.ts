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
  TranslationOutputPart,
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

const TARGET_LANGUAGE_OPTIONS = [
  "简体中文",
  "繁体中文",
  "英语",
  "日语",
  "韩语",
  "法语",
  "德语",
  "西班牙语",
  "葡萄牙语",
  "俄语",
  "意大利语",
  "荷兰语",
  "越南语",
  "泰语",
  "印尼语",
  "阿拉伯语"
];

interface CompletionRequest {
  maxTokens?: number;
  system: string;
  temperature?: number;
  user: string;
}

interface OpenAiChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: ApiTextContent;
      reasoning_content?: string;
    };
    text?: ApiTextContent;
  }>;
  error?: {
    message?: string;
  };
}

interface AnthropicMessagesResponse {
  content?: ApiTextContent | Array<{
    text?: string;
    type?: string;
  }>;
  error?: {
    message?: string;
    type?: string;
  };
}

type ApiTextContent = string | Array<{ content?: string; text?: string; type?: string }>;

export default class LlmMarkdownTranslatorPlugin extends Plugin {
  settings: TranslatorSettings = { ...DEFAULT_SETTINGS };
  private activeRunId = 0;
  private lastFingerprint = "";
  private translateTimer: number | null = null;
  private userHiddenTranslator = false;

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
      id: "toggle-translator-pane",
      name: "显示或隐藏翻译侧边栏",
      callback: () => {
        this.toggleTranslatorPane();
      }
    });

    this.addCommand({
      id: "translate-active-note",
      name: "翻译当前 Markdown",
      callback: () => {
        this.translateActiveFile(true);
      }
    });

    this.addRibbonIcon("languages", "显示或隐藏翻译侧边栏", () => {
      this.toggleTranslatorPane();
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
    this.userHiddenTranslator = false;
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

  async toggleTranslatorPane(): Promise<void> {
    if (this.app.workspace.getLeavesOfType(VIEW_TYPE_TRANSLATOR).length > 0) {
      this.hideTranslatorPane();
      return;
    }

    this.userHiddenTranslator = false;
    const file = this.app.workspace.getActiveFile();
    if (file instanceof TFile && file.extension.toLowerCase() === "md") {
      await this.translateActiveFile(true);
      return;
    }

    await this.activateView();
  }

  hideTranslatorPane(): void {
    this.userHiddenTranslator = true;
    this.activeRunId += 1;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TRANSLATOR)) {
      leaf.detach();
    }
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
    if (
      !force &&
      this.userHiddenTranslator &&
      this.app.workspace.getLeavesOfType(VIEW_TYPE_TRANSLATOR).length === 0
    ) {
      return;
    }
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
      view.showError(message, file);
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
          "If custom <translate-md-block id=\"...\"> wrapper tags appear, keep those opening and closing tags exactly unchanged and translate only the text inside each wrapper.",
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
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const content = this.settings.provider === "anthropic"
          ? await this.requestAnthropicMessage(request, apiKey)
          : await this.requestOpenAiChatCompletion(request, apiKey);
        if (content.trim()) {
          return content;
        }
        throw new EmptyApiContentError();
      } catch (error) {
        lastError = error;
        if (error instanceof EmptyApiContentError && attempt < 2) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
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

    const choice = json.choices?.[0];
    const content = normalizeApiTextContent(choice?.message?.content) ||
      normalizeApiTextContent(choice?.text);
    if (!content.trim()) {
      throw new EmptyApiContentError(choice?.finish_reason);
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

    const content = normalizeApiTextContent(json.content);

    if (!content.trim()) {
      throw new EmptyApiContentError();
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

  syncSourceToLine(file: TFile | null, line: number): void {
    if (!file || !Number.isFinite(line)) {
      return;
    }

    const markdownView = this.findMarkdownView(file);
    if (!markdownView) {
      return;
    }

    const targetLine = Math.max(0, Math.floor(line));
    if (!scrollRenderedMarkdownToLine(markdownView.contentEl, targetLine)) {
      markdownView.editor.scrollIntoView({
        from: { line: targetLine, ch: 0 },
        to: { line: targetLine, ch: 0 }
      });
    }
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
  private closeButtonEl: HTMLButtonElement | null = null;
  private copyButtonEl: HTMLButtonElement | null = null;
  private currentSourceFile: TFile | null = null;
  private languageInputEl: HTMLSelectElement | null = null;
  private previewEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private translatedMarkdown = "";
  private translatedParts: TranslationOutputPart[] = [];

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
    this.translatedParts = [];
    this.copyButtonEl?.setAttr("disabled", "true");
    this.titleEl?.setText(file.path);
    this.statusEl?.setText("正在翻译中 · 0%");
    this.previewEl?.empty();
  }

  async showPartialMarkdown(file: TFile, progress: TranslationProgress): Promise<void> {
    this.ensureBuilt();
    this.currentSourceFile = file;
    this.translatedMarkdown = progress.markdown;
    this.translatedParts = progress.parts;
    if (progress.markdown) {
      this.copyButtonEl?.removeAttribute("disabled");
    }
    this.titleEl?.setText(file.path);
    this.statusEl?.setText(this.getProgressText(progress));
    await this.renderMarkdownParts(file, progress.parts);
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

  showError(message: string, file?: TFile): void {
    this.ensureBuilt();
    if (file) {
      this.currentSourceFile = file;
      this.titleEl?.setText(file.path);
    }
    this.statusEl?.setText(`翻译失败：${message}`);
    if (!this.translatedMarkdown) {
      this.previewEl?.empty();
      this.previewEl?.createDiv({
        cls: "translate-md-api-empty",
        text: message
      });
    }
  }

  async showMarkdown(file: TFile, markdown: string): Promise<void> {
    this.ensureBuilt();
    this.currentSourceFile = file;
    this.translatedMarkdown = markdown;
    this.copyButtonEl?.removeAttribute("disabled");
    this.titleEl?.setText(file.path);
    this.statusEl?.setText("翻译完成 · 100%");
    if (this.translatedParts.length > 0) {
      await this.renderMarkdownParts(file, this.translatedParts);
    } else {
      await this.renderMarkdown(file, markdown);
    }
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

  private async renderMarkdownParts(file: TFile, parts: TranslationOutputPart[]): Promise<void> {
    this.previewEl?.empty();
    if (!this.previewEl) {
      return;
    }

    for (const part of parts) {
      const partEl = this.previewEl.createDiv({ cls: "translate-md-api-part" });
      partEl.dataset.sourceEndLine = String(part.sourceEndLine);
      partEl.dataset.sourceStartLine = String(part.sourceStartLine);
      await MarkdownRenderer.render(
        this.app,
        part.markdown,
        partEl,
        file.path,
        this
      );
    }
  }

  private getProgressText(progress: TranslationProgress): string {
    if (progress.totalRequests === 0) {
      return "翻译完成 · 100%";
    }
    const percent = Math.round((progress.completedParts / Math.max(1, progress.totalParts)) * 100);
    return `正在翻译中 · ${percent}%`;
  }

  private build(): void {
    this.contentEl.empty();
    this.contentEl.addClass("translate-md-api-view");

    const toolbar = this.contentEl.createDiv({ cls: "translate-md-api-toolbar" });
    this.titleEl = toolbar.createDiv({ cls: "translate-md-api-title" });

    const language = toolbar.createDiv({ cls: "translate-md-api-language" });
    language.createEl("span", { text: "目标语言" });
    this.languageInputEl = language.createEl("select");
    fillLanguageSelect(this.languageInputEl, this.plugin.settings.targetLanguage);
    this.languageInputEl.addEventListener("change", async () => {
      const value = this.languageInputEl?.value;
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

    this.closeButtonEl = toolbar.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "隐藏翻译侧边栏" }
    });
    setIcon(this.closeButtonEl, "x");
    this.closeButtonEl.addEventListener("click", () => {
      this.plugin.hideTranslatorPane();
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

    const currentPart = findCurrentTranslatedPart(this.previewEl);
    if (currentPart) {
      const sourceStartLine = Number(currentPart.dataset.sourceStartLine);
      if (Number.isFinite(sourceStartLine)) {
        this.plugin.syncSourceToLine(this.currentSourceFile, sourceStartLine);
        return;
      }
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
      .setName("Your Own API Markdown Translator")
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
      .addDropdown((dropdown) => {
        for (const language of getTargetLanguageOptions(this.plugin.settings.targetLanguage)) {
          dropdown.addOption(language, language);
        }
        dropdown
          .setValue(this.plugin.settings.targetLanguage)
          .onChange(async (value) => {
            this.plugin.settings.targetLanguage = value || DEFAULT_SETTINGS.targetLanguage;
            await this.plugin.saveSettings();
          });
      });

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

class EmptyApiContentError extends Error {
  constructor(finishReason?: string) {
    super(
      finishReason
        ? `API 空响应，没有可用内容。finish_reason: ${finishReason}`
        : "API 空响应，没有可用内容。"
    );
    this.name = "EmptyApiContentError";
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

function normalizeApiTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((item) => normalizeApiTextContent(item)).join("");
  }

  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
  }

  return "";
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
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

function findCurrentTranslatedPart(previewEl: HTMLElement): HTMLElement | null {
  const parts = Array.from(previewEl.querySelectorAll<HTMLElement>(".translate-md-api-part"))
    .filter((part) => part.offsetHeight > 0);
  if (parts.length === 0) {
    return null;
  }

  const previewRect = previewEl.getBoundingClientRect();
  const targetTop = previewRect.top + 8;
  let bestPart = parts[0];

  for (const part of parts) {
    const rect = part.getBoundingClientRect();
    if (rect.bottom >= targetTop) {
      bestPart = part;
      break;
    }
  }

  return bestPart;
}

function scrollRenderedMarkdownToLine(root: HTMLElement, line: number): boolean {
  const scrollTarget = findBestScrollElement(root);
  if (!scrollTarget) {
    return false;
  }

  const lineElements = Array.from(root.querySelectorAll<HTMLElement>("[data-line]"));
  let target: HTMLElement | null = null;
  let targetLine = -1;

  for (const element of lineElements) {
    const elementLine = Number(element.dataset.line);
    if (!Number.isFinite(elementLine)) {
      continue;
    }
    if (elementLine <= line && elementLine >= targetLine) {
      target = element;
      targetLine = elementLine;
    }
  }

  if (!target) {
    return false;
  }

  const targetRect = target.getBoundingClientRect();
  const scrollRect = scrollTarget.getBoundingClientRect();
  scrollTarget.scrollTop += targetRect.top - scrollRect.top - 12;
  return true;
}

function fillLanguageSelect(selectEl: HTMLSelectElement, currentValue: string): void {
  while (selectEl.firstChild) {
    selectEl.removeChild(selectEl.firstChild);
  }

  for (const language of getTargetLanguageOptions(currentValue)) {
    const option = selectEl.createEl("option", { text: language });
    option.value = language;
  }
  selectEl.value = currentValue || DEFAULT_SETTINGS.targetLanguage;
}

function getTargetLanguageOptions(currentValue: string): string[] {
  const normalizedCurrentValue = currentValue.trim();
  if (!normalizedCurrentValue || TARGET_LANGUAGE_OPTIONS.includes(normalizedCurrentValue)) {
    return TARGET_LANGUAGE_OPTIONS;
  }
  return [normalizedCurrentValue, ...TARGET_LANGUAGE_OPTIONS];
}
