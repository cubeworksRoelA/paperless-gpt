import React, { useState, useEffect, useCallback } from 'react';

interface OllamaModel {
  name: string;
  model: string;
  size: number;
  details: {
    parameter_size: string;
    quantization_level: string;
    family: string;
    families: string[];
  };
}

interface LlmConfig {
  llm_provider: string;
  llm_model: string;
  vision_llm_provider: string;
  vision_llm_model: string;
  ollama_host: string;
}

const PROVIDERS = ['ollama', 'openai', 'anthropic', 'mistral', 'googleai'];

const LlmConfigEditor: React.FC = () => {
  const [config, setConfig] = useState<LlmConfig | null>(null);
  const [initialConfig, setInitialConfig] = useState<LlmConfig | null>(null);
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [ollamaStatus, setOllamaStatus] = useState<'connected' | 'error' | 'checking'>('checking');
  const [ollamaError, setOllamaError] = useState<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch('./api/llm-config');
      if (!res.ok) throw new Error('Failed to fetch LLM config');
      const data: LlmConfig = await res.json();
      setConfig(data);
      setInitialConfig(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchOllamaModels = useCallback(async () => {
    setOllamaStatus('checking');
    setOllamaError(null);
    try {
      const res = await fetch('./api/ollama-models');
      if (!res.ok) {
        const errData = await res.json();
        setOllamaStatus('error');
        setOllamaError(errData.error || 'Failed to connect');
        setOllamaModels([]);
        return;
      }
      const data = await res.json();
      setOllamaModels(data.models || []);
      setOllamaStatus('connected');
    } catch {
      setOllamaStatus('error');
      setOllamaError('Failed to reach Ollama');
      setOllamaModels([]);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
    fetchOllamaModels();
  }, [fetchConfig, fetchOllamaModels]);

  useEffect(() => {
    if (initialConfig && config) {
      setIsDirty(JSON.stringify(config) !== JSON.stringify(initialConfig));
    }
  }, [config, initialConfig]);

  const handleSave = useCallback(async () => {
    if (!isDirty || !config) return;
    setIsSaving(true);
    setError(null);
    try {
      const res = await fetch('./api/llm-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to save LLM config');
      }
      setInitialConfig(config);
      setSuccessMessage('LLM configuration saved successfully!');
      setTimeout(() => setSuccessMessage(null), 3000);
      // Refresh models after saving (host may have changed)
      fetchOllamaModels();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
      setTimeout(() => setError(null), 5000);
    } finally {
      setIsSaving(false);
    }
  }, [config, isDirty, fetchOllamaModels]);

  const handleChange = (key: keyof LlmConfig, value: string) => {
    setConfig((prev) => (prev ? { ...prev, [key]: value } : null));
  };

  const formatSize = (bytes: number) => {
    const gb = bytes / (1024 * 1024 * 1024);
    return gb.toFixed(1) + ' GB';
  };

  if (isLoading) return <div className="p-6">Loading...</div>;
  if (!config) return <div className="p-6">No LLM configuration found.</div>;

  const isOllamaLlm = config.llm_provider === 'ollama';
  const isOllamaVision = config.vision_llm_provider === 'ollama';
  const showOllamaHost = isOllamaLlm || isOllamaVision;

  return (
    <div className="p-6 bg-gray-100 dark:bg-gray-900">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-gray-800 dark:text-gray-200">LLM Configuration</h1>
        <button
          onClick={fetchOllamaModels}
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
        >
          Refresh Models
        </button>
      </div>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative mb-4" role="alert">
          <span>{error}</span>
        </div>
      )}

      {successMessage && (
        <div className="fixed bottom-4 right-4 bg-green-500 text-white px-6 py-3 rounded-lg shadow-lg transition-transform transform animate-bounce" role="alert">
          <span>{successMessage}</span>
        </div>
      )}

      {/* Ollama Host */}
      {showOllamaHost && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xl font-semibold text-gray-700 dark:text-gray-300">Ollama Connection</h2>
            <div className="flex items-center gap-2">
              {ollamaStatus === 'checking' && (
                <span className="flex items-center text-xs text-gray-400">
                  <span className="w-2 h-2 rounded-full bg-gray-400 animate-pulse mr-1" />
                  Checking...
                </span>
              )}
              {ollamaStatus === 'connected' && (
                <span className="flex items-center text-xs text-green-600 dark:text-green-400">
                  <span className="w-2 h-2 rounded-full bg-green-500 mr-1" />
                  Connected ({ollamaModels.length} model{ollamaModels.length !== 1 ? 's' : ''})
                </span>
              )}
              {ollamaStatus === 'error' && (
                <span className="flex items-center text-xs text-red-600 dark:text-red-400">
                  <span className="w-2 h-2 rounded-full bg-red-500 mr-1" />
                  Unreachable
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={config.ollama_host}
              onChange={(e) => handleChange('ollama_host', e.target.value)}
              className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 font-mono text-sm"
              placeholder="http://127.0.0.1:11434"
            />
            <button
              onClick={() => {
                // Save first to update the host, then test connection
                if (isDirty) {
                  handleSave();
                } else {
                  fetchOllamaModels();
                }
              }}
              className="px-4 py-2 bg-gray-200 hover:bg-gray-300 dark:bg-gray-600 dark:hover:bg-gray-500 text-gray-700 dark:text-gray-200 rounded-md text-sm font-medium transition"
            >
              Test
            </button>
          </div>
          {ollamaStatus === 'error' && ollamaError && (
            <div className="mt-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30 rounded p-2">
              {ollamaError}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* LLM Provider */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <h2 className="text-xl font-semibold mb-4 text-gray-700 dark:text-gray-300">Text LLM</h2>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Provider</label>
            <select
              value={config.llm_provider}
              onChange={(e) => handleChange('llm_provider', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div className="mb-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Model</label>
            {isOllamaLlm && ollamaModels.length > 0 ? (
              <select
                value={config.llm_model}
                onChange={(e) => handleChange('llm_model', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              >
                {ollamaModels.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name} ({m.details.parameter_size}, {formatSize(m.size)})
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={config.llm_model}
                onChange={(e) => handleChange('llm_model', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                placeholder="e.g., gpt-4o, claude-sonnet-4-5"
              />
            )}
          </div>
        </div>

        {/* Vision LLM Provider */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <h2 className="text-xl font-semibold mb-4 text-gray-700 dark:text-gray-300">Vision LLM (OCR)</h2>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Provider</label>
            <select
              value={config.vision_llm_provider}
              onChange={(e) => handleChange('vision_llm_provider', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div className="mb-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Model</label>
            {isOllamaVision && ollamaModels.length > 0 ? (
              <select
                value={config.vision_llm_model}
                onChange={(e) => handleChange('vision_llm_model', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              >
                {ollamaModels.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name} ({m.details.parameter_size}, {formatSize(m.size)})
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={config.vision_llm_model}
                onChange={(e) => handleChange('vision_llm_model', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                placeholder="e.g., gpt-4o, claude-sonnet-4-5"
              />
            )}
          </div>
        </div>
      </div>

      <div className="flex justify-end mt-6">
        <button
          onClick={handleSave}
          disabled={!isDirty || isSaving}
          aria-busy={isSaving}
          className={`px-6 py-2 rounded-md font-semibold focus:outline-none focus:ring-2 focus:ring-offset-2 transition-transform transform ${
            isSaving
              ? 'bg-blue-400 text-white cursor-not-allowed'
              : 'bg-blue-600 text-white hover:bg-blue-700 hover:scale-105 focus:ring-blue-500'
          } ${!isDirty && !isSaving ? 'disabled:bg-gray-400 disabled:cursor-not-allowed' : ''}`}
        >
          {isSaving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
};

export default LlmConfigEditor;
