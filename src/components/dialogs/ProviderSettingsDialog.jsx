import { X } from "lucide-react";

export function ProviderSettingsDialog({ draft, error, onChange, onClose, onSubmit, saving }) {
  function patchSection(section, patch) {
    onChange((current) => ({
      ...current,
      [section]: { ...current[section], ...patch },
    }));
  }

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <form
        className="provider-settings-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="dialog-header">
          <div>
            <h2>服务配置</h2>
            <p>密钥只保存在本机，不会显示在页面或导出备份中</p>
          </div>
          <button
            aria-label="关闭配置"
            className="icon-button"
            disabled={saving}
            onClick={onClose}
            title="关闭"
            type="button"
          >
            <X size={18} />
          </button>
        </div>

        <div className="provider-settings-body">
          {error ? <div className="settings-error">{error}</div> : null}
          {!draft ? <div className="settings-loading">正在读取配置...</div> : (
            <>
              <section className="form-section provider-section">
                <div className="provider-section-heading">
                  <div>
                    <h3>语音识别</h3>
                    <p>火山引擎流式语音识别</p>
                  </div>
                  <span className={`provider-state ${draft.asr.configured ? "ready" : "warn"}`}>
                    {draft.asr.configured ? "已配置" : "待配置"}
                  </span>
                </div>
                <label>
                  <span>API Key</span>
                  <input
                    autoComplete="new-password"
                    onChange={(event) => patchSection("asr", { apiKey: event.target.value })}
                    placeholder={draft.asr.apiKeyConfigured ? "已配置，留空则不修改" : "请输入火山引擎 API Key"}
                    type="password"
                    value={draft.asr.apiKey}
                  />
                </label>
                {draft.asr.apiKeyStored ? (
                  <label className="checkbox-field settings-clear-field">
                    <input
                      checked={draft.asr.clearApiKey}
                      onChange={(event) => patchSection("asr", { clearApiKey: event.target.checked })}
                      type="checkbox"
                    />
                    <span>删除工作台保存的 API Key</span>
                  </label>
                ) : null}
                <details className="settings-details">
                  <summary>旧版火山引擎凭证</summary>
                  <div className="settings-details-body form-grid form-grid-jd">
                    <label>
                      <span>App Key</span>
                      <input
                        autoComplete="new-password"
                        onChange={(event) => patchSection("asr", { appKey: event.target.value })}
                        placeholder={draft.asr.legacyCredentialsConfigured ? "已配置，留空则不修改" : "可选"}
                        type="password"
                        value={draft.asr.appKey}
                      />
                    </label>
                    <label>
                      <span>Access Key</span>
                      <input
                        autoComplete="new-password"
                        onChange={(event) => patchSection("asr", { accessKey: event.target.value })}
                        placeholder={draft.asr.legacyCredentialsConfigured ? "已配置，留空则不修改" : "可选"}
                        type="password"
                        value={draft.asr.accessKey}
                      />
                    </label>
                  </div>
                  {draft.asr.legacyCredentialsStored ? (
                    <label className="checkbox-field settings-clear-field">
                      <input
                        checked={draft.asr.clearLegacyCredentials}
                        onChange={(event) => patchSection("asr", { clearLegacyCredentials: event.target.checked })}
                        type="checkbox"
                      />
                      <span>删除工作台保存的旧版凭证</span>
                    </label>
                  ) : null}
                </details>
                <details className="settings-details">
                  <summary>高级设置</summary>
                  <div className="settings-details-body">
                    <label>
                      <span>资源 ID</span>
                      <input
                        onChange={(event) => patchSection("asr", { resourceId: event.target.value })}
                        value={draft.asr.resourceId}
                      />
                    </label>
                    <label>
                      <span>WebSocket 地址</span>
                      <input
                        onChange={(event) => patchSection("asr", { url: event.target.value })}
                        value={draft.asr.url}
                      />
                    </label>
                  </div>
                </details>
              </section>

              <section className="form-section provider-section">
                <div className="provider-section-heading">
                  <div>
                    <h3>大模型</h3>
                    <p>DeepSeek 或其他兼容 OpenAI 的服务</p>
                  </div>
                  <span className={`provider-state ${draft.llm.configured ? "ready" : "warn"}`}>
                    {draft.llm.configured ? "已配置" : "待配置"}
                  </span>
                </div>
                <label>
                  <span>API Key</span>
                  <input
                    autoComplete="new-password"
                    onChange={(event) => patchSection("llm", { apiKey: event.target.value })}
                    placeholder={draft.llm.apiKeyConfigured ? "已配置，留空则不修改" : "请输入大模型 API Key"}
                    type="password"
                    value={draft.llm.apiKey}
                  />
                </label>
                {draft.llm.apiKeyStored ? (
                  <label className="checkbox-field settings-clear-field">
                    <input
                      checked={draft.llm.clearApiKey}
                      onChange={(event) => patchSection("llm", { clearApiKey: event.target.checked })}
                      type="checkbox"
                    />
                    <span>删除工作台保存的 API Key</span>
                  </label>
                ) : null}
                <div className="form-grid form-grid-jd settings-model-grid">
                  <label>
                    <span>API 地址</span>
                    <input
                      onChange={(event) => patchSection("llm", { baseUrl: event.target.value })}
                      value={draft.llm.baseUrl}
                    />
                  </label>
                  <label>
                    <span>模型名称</span>
                    <input
                      onChange={(event) => patchSection("llm", { model: event.target.value })}
                      value={draft.llm.model}
                    />
                  </label>
                </div>
                <details className="settings-details">
                  <summary>高级设置</summary>
                  <div className="settings-details-body">
                    <label>
                      <span>请求超时（毫秒）</span>
                      <input
                        max="300000"
                        min="1000"
                        onChange={(event) => patchSection("llm", { timeoutMs: event.target.value })}
                        step="1000"
                        type="number"
                        value={draft.llm.timeoutMs}
                      />
                    </label>
                  </div>
                </details>
              </section>
            </>
          )}
        </div>

        <div className="dialog-footer">
          <button disabled={saving} onClick={onClose} type="button">取消</button>
          <button className="primary" disabled={!draft || saving} type="submit">
            {saving ? "保存中..." : "保存配置"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function createProviderSettingsDraft(settings) {
  return {
    asr: {
      ...settings.asr,
      apiKey: "",
      appKey: "",
      accessKey: "",
      clearApiKey: false,
      clearLegacyCredentials: false,
    },
    llm: {
      ...settings.llm,
      apiKey: "",
      clearApiKey: false,
    },
  };
}
