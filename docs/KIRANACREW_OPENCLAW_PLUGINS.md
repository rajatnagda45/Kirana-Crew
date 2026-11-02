# OpenClaw plugins (inventory for KiranaCrew / KiranaCrew)

OpenClaw 2026.10.7. Captured 2026-11-01 from `openclaw plugins list --json`: 67 plugins, 42 were enabled.
To reduce gateway memory, only the plugins this project needs stay on. Everything else is listed here so it can be enabled later.

## Kept on, and why

| Plugin            | Reason                                                              |
| ----------------- | ------------------------------------------------------------------- |
| `openai`          | Model provider for all KiranaCrew agents (openai/gpt-5.4-mini).     |
| `codex`           | Agent turn harness (codex app-server) and the web_search provider.  |
| `browser`         | browser tool used by the researcher manifest.                       |
| `web-readability` | Readable-text extraction behind web_fetch.                          |
| `memory-core`     | Core memory search tool.                                            |
| `anthropic`       | Has its own entry in openclaw.json (kept because it is configured). |

## Enable a plugin later

```bash
openclaw plugins enable <id> [more-ids]   # edits ~/.openclaw/openclaw.json
openclaw plugins inspect <id>             # what it provides (tools, providers, harnesses)
# then restart the gateway (openclaw gateway run) and restart KiranaCrew after it is up
```

Full restore of the previous configuration: copy `~/.openclaw/openclaw.json.bak-before-plugin-trim-20261101` back to `~/.openclaw/openclaw.json` and restart the gateway.

## Model and inference providers

| Plugin              | State now         | What it does                                                                                       |
| ------------------- | ----------------- | -------------------------------------------------------------------------------------------------- |
| `agentsapi`         | off (default)     | OpenAI Agents API harness with hosted or self-hosted sessions.                                     |
| `alibaba`           | disabled (was on) | OpenClaw Alibaba Model Studio video provider plugin                                                |
| `anthropic`         | **kept on**       | Anthropic models, Claude CLI, and native Claude session catalog.                                   |
| `apple-fm`          | off (default)     | On-device Apple Intelligence inference for lightweight setup and short tasks.                      |
| `clawrouter`        | disabled (was on) | OpenClaw ClawRouter plugin                                                                         |
| `copilot-proxy`     | disabled (was on) | OpenClaw Copilot Proxy provider plugin                                                             |
| `crabbox`           | off (default)     | Cloud worker provider and lease-backed sandbox backend for the Crabbox CLI.                        |
| `deepgram`          | disabled (was on) | Deepgram audio transcription with Nova and Flux models, plus realtime speech recognition.          |
| `document-extract`  | disabled (was on) | Extract text and fallback page images from local document attachments.                             |
| `fal`               | disabled (was on) | OpenClaw fal provider plugin                                                                       |
| `github-copilot`    | disabled (was on) | OpenClaw GitHub Copilot provider plugin                                                            |
| `huggingface`       | disabled (was on) | OpenClaw Hugging Face provider plugin                                                              |
| `kie`               | disabled (was on) | OpenClaw Kie AI video provider plugin                                                              |
| `litellm`           | disabled (was on) | OpenClaw LiteLLM provider plugin                                                                   |
| `lmstudio`          | disabled (was on) | OpenClaw LM Studio provider plugin                                                                 |
| `microsoft-foundry` | disabled (was on) | OpenClaw Microsoft Foundry provider plugin                                                         |
| `minimax`           | disabled (was on) | OpenClaw MiniMax provider and OAuth plugin                                                         |
| `nvidia`            | disabled (was on) | OpenClaw NVIDIA provider plugin                                                                    |
| `ollama`            | disabled (was on) | OpenClaw Ollama provider plugin                                                                    |
| `openai`            | **kept on**       | OpenClaw OpenAI provider plugins                                                                   |
| `opencode-go`       | disabled (was on) | OpenClaw OpenCode Go provider plugin                                                               |
| `openrouter`        | disabled (was on) | OpenClaw OpenRouter provider plugin                                                                |
| `runway`            | disabled (was on) | OpenClaw Runway video provider plugin                                                              |
| `senseaudio`        | disabled (was on) | OpenClaw SenseAudio media-understanding provider                                                   |
| `sglang`            | disabled (was on) | OpenClaw SGLang provider plugin                                                                    |
| `together`          | disabled (was on) | OpenClaw Together provider plugin                                                                  |
| `vault`             | off (default)     | HashiCorp Vault SecretRef provider integration.                                                    |
| `vllm`              | disabled (was on) | OpenClaw vLLM provider plugin                                                                      |
| `xai`               | disabled (was on) | xAI provider for Grok models, Grok web and X search, code execution, speech, and media generation. |

## Speech, voice and audio

