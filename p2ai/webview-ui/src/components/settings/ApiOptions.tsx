import { StringRequest } from "@shared/proto/cline/common"
import PROVIDERS from "@shared/providers/providers.json"
import { Mode } from "@shared/storage/types"
import { VSCodeButton, VSCodeCheckbox, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import Fuse from "fuse.js"
import { KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useInterval } from "react-use"
import styled from "styled-components"
import { normalizeApiConfiguration } from "@/components/settings/utils/providerUtils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PLATFORM_CONFIG, PlatformType } from "@/config/platform.config"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"
import { OPENROUTER_MODEL_PICKER_Z_INDEX } from "./OpenRouterModelPicker"
import { AIhubmixProvider } from "./providers/AihubmixProvider"
import { AnthropicProvider } from "./providers/AnthropicProvider"
import { AskSageProvider } from "./providers/AskSageProvider"
import { BasetenProvider } from "./providers/BasetenProvider"
import { BedrockProvider } from "./providers/BedrockProvider"
import { CerebrasProvider } from "./providers/CerebrasProvider"
import { ClaudeCodeProvider } from "./providers/ClaudeCodeProvider"
import { ClineProvider } from "./providers/ClineProvider"
import { DeepSeekProvider } from "./providers/DeepSeekProvider"
import { DifyProvider } from "./providers/DifyProvider"
import { DoubaoProvider } from "./providers/DoubaoProvider"
import { FireworksProvider } from "./providers/FireworksProvider"
import { GeminiProvider } from "./providers/GeminiProvider"
import { GroqProvider } from "./providers/GroqProvider"
import { HicapProvider } from "./providers/HicapProvider"
import { HuaweiCloudMaasProvider } from "./providers/HuaweiCloudMaasProvider"
import { HuggingFaceProvider } from "./providers/HuggingFaceProvider"
import { LiteLlmProvider } from "./providers/LiteLlmProvider"
import { LMStudioProvider } from "./providers/LMStudioProvider"
import { MinimaxProvider } from "./providers/MiniMaxProvider"
import { MistralProvider } from "./providers/MistralProvider"
import { MoonshotProvider } from "./providers/MoonshotProvider"
import { NebiusProvider } from "./providers/NebiusProvider"
import { NousResearchProvider } from "./providers/NousresearchProvider"
import { OcaProvider } from "./providers/OcaProvider"
import { OllamaProvider } from "./providers/OllamaProvider"
import { OpenAICompatibleProvider } from "./providers/OpenAICompatible"
import { OpenAINativeProvider } from "./providers/OpenAINative"
import { OpenAiCodexProvider } from "./providers/OpenAiCodexProvider"
import { OpenRouterProvider } from "./providers/OpenRouterProvider"
import { QwenCodeProvider } from "./providers/QwenCodeProvider"
import { QwenProvider } from "./providers/QwenProvider"
import { RequestyProvider } from "./providers/RequestyProvider"
import { SambanovaProvider } from "./providers/SambanovaProvider"
import { SapAiCoreProvider } from "./providers/SapAiCoreProvider"
import { TogetherProvider } from "./providers/TogetherProvider"
import { VercelAIGatewayProvider } from "./providers/VercelAIGatewayProvider"
import { VertexProvider } from "./providers/VertexProvider"
import { VSCodeLmProvider } from "./providers/VSCodeLmProvider"
import { XaiProvider } from "./providers/XaiProvider"
import { ZAiProvider } from "./providers/ZAiProvider"
import { useApiConfigurationHandlers } from "./utils/useApiConfigurationHandlers"

interface ApiOptionsProps {
	showModelOptions: boolean
	apiErrorMessage?: string
	modelIdErrorMessage?: string
	isPopup?: boolean
	currentMode: Mode
	initialModelTab?: "recommended" | "free"
}

// This is necessary to ensure dropdown opens downward, important for when this is used in popup
export const DROPDOWN_Z_INDEX = OPENROUTER_MODEL_PICKER_Z_INDEX + 2 // Higher than the OpenRouterModelPicker's and ModelSelectorTooltip's z-index

export const DropdownContainer = styled.div<{ zIndex?: number }>`
	position: relative;
	z-index: ${(props) => props.zIndex || DROPDOWN_Z_INDEX};

	// Force dropdowns to open downward
	& vscode-dropdown::part(listbox) {
		position: absolute !important;
		top: 100% !important;
		bottom: auto !important;
	}
`

type InferenceProvider = "local_runtime" | "p2ai_server" | "cloud_api"

const INFERENCE_PROVIDER_STORAGE_KEY = "p2ai.c2ai.inferenceProvider"
const INFERENCE_PROVIDER_OPTIONS: Array<{ value: InferenceProvider; label: string }> = [
	{ value: "local_runtime", label: "Local Runtime" },
	{ value: "p2ai_server", label: "P2Ai Server" },
	{ value: "cloud_api", label: "Cloud Api" },
]
const INFERENCE_PROVIDER_LABELS = Object.fromEntries(
	INFERENCE_PROVIDER_OPTIONS.map((option) => [option.value, option.label]),
) as Record<InferenceProvider, string>

type P2AiRuntimeCapItem = {
	id: string
	label: string
	available?: boolean
	reason?: string | null
}

type P2AiBackendCapItem = P2AiRuntimeCapItem & {
	runtime_id?: string
	runtimeId?: string
}

type P2AiLocalModel = {
	dependency_id?: string
	dependencyId?: string
	label?: string
	model_id?: string
	modelId?: string
	entry?: string
	available?: boolean
	reason?: string | null
}

async function callP2AiLocalRoute<TResponse>(methodName: string, request: Record<string, unknown>): Promise<TResponse> {
	return ModelsServiceClient.makeUnaryRequest(
		methodName,
		request,
		(value) => value,
		(value) => value as TResponse,
	)
}

const getStoredInferenceProvider = (): InferenceProvider => {
	if (typeof window === "undefined") {
		return "local_runtime"
	}
	const stored = window.localStorage.getItem(INFERENCE_PROVIDER_STORAGE_KEY)
	if (stored === "p2ai_server" || stored === "cloud_api") {
		return stored
	}
	return "local_runtime"
}

declare module "vscode" {
	interface LanguageModelChatSelector {
		vendor?: string
		family?: string
		version?: string
		id?: string
	}
}

const ApiOptions = ({
	showModelOptions,
	apiErrorMessage,
	modelIdErrorMessage,
	isPopup,
	currentMode,
	initialModelTab,
}: ApiOptionsProps) => {
	// Use full context state for immediate save payload
	const { apiConfiguration, remoteConfigSettings } = useExtensionState()

	const { selectedProvider } = normalizeApiConfiguration(apiConfiguration, currentMode)

	const { handleModeFieldChange } = useApiConfigurationHandlers()
	const [inferenceProvider, setInferenceProvider] = useState<InferenceProvider>(getStoredInferenceProvider)
	const [isInferenceDropdownVisible, setIsInferenceDropdownVisible] = useState(false)
	const inferenceDropdownRef = useRef<HTMLDivElement>(null)

	const [_ollamaModels, setOllamaModels] = useState<string[]>([])
	const [p2AiCapabilities, setP2AiCapabilities] = useState<{
		runtimes: P2AiRuntimeCapItem[]
		backends: P2AiBackendCapItem[]
	}>({ runtimes: [], backends: [] })
	const [p2AiModels, setP2AiModels] = useState<P2AiLocalModel[]>([])
	const [p2AiRuntimeStatus, setP2AiRuntimeStatus] = useState("")
	const [isP2AiRuntimeTesting, setIsP2AiRuntimeTesting] = useState(false)

	// Poll ollama/vscode-lm models
	const requestLocalModels = useCallback(async () => {
		if (selectedProvider === "ollama") {
			try {
				const response = await ModelsServiceClient.getOllamaModels(
					StringRequest.create({
						value: apiConfiguration?.ollamaBaseUrl || "",
					}),
				)
				if (response && response.values) {
					setOllamaModels(response.values)
				}
			} catch (error) {
				console.error("Failed to fetch Ollama models:", error)
				setOllamaModels([])
			}
		}
	}, [selectedProvider, apiConfiguration?.ollamaBaseUrl])
	useEffect(() => {
		if (selectedProvider === "ollama") {
			requestLocalModels()
		}
	}, [selectedProvider, requestLocalModels])
	useInterval(requestLocalModels, selectedProvider === "ollama" ? 2000 : null)

	const p2AiApiConfiguration = apiConfiguration as any
	const p2AiRuntime = p2AiApiConfiguration?.p2aiLocalRuntime || "llama_cpp"
	const p2AiBackend = p2AiApiConfiguration?.p2aiLocalBackend || "vulkan"
	const p2AiGpuLayers = p2AiApiConfiguration?.p2aiLocalGpuLayers || "24"
	const p2AiContextSize = p2AiApiConfiguration?.p2aiLocalContextSize || "16384"
	const p2AiMaxNewTokens = p2AiApiConfiguration?.p2aiLocalMaxNewTokens || "1024"
	const p2AiThreads = p2AiApiConfiguration?.p2aiLocalThreads || "5"
	const p2AiStreamingEnabled = String(p2AiApiConfiguration?.p2aiLocalStreamingEnabled || "false") === "true"
	const p2AiFeedbackLoopEnabled = String(p2AiApiConfiguration?.p2aiLocalFeedbackLoopEnabled || "false") === "true"
	const p2AiModelDependencyId =
		currentMode === "plan"
			? p2AiApiConfiguration?.planModeP2AiLocalModelDependencyId
			: p2AiApiConfiguration?.actModeP2AiLocalModelDependencyId
	const p2AiModelId =
		currentMode === "plan" ? p2AiApiConfiguration?.planModeP2AiLocalModelId : p2AiApiConfiguration?.actModeP2AiLocalModelId

	async function updateP2AiApiFields(updates: Record<string, unknown>) {
		await ModelsServiceClient.updateApiConfigurationPartial({
			apiConfiguration: updates,
			updateMask: Object.keys(updates),
		} as any)
	}

	function selectP2AiModel(model: P2AiLocalModel) {
		const dependencyId = model.dependency_id || model.dependencyId || ""
		const modelId = model.model_id || model.modelId || model.label || dependencyId
		if (!dependencyId) {
			return
		}
		if (currentMode === "plan") {
			updateP2AiApiFields({
				planModeP2AiLocalModelDependencyId: dependencyId,
				planModeP2AiLocalModelId: modelId,
			})
		} else {
			updateP2AiApiFields({
				actModeP2AiLocalModelDependencyId: dependencyId,
				actModeP2AiLocalModelId: modelId,
			})
		}
	}

	const requestP2AiLocalInventory = useCallback(async () => {
		if (inferenceProvider !== "local_runtime") {
			return
		}
		try {
			const capabilities = await callP2AiLocalRoute<any>("getP2AiLocalRuntimeCapabilities", {})
			setP2AiCapabilities({
				runtimes: Array.isArray(capabilities?.runtimes) ? capabilities.runtimes : [],
				backends: Array.isArray(capabilities?.backends) ? capabilities.backends : [],
			})
			const modelsResponse = await callP2AiLocalRoute<any>("getP2AiLocalModels", {
				runtime: p2AiRuntime,
				category: "llm",
				includeUnavailable: true,
			})
			const models = Array.isArray(modelsResponse?.models) ? modelsResponse.models : []
			setP2AiModels(models)
			if (!p2AiModelDependencyId && models.length > 0) {
				const preferred =
					models.find((model: P2AiLocalModel) => model.dependency_id === "p2ai/llm/gemma-4-E4B-it-GGUF") || models[0]
				selectP2AiModel(preferred)
			}
		} catch (error) {
			console.error("Failed to fetch P2AI local runtime inventory:", error)
			setP2AiCapabilities({ runtimes: [], backends: [] })
			setP2AiModels([])
		}
	}, [inferenceProvider, p2AiRuntime, p2AiModelDependencyId])

	useEffect(() => {
		requestP2AiLocalInventory()
	}, [requestP2AiLocalInventory])
	useInterval(requestP2AiLocalInventory, inferenceProvider === "local_runtime" ? 5000 : null)

	// Provider search state
	const [searchTerm, setSearchTerm] = useState("")
	const [isDropdownVisible, setIsDropdownVisible] = useState(false)
	const [selectedIndex, setSelectedIndex] = useState(-1)
	const dropdownRef = useRef<HTMLDivElement>(null)
	const itemRefs = useRef<(HTMLDivElement | null)[]>([])
	const dropdownListRef = useRef<HTMLDivElement>(null)

	const providerOptions = useMemo(() => {
		let providers = PROVIDERS.list
		// Filter by platform
		if (PLATFORM_CONFIG.type !== PlatformType.VSCODE) {
			// Don't include VS Code LM API for non-VSCode platforms
			providers = providers.filter((option) => option.value !== "vscode-lm")
		}

		// Filter by remote config if remoteConfiguredProviders is set
		const remoteProviders: string[] = remoteConfigSettings?.remoteConfiguredProviders || []
		if (remoteProviders.length > 0) {
			providers = providers.filter((option) => remoteProviders.includes(option.value))
		}

		return providers
	}, [remoteConfigSettings])

	const currentProviderLabel = useMemo(() => {
		return providerOptions.find((option) => option.value === selectedProvider)?.label || selectedProvider
	}, [providerOptions, selectedProvider])

	// Sync search term with current provider when not searching
	useEffect(() => {
		if (!isDropdownVisible) {
			setSearchTerm(currentProviderLabel)
		}
	}, [currentProviderLabel, isDropdownVisible])

	const searchableItems = useMemo(() => {
		return providerOptions.map((option) => ({
			value: option.value,
			html: option.label,
		}))
	}, [providerOptions])

	const fuse = useMemo(() => {
		return new Fuse(searchableItems, {
			keys: ["html"],
			threshold: 0.3,
			shouldSort: true,
			isCaseSensitive: false,
			ignoreLocation: false,
			includeMatches: true,
			minMatchCharLength: 1,
		})
	}, [searchableItems])

	const providerSearchResults = useMemo(() => {
		return searchTerm && searchTerm !== currentProviderLabel ? fuse.search(searchTerm)?.map((r) => r.item) : searchableItems
	}, [searchableItems, searchTerm, fuse, currentProviderLabel])

	const handleProviderChange = (newProvider: string) => {
		handleModeFieldChange({ plan: "planModeApiProvider", act: "actModeApiProvider" }, newProvider as any, currentMode)
		setIsDropdownVisible(false)
		setSelectedIndex(-1)
	}

	const handleInferenceProviderChange = (next: InferenceProvider) => {
		setInferenceProvider(next)
		setIsInferenceDropdownVisible(false)
		window.localStorage.setItem(INFERENCE_PROVIDER_STORAGE_KEY, next)
	}

	const p2AiBackendOptions = useMemo(
		() =>
			p2AiCapabilities.backends.filter((backend) => {
				const runtimeId = backend.runtime_id || backend.runtimeId
				return runtimeId === p2AiRuntime
			}),
		[p2AiCapabilities.backends, p2AiRuntime],
	)

	const testP2AiRuntime = async () => {
		setIsP2AiRuntimeTesting(true)
		setP2AiRuntimeStatus("Testing...")
		try {
			const response = await callP2AiLocalRoute<any>("testP2AiLocalRuntime", {
				runtime: p2AiRuntime,
				backend: p2AiBackend,
				modelDependencyId: p2AiModelDependencyId || "p2ai/llm/gemma-4-E4B-it-GGUF",
				modelId: p2AiModelId || "gemma-4-E4B-it-GGUF",
				gpuLayers: Number(p2AiGpuLayers || "24"),
				contextSize: Number(p2AiContextSize || "8192"),
				maxNewTokens: 8,
				threads: Number(p2AiThreads || "5"),
			})
			setP2AiRuntimeStatus(response?.ok ? `OK: ${response.text || ""}` : `Failed: ${response?.text || "no text"}`)
		} catch (error) {
			setP2AiRuntimeStatus(`Failed: ${error instanceof Error ? error.message : String(error)}`)
		} finally {
			setIsP2AiRuntimeTesting(false)
		}
	}

	const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (!isDropdownVisible) {
			return
		}

		switch (event.key) {
			case "ArrowDown":
				event.preventDefault()
				setSelectedIndex((prev) => (prev < providerSearchResults.length - 1 ? prev + 1 : prev))
				break
			case "ArrowUp":
				event.preventDefault()
				setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev))
				break
			case "Enter":
				event.preventDefault()
				if (selectedIndex >= 0 && selectedIndex < providerSearchResults.length) {
					handleProviderChange(providerSearchResults[selectedIndex].value)
				}
				break
			case "Escape":
				setIsDropdownVisible(false)
				setSelectedIndex(-1)
				setSearchTerm(currentProviderLabel)
				break
		}
	}

	// Close dropdown when clicking outside
	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
				setIsDropdownVisible(false)
				setSearchTerm(currentProviderLabel)
			}
			if (inferenceDropdownRef.current && !inferenceDropdownRef.current.contains(event.target as Node)) {
				setIsInferenceDropdownVisible(false)
			}
		}

		document.addEventListener("mousedown", handleClickOutside)
		return () => {
			document.removeEventListener("mousedown", handleClickOutside)
		}
	}, [currentProviderLabel])

	// Reset selection when search term changes
	useEffect(() => {
		setSelectedIndex(-1)
		if (dropdownListRef.current) {
			dropdownListRef.current.scrollTop = 0
		}
	}, [searchTerm])

	// Scroll selected item into view
	useEffect(() => {
		if (selectedIndex >= 0 && itemRefs.current[selectedIndex]) {
			itemRefs.current[selectedIndex]?.scrollIntoView({
				block: "nearest",
				behavior: "smooth",
			})
		}
	}, [selectedIndex])

	/*
	VSCodeDropdown has an open bug where dynamically rendered options don't auto select the provided value prop. You can see this for yourself by comparing  it with normal select/option elements, which work as expected.
	https://github.com/microsoft/vscode-webview-ui-toolkit/issues/433

	In our case, when the user switches between providers, we recalculate the selectedModelId depending on the provider, the default model for that provider, and a modelId that the user may have selected. Unfortunately, the VSCodeDropdown component wouldn't select this calculated value, and would default to the first "Select a model..." option instead, which makes it seem like the model was cleared out when it wasn't.

	As a workaround, we create separate instances of the dropdown for each provider, and then conditionally render the one that matches the current provider.
	*/

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: isPopup ? -10 : 0 }}>
			<style>
				{`
				.provider-item-highlight {
					background-color: var(--vscode-editor-findMatchHighlightBackground);
					color: inherit;
				}
				`}
			</style>
			<DropdownContainer className="dropdown-container" zIndex={DROPDOWN_Z_INDEX + 20}>
				<label htmlFor="inference-provider">
					<span style={{ fontWeight: 500 }}>Inference Provider</span>
				</label>
				<ProviderDropdownWrapper ref={inferenceDropdownRef}>
					<InferenceDropdownButton
						aria-expanded={isInferenceDropdownVisible}
						aria-haspopup="listbox"
						data-testid="inference-provider-dropdown"
						id="inference-provider"
						onClick={() => setIsInferenceDropdownVisible(true)}
						type="button">
						<span>{INFERENCE_PROVIDER_LABELS[inferenceProvider]}</span>
						<i className="codicon codicon-chevron-down" />
					</InferenceDropdownButton>
					{isInferenceDropdownVisible && (
						<InferenceDropdownList role="listbox">
							{INFERENCE_PROVIDER_OPTIONS.map((option) => (
								<ProviderDropdownItem
									data-testid={`inference-provider-option-${option.value.replace("_", "-")}`}
									isSelected={option.value === inferenceProvider}
									key={option.value}
									onClick={() => handleInferenceProviderChange(option.value)}
									onMouseDown={(event) => event.preventDefault()}
									role="option">
									<span>{option.label}</span>
								</ProviderDropdownItem>
							))}
						</InferenceDropdownList>
					)}
				</ProviderDropdownWrapper>
			</DropdownContainer>

			{inferenceProvider === "local_runtime" && (
				<P2AiRuntimePanel data-testid="p2ai-local-runtime-settings">
					<P2AiRuntimeRow>
						<label htmlFor="p2ai-local-runtime">Runtime</label>
						<NativeSelect
							data-testid="p2ai-local-runtime"
							id="p2ai-local-runtime"
							value={p2AiRuntime}
							onChange={(event) => updateP2AiApiFields({ p2aiLocalRuntime: event.target.value })}>
							{(p2AiCapabilities.runtimes.length
								? p2AiCapabilities.runtimes
								: [{ id: "llama_cpp", label: "llama.cpp", available: true }]
							).map((runtime) => (
								<option disabled={runtime.available === false} key={runtime.id} value={runtime.id}>
									{runtime.label}
								</option>
							))}
						</NativeSelect>
					</P2AiRuntimeRow>

					<P2AiRuntimeRow>
						<label htmlFor="p2ai-local-backend">Backend / EP</label>
						<NativeSelect
							data-testid="p2ai-local-backend"
							id="p2ai-local-backend"
							value={p2AiBackend}
							onChange={(event) => updateP2AiApiFields({ p2aiLocalBackend: event.target.value })}>
							{(p2AiBackendOptions.length
								? p2AiBackendOptions
								: [{ id: "vulkan", label: "Vulkan", available: true }]
							).map((backend) => (
								<option
									disabled={backend.available === false}
									key={`${backend.runtime_id || backend.runtimeId}-${backend.id}`}
									value={backend.id}>
									{backend.label}
								</option>
							))}
						</NativeSelect>
					</P2AiRuntimeRow>

					<P2AiRuntimeRow>
						<label htmlFor="p2ai-local-model">Model</label>
						<NativeSelect
							data-testid="p2ai-local-model"
							id="p2ai-local-model"
							value={p2AiModelDependencyId || ""}
							onChange={(event) => {
								const model = p2AiModels.find(
									(item) => (item.dependency_id || item.dependencyId) === event.target.value,
								)
								if (model) selectP2AiModel(model)
							}}>
							{p2AiModels.map((model) => {
								const dependencyId = model.dependency_id || model.dependencyId || ""
								return (
									<option disabled={model.available === false} key={dependencyId} value={dependencyId}>
										{model.label || dependencyId}
									</option>
								)
							})}
						</NativeSelect>
					</P2AiRuntimeRow>

					{p2AiRuntime === "llama_cpp" && (p2AiBackend === "vulkan" || p2AiBackend === "cuda") && (
						<VSCodeTextField
							data-testid="p2ai-local-gpu-layers"
							onInput={(event) =>
								updateP2AiApiFields({ p2aiLocalGpuLayers: (event.target as HTMLInputElement).value })
							}
							style={{ width: "100%" }}
							value={p2AiGpuLayers}>
							GPU layers
						</VSCodeTextField>
					)}

					<P2AiRuntimeGrid>
						<VSCodeTextField
							data-testid="p2ai-local-context-size"
							onInput={(event) =>
								updateP2AiApiFields({ p2aiLocalContextSize: (event.target as HTMLInputElement).value })
							}
							style={{ width: "100%" }}
							value={p2AiContextSize}>
							Context
						</VSCodeTextField>
						<VSCodeTextField
							data-testid="p2ai-local-max-new-tokens"
							onInput={(event) =>
								updateP2AiApiFields({ p2aiLocalMaxNewTokens: (event.target as HTMLInputElement).value })
							}
							style={{ width: "100%" }}
							value={p2AiMaxNewTokens}>
							Max output
						</VSCodeTextField>
					</P2AiRuntimeGrid>

					<P2AiRuntimeToggleRow>
						<VSCodeCheckbox
							checked={p2AiStreamingEnabled}
							data-testid="p2ai-local-streaming-enabled"
							onChange={(event) =>
								updateP2AiApiFields({
									p2aiLocalStreamingEnabled: (event.target as HTMLInputElement).checked ? "true" : "false",
								})
							}>
							Streaming
						</VSCodeCheckbox>
					</P2AiRuntimeToggleRow>

					<P2AiRuntimeToggleRow>
						<VSCodeCheckbox
							checked={p2AiFeedbackLoopEnabled}
							data-testid="p2ai-local-feedback-loop-enabled"
							onChange={(event) =>
								updateP2AiApiFields({
									p2aiLocalFeedbackLoopEnabled: (event.target as HTMLInputElement).checked,
								})
							}>
							Feedback memory
						</VSCodeCheckbox>
					</P2AiRuntimeToggleRow>

					<VSCodeButton data-testid="p2ai-local-test-runtime" disabled={isP2AiRuntimeTesting} onClick={testP2AiRuntime}>
						Test runtime
					</VSCodeButton>
					{p2AiRuntimeStatus && <P2AiRuntimeStatus>{p2AiRuntimeStatus}</P2AiRuntimeStatus>}
				</P2AiRuntimePanel>
			)}

			{inferenceProvider === "p2ai_server" && (
				<P2AiRuntimePanel data-testid="p2ai-server-settings">
					<VSCodeTextField data-testid="p2ai-server-url" placeholder="http://127.0.0.1:17333" style={{ width: "100%" }}>
						P2Ai Server URL
					</VSCodeTextField>
				</P2AiRuntimePanel>
			)}

			{inferenceProvider === "cloud_api" && (
				<>
					<DropdownContainer className="dropdown-container">
						{remoteConfigSettings?.remoteConfiguredProviders &&
						remoteConfigSettings.remoteConfiguredProviders.length > 0 ? (
							<Tooltip>
								<TooltipTrigger>
									<div className="flex items-center gap-2 mb-1">
										<label htmlFor="api-provider">
											<span style={{ fontWeight: 500 }}>API Provider</span>
										</label>
										<i className="codicon codicon-lock text-description text-sm" />
									</div>
								</TooltipTrigger>
								<TooltipContent>
									Provider options are managed by your organization's remote configuration
								</TooltipContent>
							</Tooltip>
						) : (
							<label htmlFor="api-provider">
								<span style={{ fontWeight: 500 }}>API Provider</span>
							</label>
						)}
						<ProviderDropdownWrapper ref={dropdownRef}>
							<VSCodeTextField
								data-testid="provider-selector-input"
								id="api-provider"
								onFocus={() => {
									setIsDropdownVisible(true)
									setSearchTerm("")
								}}
								onInput={(e) => {
									setSearchTerm((e.target as HTMLInputElement)?.value || "")
									setIsDropdownVisible(true)
								}}
								onKeyDown={handleKeyDown}
								placeholder="Search and select provider..."
								role="combobox"
								style={{
									width: "100%",
									zIndex: DROPDOWN_Z_INDEX,
									position: "relative",
									minWidth: 130,
								}}
								value={searchTerm}>
								{searchTerm && searchTerm !== currentProviderLabel && (
									<div
										aria-label="Clear search"
										className="input-icon-button codicon codicon-close"
										onClick={() => {
											setSearchTerm("")
											setIsDropdownVisible(true)
										}}
										slot="end"
										style={{
											display: "flex",
											justifyContent: "center",
											alignItems: "center",
											height: "100%",
										}}
									/>
								)}
							</VSCodeTextField>
							{isDropdownVisible && (
								<ProviderDropdownList ref={dropdownListRef} role="listbox">
									{providerSearchResults.map((item, index) => (
										<ProviderDropdownItem
											data-testid={`provider-option-${item.value}`}
											isSelected={index === selectedIndex}
											key={item.value}
											onClick={() => handleProviderChange(item.value)}
											onMouseEnter={() => setSelectedIndex(index)}
											ref={(el) => {
												itemRefs.current[index] = el
											}}
											role="option">
											<span>{item.html}</span>
										</ProviderDropdownItem>
									))}
								</ProviderDropdownList>
							)}
						</ProviderDropdownWrapper>
					</DropdownContainer>

					{apiConfiguration && selectedProvider === "hicap" && (
						<HicapProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "cline" && (
						<ClineProvider
							currentMode={currentMode}
							initialModelTab={initialModelTab}
							isPopup={isPopup}
							showModelOptions={showModelOptions}
						/>
					)}

					{apiConfiguration && selectedProvider === "asksage" && (
						<AskSageProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "anthropic" && (
						<AnthropicProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "claude-code" && (
						<ClaudeCodeProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "openai-native" && (
						<OpenAINativeProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "openai-codex" && (
						<OpenAiCodexProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "qwen" && (
						<QwenProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "qwen-code" && (
						<QwenCodeProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "doubao" && (
						<DoubaoProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "mistral" && (
						<MistralProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "openrouter" && (
						<OpenRouterProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "deepseek" && (
						<DeepSeekProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "together" && (
						<TogetherProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "openai" && (
						<OpenAICompatibleProvider
							currentMode={currentMode}
							isPopup={isPopup}
							showModelOptions={showModelOptions}
						/>
					)}

					{apiConfiguration && selectedProvider === "vercel-ai-gateway" && (
						<VercelAIGatewayProvider
							currentMode={currentMode}
							isPopup={isPopup}
							showModelOptions={showModelOptions}
						/>
					)}

					{apiConfiguration && selectedProvider === "sambanova" && (
						<SambanovaProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "bedrock" && (
						<BedrockProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "vertex" && (
						<VertexProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "gemini" && (
						<GeminiProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "requesty" && (
						<RequestyProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "fireworks" && (
						<FireworksProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "vscode-lm" && <VSCodeLmProvider currentMode={currentMode} />}

					{apiConfiguration && selectedProvider === "groq" && (
						<GroqProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}
					{apiConfiguration && selectedProvider === "baseten" && (
						<BasetenProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}
					{apiConfiguration && selectedProvider === "litellm" && (
						<LiteLlmProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "lmstudio" && (
						<LMStudioProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "ollama" && (
						<OllamaProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "moonshot" && (
						<MoonshotProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "huggingface" && (
						<HuggingFaceProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "nebius" && (
						<NebiusProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "xai" && (
						<XaiProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "cerebras" && (
						<CerebrasProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "sapaicore" && (
						<SapAiCoreProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "huawei-cloud-maas" && (
						<HuaweiCloudMaasProvider
							currentMode={currentMode}
							isPopup={isPopup}
							showModelOptions={showModelOptions}
						/>
					)}

					{apiConfiguration && selectedProvider === "dify" && (
						<DifyProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "zai" && (
						<ZAiProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "minimax" && (
						<MinimaxProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "nousResearch" && (
						<NousResearchProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiConfiguration && selectedProvider === "oca" && (
						<OcaProvider currentMode={currentMode} isPopup={isPopup} />
					)}

					{apiConfiguration && selectedProvider === "aihubmix" && (
						<AIhubmixProvider currentMode={currentMode} isPopup={isPopup} showModelOptions={showModelOptions} />
					)}

					{apiErrorMessage && (
						<p
							style={{
								margin: "-10px 0 4px 0",
								fontSize: 12,
								color: "var(--vscode-errorForeground)",
							}}>
							{apiErrorMessage}
						</p>
					)}
					{modelIdErrorMessage && (
						<p
							style={{
								margin: "-10px 0 4px 0",
								fontSize: 12,
								color: "var(--vscode-errorForeground)",
							}}>
							{modelIdErrorMessage}
						</p>
					)}
				</>
			)}
		</div>
	)
}

export default ApiOptions

const ProviderDropdownWrapper = styled.div`
	position: relative;
	width: 100%;
`

const InferenceDropdownButton = styled.button`
	align-items: center;
	background: var(--vscode-dropdown-background);
	border: 1px solid var(--vscode-input-border);
	border-radius: 2px;
	color: var(--vscode-dropdown-foreground);
	cursor: pointer;
	display: flex;
	font: inherit;
	height: 31px;
	justify-content: space-between;
	margin: 0;
	padding: 4px 8px;
	text-align: left;
	width: 100%;

	&:focus {
		border-color: var(--vscode-focusBorder);
		outline: 1px solid var(--vscode-focusBorder);
		outline-offset: -1px;
	}

	&:hover {
		background: var(--vscode-list-hoverBackground);
	}
`

const ProviderDropdownList = styled.div`
	position: absolute;
	top: calc(100% - 3px);
	left: 0;
	width: calc(100% - 2px);
	max-height: 200px;
	overflow-y: auto;
	background-color: var(--vscode-dropdown-background);
	border: 1px solid var(--vscode-list-activeSelectionBackground);
	z-index: ${DROPDOWN_Z_INDEX - 1};
	border-bottom-left-radius: 3px;
	border-bottom-right-radius: 3px;
`

const InferenceDropdownList = styled(ProviderDropdownList)`
	background-color: var(--vscode-dropdown-background);
	box-shadow: 0 4px 10px var(--vscode-widget-shadow);
	top: calc(100% - 1px);
	z-index: ${DROPDOWN_Z_INDEX + 10};
`

const ProviderDropdownItem = styled.div<{ isSelected: boolean }>`
	padding: 5px 10px;
	cursor: pointer;
	word-break: break-all;
	white-space: normal;

	background-color: ${({ isSelected }) =>
		isSelected ? "var(--vscode-list-activeSelectionBackground)" : "var(--vscode-dropdown-background)"};
	color: ${({ isSelected }) => (isSelected ? "var(--vscode-list-activeSelectionForeground)" : "inherit")};

	&:hover {
		background-color: var(--vscode-list-activeSelectionBackground);
		color: var(--vscode-list-activeSelectionForeground);
	}
`

const P2AiRuntimePanel = styled.div`
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: 2px 0 8px;
`

const P2AiRuntimeRow = styled.div`
	display: flex;
	flex-direction: column;
	gap: 4px;

	label {
		font-weight: 500;
	}
`

const P2AiRuntimeGrid = styled.div`
	display: grid;
	grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
	gap: 8px;
`

const P2AiRuntimeToggleRow = styled.div`
	display: flex;
	align-items: center;
	min-height: 26px;
`

const NativeSelect = styled.select`
	background: var(--vscode-dropdown-background);
	border: 1px solid var(--vscode-input-border);
	border-radius: 2px;
	color: var(--vscode-dropdown-foreground);
	font: inherit;
	height: 31px;
	min-width: 0;
	padding: 3px 8px;
	width: 100%;

	&:focus {
		border-color: var(--vscode-focusBorder);
		outline: 1px solid var(--vscode-focusBorder);
		outline-offset: -1px;
	}
`

const P2AiRuntimeStatus = styled.div`
	color: var(--vscode-descriptionForeground);
	font-size: 12px;
	line-height: 18px;
`