| Plugin          | State now         | What it does                                                                      |
| --------------- | ----------------- | --------------------------------------------------------------------------------- |
| `azure-speech`  | disabled (was on) | Azure AI Speech text-to-speech (MP3, native Ogg/Opus voice notes, PCM telephony). |
| `elevenlabs`    | disabled (was on) | OpenClaw ElevenLabs speech plugin                                                 |
| `microsoft`     | disabled (was on) | OpenClaw Microsoft speech plugin                                                  |
| `talk-voice`    | disabled (was on) | Manage Talk voice selection (list/set).                                           |
| `tts-local-cli` | disabled (was on) | OpenClaw local CLI TTS plugin                                                     |

## Channels and messaging

| Plugin     | State now     | What it does                                                                               |
| ---------- | ------------- | ------------------------------------------------------------------------------------------ |
| `a2a`      | off (default) | A2A v1.0 Agent-to-Agent protocol channel plugin.                                           |
| `imap`     | off (default) | Watch IMAP mailboxes and dispatch authenticated incoming email to isolated agent sessions. |
| `reef`     | off (default) | Guarded end-to-end encrypted claw channel                                                  |
| `telegram` | off (default) | OpenClaw Telegram channel plugin.                                                          |
| `x`        | off (default) | Allowlisted X mentions and public replies                                                  |

## Devices, desktop and nodes

| Plugin          | State now         | What it does                                                                                                                                                         |
| --------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bonjour`       | off (default)     | Advertise the local OpenClaw gateway over Bonjour/mDNS.                                                                                                              |
| `canvas`        | disabled (was on) | Presents hosted widget documents on paired macOS panels.                                                                                                             |
| `cua-computer`  | disabled (was on) | Experimental CUA Driver computer control for macOS, Windows, and Linux node hosts.                                                                                   |
| `device-pair`   | disabled (was on) | Generate setup codes and approve device pairing requests.                                                                                                            |
| `file-transfer` | disabled (was on) | Fetch, list, and write files on paired nodes via dedicated node commands. Bypasses bash stdout truncation by using base64 over node.invoke for binaries up to 16 MB. |
| `geolocation`   | disabled (was on) | Resolves client IP addresses to a coarse city using a locally cached IP-geolocation database.                                                                        |
| `linux-node`    | disabled (was on) | Desktop notifications, camera capture, and location for Linux node hosts.                                                                                            |
| `logbook`       | off (default)     | Automatic work journal: captures periodic screen snapshots from a paired node and turns them into a reviewable timeline of your day.                                 |
| `session-share` | off (default)     | Read-only OpenClaw sessions on paired gateways                                                                                                                       |

## Memory, knowledge and documents

| Plugin            | State now         | What it does                                                                                                                       |
| ----------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `active-memory`   | off (default)     | Runs bounded pre-reply memory retrieval and implements per-agent Remember across conversations for eligible private conversations. |
| `github`          | disabled (was on) | Public GitHub link previews and document reader.                                                                                   |
| `memory-core`     | **kept on**       | OpenClaw core memory search plugin                                                                                                 |
| `memory-wiki`     | off (default)     | Persistent wiki compiler and Obsidian-friendly knowledge vault for OpenClaw.                                                       |
| `web-readability` | **kept on**       | Extract readable article content from local HTML web fetch responses.                                                              |

## Developer, tools and security

| Plugin              | State now         | What it does                                                                                                    |
| ------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `admin-http-rpc`    | off (default)     | OpenClaw admin HTTP RPC endpoint                                                                                |
| `beam`              | off (default)     | Read-only coding-session Beam receiver                                                                          |
| `browser`           | **kept on**       | OpenClaw browser tool plugin                                                                                    |
| `cloudflare`        | off (default)     | Cloudflare R2 storage for named OpenClaw storage locations.                                                     |
| `code-mode-quickjs` | off (default)     | Hardened JavaScript execution for Code Mode using QuickJS in WebAssembly.                                       |
| `codex`             | **kept on**       | Codex app-server harness and native session catalog.                                                            |
| `google`            | disabled (was on) | OpenClaw Google plugin                                                                                          |
| `llm-task`          | off (default)     | Generic JSON-only LLM tool for structured tasks callable from workflows.                                        |
| `migrate-claude`    | off (default)     | Imports Claude Code and Claude Desktop instructions, MCP servers, skills, and safe configuration into OpenClaw. |
| `migrate-hermes`    | off (default)     | Imports Hermes configuration, memories, skills, and supported credentials into OpenClaw.                        |
| `oc-path`           | off (default)     | Adds the openclaw path CLI for oc:// workspace file addressing.                                                 |
| `onepassword`       | off (default)     | 1Password SecretRef resolver and curated agent broker with approval policy and SQLite audit history.            |
| `policy`            | off (default)     | Adds policy-backed doctor checks for workspace conformance.                                                     |
| `workboard`         | off (default)     | Dashboard workboard for agent-owned issues and sessions.                                                        |
